const { StringDecoder } = require('node:string_decoder');
const { identifyVideo, requestedVideoPage, fetchVideoInfo, videoPages, selectVideoPage } = require('./video-info');
const httpClient = require('../infra/http-client');
const { killProcessTree, createYtdlpErrorExtractor } = require('../infra/process');
const security = require('../security');

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const PLAYER_SUBTITLE_CONCURRENCY = 4;
const FAVORITE_PAGE_SIZE = 20;
const FAVORITE_PAGE_CONCURRENCY = 6;
const MAX_FAVORITE_PAGES = 10_000;

class CollectionPaginationError extends Error {}

function videoPageUrl(url, pageNumber) {
  const partUrl = new URL(url);
  for (const name of [...partUrl.searchParams.keys()]) {
    if (name.toLowerCase() === 'p') partUrl.searchParams.delete(name);
  }
  partUrl.searchParams.set('p', pageNumber);
  return partUrl.toString();
}

function classifyBilibiliUrl(rawUrl) {
  const { hostname, pathname, searchParams } = new URL(rawUrl);
  if (hostname === 'b23.tv') return { type: 'short' };
  const favoriteId = searchParams.get('fid') || pathname.match(/^\/list\/ml(\d+)(?:\/|$)/i)?.[1];
  if (/^\d+$/.test(favoriteId || '')) return { type: 'favorite', favoriteId };
  const business = searchParams.get('business');
  const sid = searchParams.get('sid');
  const collectionId = searchParams.get('business_id') || sid;
  if (/^\d+$/.test(collectionId || '') && (business === 'space_series' || business === 'space_collection' ||
      (/^\/list\/\d+(?:\/|$)/.test(pathname) && sid))) {
    return { type: 'collection', collectionId, business: business === 'space_collection' ? business : 'space_series' };
  }
  if (/(?:^|\/)(?:collection|medialist|series)(?:\/|$)/i.test(pathname)) return { type: 'collection' };
  if (/(?:^|\/)(?:favlist|favorite)(?:\/|$)/i.test(pathname)) return { type: 'favorite' };
  return { type: 'video', video: identifyVideo(rawUrl) };
}

function durationSeconds(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return 0;
  const parts = String(value).trim().split(':');
  if (parts.some(part => !/^\d+(?:\.\d+)?$/.test(part))) return 0;
  const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0);
  return Number.isFinite(seconds) ? seconds : 0;
}

function subtitleLanguages(value) {
  if (!value || typeof value !== 'object') return [];
  const entries = Array.isArray(value) ? value : Object.keys(value).map(key => ({ lan: key }));
  const options = new Map();
  for (const item of entries) {
    if (!item || typeof item !== 'object') continue;
    const raw = item.lan || item.lang || item.language;
    if (typeof raw !== 'string') continue;
    const language = raw.trim();
    if (!language || language === 'danmaku') continue;
    const ai = Boolean(Number(item.ai_type)) || language.startsWith('ai-');
    const name = item.lan_doc || item.name || language;
    const id = language + (ai ? ':ai' : ':normal');
    options.set(id, { value: id, label: name + (ai ? 'AI字幕' : '字幕') });
  }
  return [...options.values()];
}

// Injected providers may ignore cancellation. Stop awaiting their results as well.
function abortable(signal, operation) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function retryTransient(signal, operation) {
  try { return await abortable(signal, operation); }
  catch (error) {
    signal.throwIfAborted();
    if (!['ETIMEDOUT', 'ECONNRESET', 'ESOCKETTIMEDOUT'].includes(error.code) &&
        error.name !== 'TimeoutError' && !/超时|timed?\s*out|timeout/i.test(error.message)) throw error;
    return abortable(signal, operation);
  }
}

function favoriteItem(item, index, page) {
  const bvid = item?.bvid || item?.bv_id || '';
  const title = item?.title || '';
  const unavailable = !bvid;
  const duration = durationSeconds(item?.duration);
  return {
    id: bvid || `unavailable-${item?.id || `${page}-${index}`}`,
    title: title || '已失效视频',
    url: unavailable ? '' : `https://www.bilibili.com/video/${bvid}`,
    thumbnail: item?.cover || '',
    duration,
    subtitleLanguages: [],
    unavailable
  };
}

function createResourceParser({
  requestJson = httpClient.requestJson,
  requestHeaders = httpClient.requestHeaders,
  cookieHeader = () => '',
  playerSubtitleLanguages,
  assertBilibiliUrl = security.assertBilibiliUrl,
  pushCookieArgs,
  spawn,
  resolveYtdlp,
  log = () => {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES
} = {}) {
  const lifetime = new AbortController();
  const stopping = new Set();
  const operationSignal = signal => signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;

  async function fetchPlayerSubtitles(bvid, cid, { signal }) {
    const url = `https://api.bilibili.com/x/player/wbi/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}`;
    const result = await requestJson(url, { headers: { Cookie: cookieHeader(url) }, signal });
    if (result.code && result.code !== 0) throw new Error(result.message || '字幕读取失败');
    return subtitleLanguages(result.data?.subtitle?.subtitles || result.data?.subtitle?.list);
  }

  async function expandShortUrl(url, signal) {
    const visited = new Set();
    while (new URL(url).hostname === 'b23.tv') {
      if (visited.has(url) || visited.size >= 5) throw new Error('短链接重定向次数过多或存在循环');
      visited.add(url);
      const { statusCode, headers } = await retryTransient(signal, () =>
        requestHeaders(url, {}, { allowRedirect: true, signal }));
      if (![301, 302, 303, 307, 308].includes(statusCode) || !headers?.location) throw new Error('短链接未返回有效跳转');
      url = assertBilibiliUrl(new URL(headers.location, url).href);
    }
    return url;
  }

  async function readFavoritePage(favoriteId, page, signal) {
    const id = String(favoriteId);
    const pageNumber = Number(page);
    if (!/^\d+$/.test(id)) throw new Error('收藏夹 ID 无效');
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > MAX_FAVORITE_PAGES) throw new Error('收藏夹页码无效');
    const result = await retryTransient(signal, () => requestJson(`https://api.bilibili.com/x/v3/fav/resource/list?media_id=${id}&ps=${FAVORITE_PAGE_SIZE}&pn=${pageNumber}&platform=web`, {
      headers: { Cookie: cookieHeader('https://api.bilibili.com/'), Referer: 'https://space.bilibili.com/' }, signal
    }));
    if (result.code !== 0) throw new Error(result.message || '无法读取收藏夹');
    const items = (result.data?.medias || []).map((item, index) => favoriteItem(item, index, pageNumber));
    const count = Number(result.data?.info?.media_count);
    return {
      title: result.data?.info?.title || '收藏夹',
      items,
      hasMore: Boolean(result.data?.has_more),
      total: Number.isSafeInteger(count) && count >= 0 ? count : 0
    };
  }

  function parseWithYtdlp(url, classification, signal) {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const args = ['--dump-single-json', '--skip-download', '--flat-playlist', '--no-warnings', '--socket-timeout', '15'];
      pushCookieArgs(args);
      args.push(url);
      let child;
      try { child = spawn(resolveYtdlp(), args, { windowsHide: true, detached: process.platform !== 'win32', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }); }
      catch (error) { reject(new Error(`解析程序启动失败：${error.message}`)); return; }

      let output = '';
      let errorOutput = '';
      let outputBytes = 0;
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      let settled = false;
      let timer;
      function settle(error, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(value);
      }
      function stop(error) {
        if (settled) return;
        settle(error);
        const stopped = killProcessTree(child);
        stopping.add(stopped);
        stopped.finally(() => stopping.delete(stopped));
      }
      function abort() { stop(signal.reason); }
      function collect(data, kind) {
        if (settled) return;
        const bytes = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data));
        outputBytes += bytes;
        if (outputBytes > maxOutputBytes) {
          stop(new Error('视频信息解析输出过大'));
          return;
        }
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
        if (kind === 'stdout') output += stdoutDecoder.write(chunk);
        else errorOutput += stderrDecoder.write(chunk);
      }

      child.stdout.on('data', data => collect(data, 'stdout'));
      child.stderr.on('data', data => collect(data, 'stderr'));
      child.stdout.on('error', error => stop(new Error(`读取解析结果失败：${error.message}`)));
      child.stderr.on('error', error => stop(new Error(`读取解析错误信息失败：${error.message}`)));
      child.on('error', error => stop(new Error(`解析程序启动失败：${error.message}`)));
      child.on('close', code => {
        if (settled) return;
        output += stdoutDecoder.end();
        errorOutput += stderrDecoder.end();
        if (code !== 0) {
          const extractor = createYtdlpErrorExtractor();
          for (const line of output.split(/\r?\n/)) extractor.push(line, 'stdout');
          const lines = errorOutput.split(/\r?\n/).filter(Boolean);
          for (const line of lines) extractor.push(line);
          settle(new Error(extractor.message() || lines.at(-1) || '无法读取视频信息'));
          return;
        }
        try {
          const info = JSON.parse(output);
          const entries = (Array.isArray(info.entries) ? info.entries : []).filter(Boolean);
          const resourceType = classification.type === 'video' && entries.length > 1 ? 'parts' : classification.type;
          const items = entries.length ? entries.map((item, index) => ({
            id: item.id || `${index}`,
            title: item.title || item.fulltitle || `第 ${index + 1} 集`,
            url: item.webpage_url || item.original_url || (resourceType === 'parts' ? videoPageUrl(url, index + 1) : item.id ? `https://www.bilibili.com/video/${item.id}` : url),
            thumbnail: item.thumbnail || '',
            duration: durationSeconds(item.duration),
            unavailable: false,
            subtitleLanguages: subtitleLanguages(item.subtitles)
          })) : [{
            id: info.id || 'video',
            title: info.title || info.fulltitle || '未命名视频',
            url: info.webpage_url || url,
            thumbnail: info.thumbnail || '',
            duration: durationSeconds(info.duration),
            unavailable: false,
            subtitleLanguages: subtitleLanguages(info.subtitles)
          }];
          settle(null, { title: info.playlist_title || info.title || items[0].title, thumbnail: info.thumbnail || items[0].thumbnail || '', type: resourceType, items });
        } catch (_) { settle(new Error('视频信息解析失败')); }
      });
      timer = setTimeout(() => stop(new Error('解析超时，请检查链接或登录状态')), timeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  async function* medialistPages(type, id, signal) {
    let oid = '';
    const seenCursors = new Set();
    for (let page = 0; page < 100; page += 1) {
      const query = new URLSearchParams({ type: String(type), biz_id: id, ps: '100', direction: 'false' });
      if (oid) query.set('oid', oid);
      const response = await retryTransient(signal, () => requestJson(`https://api.bilibili.com/x/v2/medialist/resource/list?${query}`, {
        headers: { Cookie: cookieHeader('https://api.bilibili.com/'), Referer: 'https://www.bilibili.com/' }, signal
      }));
      if (response.code !== 0 || !Array.isArray(response.data?.media_list)) throw new Error(response.message || '合集条目读取失败');
      const pageItems = response.data.media_list;
      if (!pageItems.length) {
        if (response.data.has_more) throw new CollectionPaginationError('合集分页异常：有更多内容但当前页为空');
        return;
      }
      yield pageItems;
      if (!response.data.has_more) return;
      const nextOid = String(pageItems.at(-1).id || '');
      if (!nextOid) throw new CollectionPaginationError('合集分页异常：缺少下一页游标');
      if (seenCursors.has(nextOid)) throw new CollectionPaginationError('合集分页异常：游标重复，无法确认是否已加载完整');
      seenCursors.add(nextOid);
      oid = nextOid;
    }
    throw new CollectionPaginationError('合集页数超出限制，无法确认是否已加载完整');
  }

  async function enrichCollection(classification, resource, signal) {
    const { business, collectionId: id } = classification;
    if (resource.type !== 'collection' || !id) return resource;
    const type = business === 'space_collection' ? 8 : 5;

    try {
      const details = new Map();
      if (resource.items.length) {
        for await (const pageItems of medialistPages(type, id, signal)) {
          for (const item of pageItems) if (item.bv_id) details.set(item.bv_id, item);
          if (resource.items.every(item => details.has(identifyVideo(item.url)?.bvid || item.id))) break;
        }
      }
      resource.items = resource.items.map(item => {
        const bvid = identifyVideo(item.url)?.bvid || item.id;
        const detail = details.get(bvid);
        return detail ? { ...item, title: detail.title || item.title, duration: durationSeconds(detail.duration) || item.duration, thumbnail: detail.cover || item.thumbnail } : item;
      });
      resource.thumbnail ||= resource.items.find(item => item.thumbnail)?.thumbnail || '';
    } catch (error) {
      signal.throwIfAborted();
      log('error', `合集条目补全失败: ${error.message}`);
    }
    return resource;
  }

  async function parseCollection({ business, collectionId }, url, signal) {
    if (!collectionId) return null;
    const series = business === 'space_series';
    // Legacy medialist pages provide their collection title through yt-dlp.
    if (!series && !new URL(url).searchParams.has('sid')) return null;

    try {
      let title = '合集';
      if (series) {
        try {
          const info = await retryTransient(signal, () => requestJson(`https://api.bilibili.com/x/series/series?series_id=${collectionId}`, {
            headers: { Cookie: cookieHeader('https://api.bilibili.com/'), Referer: 'https://www.bilibili.com/' }, signal
          }));
          if (info.code === 0) title = info.data?.meta?.name || title;
        } catch { signal.throwIfAborted(); }
      }

      const items = [];
      const seen = new Set();
      for await (const pageItems of medialistPages(series ? 5 : 8, collectionId, signal)) {
        for (const item of pageItems) {
          if (!item.bv_id || seen.has(item.bv_id)) continue;
          seen.add(item.bv_id);
          items.push({
            id: item.bv_id,
            title: item.title || `第 ${items.length + 1} 集`,
            url: `https://www.bilibili.com/video/${item.bv_id}`,
            thumbnail: item.cover || '',
            duration: durationSeconds(item.duration),
            unavailable: false,
            subtitleLanguages: []
          });
        }
      }
      if (!items.length) throw new Error('合集没有可用条目');
      return { title, thumbnail: items[0].thumbnail, type: 'collection', items };
    } catch (error) {
      signal.throwIfAborted();
      log('error', `合集接口解析失败 ${collectionId}: ${error.message}`);
      if (error instanceof CollectionPaginationError) throw error;
      return null;
    }
  }

  async function subtitlesForPages(bvid, pages, viewSubtitles, signal) {
    const local = new AbortController();
    const lookupSignal = AbortSignal.any([signal, local.signal]);
    const subtitles = pages.map(page => page.number === 1 ? [...viewSubtitles] : []);
    const lookup = playerSubtitleLanguages || fetchPlayerSubtitles;
    let failures = 0;
    try {
      for (let start = 0; start < pages.length && !local.signal.aborted; start += PLAYER_SUBTITLE_CONCURRENCY) {
        signal.throwIfAborted();
        await Promise.all(pages.slice(start, start + PLAYER_SUBTITLE_CONCURRENCY).map(async (page, offset) => {
          if (!bvid || !page.cid) return;
          try {
            const found = await retryTransient(lookupSignal, () => lookup(bvid, page.cid, { signal: lookupSignal }));
            const options = [...subtitles[start + offset], ...found];
            subtitles[start + offset] = [...new Map(options.map(option => [option.value, option])).values()];
            failures = 0;
          } catch (error) {
            signal.throwIfAborted();
            if (!local.signal.aborted && ++failures >= 3) {
              log('warn', `字幕查询连续失败，已停止后续查询: ${error.message}`);
              local.abort();
            }
          }
        }));
      }
      signal.throwIfAborted();
      return subtitles;
    } finally { local.abort(); }
  }

  async function parseResource(inputUrl, { signal: callerSignal } = {}) {
    const signal = operationSignal(callerSignal);
    signal.throwIfAborted();
    const url = await expandShortUrl(assertBilibiliUrl(inputUrl), signal);
    const classification = classifyBilibiliUrl(url);
    const { favoriteId } = classification;
    if (favoriteId) {
      try {
        let favorite = await readFavoritePage(favoriteId, 1, signal);
        const title = favorite.title;
        const items = [];
        const seen = new Set();
        let total = favorite.total;
        let page = 1;
        function appendPage(result) {
          if (result.hasMore && result.items.length === 0) throw new Error('收藏夹分页异常：有更多内容但当前页为空');
          for (const item of result.items) {
            const key = String(item.id || item.url);
            if (seen.has(key)) continue;
            seen.add(key);
            items.push(item);
          }
          total = Math.max(total, result.total);
        }
        appendPage(favorite);
        while (favorite.hasMore) {
          const expectedPages = Math.ceil(total / FAVORITE_PAGE_SIZE);
          const batchSize = Math.min(FAVORITE_PAGE_CONCURRENCY, Math.max(1, expectedPages - page));
          if (page + batchSize > MAX_FAVORITE_PAGES) throw new Error('收藏夹页数异常，无法确认是否已加载完整');
          const local = new AbortController();
          const batchSignal = AbortSignal.any([local.signal, signal]);
          const previousCount = items.length;
          try {
            const batch = Array.from({ length: batchSize }, (_, index) => readFavoritePage(favoriteId, page + index + 1, batchSignal)
              .then(value => ({ value }), error => ({ error })));
            for (const pending of batch) {
              const result = await pending;
              if (result.error) throw result.error;
              favorite = result.value;
              appendPage(favorite);
              page += 1;
              if (!favorite.hasMore) break;
            }
          } finally { local.abort(); }
          if (favorite.hasMore && items.length === previousCount) throw new Error('收藏夹分页异常：连续页面没有新条目');
        }
        return {
          title,
          thumbnail: items.find(item => item.thumbnail)?.thumbnail || '',
          type: 'favorite',
          items,
          favoriteId,
          total
        };
      } catch (error) {
        log('error', `收藏夹接口解析失败 ${favoriteId}: ${error.message}`);
        throw error;
      }
    }
    const collection = await parseCollection(classification, url, signal);
    if (collection) return collection;
    const { video } = classification;
    if (video) {
      const requestedPage = requestedVideoPage(url);
      const videoId = video.bvid || `av${video.aid}`;
      let data;
      try {
        data = await retryTransient(signal, () => fetchVideoInfo(video, {
          requestJson: (target, headers, options) => requestJson(target, { headers, ...options }), cookieHeader, signal
        }));
      } catch (error) {
        signal.throwIfAborted();
        log('error', `视频接口请求失败 ${videoId}: ${error.message}`);
      }
      if (data) {
        const pages = videoPages(data);
        if (requestedPage !== null) selectVideoPage(pages, requestedPage);
        const bvid = video.bvid || data.bvid;
        const type = pages.length > 1 ? 'parts' : 'video';
        const pageSubtitles = await subtitlesForPages(bvid, pages, subtitleLanguages(data.subtitle?.list), signal);
        const items = pages.map((page, index) => ({
          id: String(data.pages?.length ? page.cid || index : bvid || videoId),
          title: (type === 'video' && data.title) || page.part || (type === 'video' ? '未命名视频' : `第 ${page.number} 集`),
          url: data.pages?.length ? `https://www.bilibili.com/video/${videoId}?p=${page.number}` : url,
          thumbnail: type === 'video' ? data.pic || '' : '',
          duration: durationSeconds(type === 'video' ? data.duration ?? page.duration : page.duration),
          subtitleLanguages: pageSubtitles[index],
          unavailable: false
        }));
        return { title: data.title || items[0].title, thumbnail: data.pic || '', type, items };
      }
    }
    const resource = await parseWithYtdlp(url, classification, signal);
    return enrichCollection(classification, resource, signal);
  }

  function parseFavoritePage(favoriteId, page, { signal } = {}) {
    return readFavoritePage(favoriteId, page, operationSignal(signal));
  }

  async function shutdown() {
    lifetime.abort();
    await Promise.all(stopping);
  }

  return { parseResource, parseFavoritePage, shutdown };
}

module.exports = { createResourceParser, subtitleLanguages, classifyBilibiliUrl };
