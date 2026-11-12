const { StringDecoder } = require('node:string_decoder');
const { identifyVideo, requestedVideoPage, fetchVideoInfo, videoPages, selectVideoPage } = require('./video-info');

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

function subtitleLanguages(value) {
  if (Array.isArray(value)) return value.map(item => {
    const language = String(item.lan || item.lang || item.language || '');
    const name = String(item.lan_doc || item.name || language);
    return { value: `${language}:${item.ai_type ? 'ai' : 'normal'}`, label: `${name}${item.ai_type ? 'AI字幕' : '字幕'}` };
  }).filter(item => item.value);
  return Object.keys(value || {}).map(key => ({ value: key, label: key })).filter(item => item.value);
}

function favoriteItem(item, index, page) {
  const bvid = item?.bvid || item?.bv_id || '';
  const title = item?.title || '';
  const unavailable = !bvid;
  const duration = typeof item?.duration === 'string'
    ? item.duration.split(':').reduce((total, part) => total * 60 + Number(part || 0), 0)
    : Number(item?.duration) || 0;
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
  requestJson,
  cookieHeader,
  playerSubtitleLanguages,
  assertBilibiliUrl,
  pushCookieArgs,
  spawn,
  resolveYtdlp,
  log = () => {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES
}) {
  async function parseFavoritePage(favoriteId, page) {
    const id = String(favoriteId);
    const pageNumber = Number(page);
    if (!/^\d+$/.test(id)) throw new Error('收藏夹 ID 无效');
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > MAX_FAVORITE_PAGES) throw new Error('收藏夹页码无效');
    const result = await requestJson(`https://api.bilibili.com/x/v3/fav/resource/list?media_id=${id}&ps=${FAVORITE_PAGE_SIZE}&pn=${pageNumber}&platform=web`, {
      headers: { Cookie: cookieHeader(), Referer: 'https://space.bilibili.com/' }
    });
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

  function parseWithYtdlp(url) {
    return new Promise((resolve, reject) => {
      const args = ['--dump-single-json', '--skip-download', '--flat-playlist', '--no-warnings', '--socket-timeout', '15'];
      pushCookieArgs(args);
      args.push(url);
      let child;
      try { child = spawn(resolveYtdlp(), args, { windowsHide: true }); }
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
        if (error) reject(error);
        else resolve(value);
      }
      function stop(error) {
        if (settled) return;
        settle(error);
        try { child.kill(); } catch (_) {}
      }
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
          settle(new Error(errorOutput.split(/\r?\n/).filter(Boolean).pop() || '无法读取视频信息'));
          return;
        }
        try {
          const info = JSON.parse(output);
          const entries = (Array.isArray(info.entries) ? info.entries : []).filter(Boolean);
          const resourceType = /favlist|favorite/i.test(url) ? 'favorite' : /collection|medialist|series|[?&]sid=\d+/i.test(url) ? 'collection' : entries.length > 1 ? 'parts' : 'video';
          const items = entries.length ? entries.map((item, index) => ({
            id: item.id || `${index}`,
            title: item.title || item.fulltitle || `第 ${index + 1} 集`,
            url: item.webpage_url || item.original_url || (resourceType === 'parts' ? videoPageUrl(url, index + 1) : item.id ? `https://www.bilibili.com/video/${item.id}` : url),
            thumbnail: item.thumbnail || '',
            duration: item.duration || 0,
            subtitleLanguages: subtitleLanguages(item.subtitles)
          })) : [{
            id: info.id || 'video',
            title: info.title || info.fulltitle || '未命名视频',
            url: info.webpage_url || url,
            thumbnail: info.thumbnail || '',
            duration: info.duration || 0,
            subtitleLanguages: subtitleLanguages(info.subtitles)
          }];
          settle(null, { title: info.playlist_title || info.title || items[0].title, thumbnail: info.thumbnail || items[0].thumbnail || '', type: resourceType, items });
        } catch (_) { settle(new Error('视频信息解析失败')); }
      });
      timer = setTimeout(() => stop(new Error('解析超时，请检查链接或登录状态')), timeoutMs);
    });
  }

  async function* medialistPages(type, id) {
    let oid = '';
    const seenCursors = new Set();
    for (let page = 0; page < 100; page += 1) {
      const query = new URLSearchParams({ type: String(type), biz_id: id, ps: '100', direction: 'false' });
      if (oid) query.set('oid', oid);
      const response = await requestJson(`https://api.bilibili.com/x/v2/medialist/resource/list?${query}`, {
        headers: { Cookie: cookieHeader(), Referer: 'https://www.bilibili.com/' }
      });
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

  async function enrichCollection(url, resource) {
    const parsed = new URL(url);
    const business = parsed.searchParams.get('business');
    const type = business === 'space_collection' ? 8 : business === 'space_series' || parsed.searchParams.has('sid') ? 5 : null;
    const id = parsed.searchParams.get('business_id') || parsed.searchParams.get('sid');
    if (resource.type !== 'collection' || !type || !/^\d+$/.test(id || '')) return resource;

    try {
      const details = new Map();
      if (resource.items.length) {
        for await (const pageItems of medialistPages(type, id)) {
          for (const item of pageItems) if (item.bv_id) details.set(item.bv_id, item);
          if (details.size >= resource.items.length) break;
        }
      }
      resource.items = resource.items.map(item => {
        const bvid = identifyVideo(item.url)?.bvid || item.id;
        const detail = details.get(bvid);
        return detail ? { ...item, title: detail.title || item.title, duration: Number(detail.duration) || item.duration, thumbnail: detail.cover || item.thumbnail } : item;
      });
      resource.thumbnail ||= resource.items.find(item => item.thumbnail)?.thumbnail || '';
    } catch (error) {
      log('error', `合集条目补全失败: ${error.message}`);
    }
    return resource;
  }

  async function parseSeriesCollection(url) {
    const parsed = new URL(url);
    const business = parsed.searchParams.get('business');
    const seriesId = business === 'space_series'
      ? parsed.searchParams.get('business_id')
      : /^\/list\/\d+/.test(parsed.pathname) ? parsed.searchParams.get('sid') : null;
    if (!/^\d+$/.test(seriesId || '')) return null;

    try {
      let title = '合集';
      try {
        const info = await requestJson(`https://api.bilibili.com/x/series/series?series_id=${seriesId}`, {
          headers: { Cookie: cookieHeader(), Referer: 'https://www.bilibili.com/' }
        });
        if (info.code === 0) title = info.data?.meta?.name || title;
      } catch (_) { /* A missing title does not prevent loading the entries. */ }

      const items = [];
      const seen = new Set();
      for await (const pageItems of medialistPages(5, seriesId)) {
        for (const item of pageItems) {
          if (!item.bv_id || seen.has(item.bv_id)) continue;
          seen.add(item.bv_id);
          items.push({
            id: item.bv_id,
            title: item.title || `第 ${items.length + 1} 集`,
            url: `https://www.bilibili.com/video/${item.bv_id}`,
            thumbnail: item.cover || '',
            duration: Number(item.duration) || 0,
            subtitleLanguages: []
          });
        }
      }
      if (!items.length) throw new Error('合集没有可用条目');
      return { title, thumbnail: items[0].thumbnail, type: 'collection', items };
    } catch (error) {
      log('error', `合集接口解析失败 ${seriesId}: ${error.message}`);
      if (error instanceof CollectionPaginationError) throw error;
      return null;
    }
  }

  async function parseResource(inputUrl) {
    const url = assertBilibiliUrl(inputUrl);
    const favoriteId = url.match(/[?&]fid=(\d+)/i)?.[1];
    if (favoriteId) {
      try {
        let favorite = await parseFavoritePage(favoriteId, 1);
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
          const batch = Array.from({ length: batchSize }, (_, index) => parseFavoritePage(favoriteId, page + index + 1)
            .then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason })));
          const previousCount = items.length;
          for (const pending of batch) {
            const result = await pending;
            if (result.status === 'rejected') throw result.reason;
            favorite = result.value;
            appendPage(favorite);
            page += 1;
            if (!favorite.hasMore) break;
          }
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
    const series = await parseSeriesCollection(url);
    if (series) return series;
    const video = identifyVideo(url);
    const isCollectionUrl = /collection|medialist|series/i.test(url);
    if (video && !isCollectionUrl) {
      const requestedPage = requestedVideoPage(url);
      const videoId = video.bvid || `av${video.aid}`;
      let data;
      try {
        data = await fetchVideoInfo(video, { requestJson, cookieHeader });
      } catch (error) {
        log('error', `视频接口请求失败 ${videoId}: ${error.message}`);
      }
      if (data) {
        const pages = videoPages(data);
        if (requestedPage !== null) selectVideoPage(pages, requestedPage);
        const bvid = video.bvid || data.bvid;
        const type = pages.length > 1 ? 'parts' : /favlist|favorite/i.test(url) ? 'favorite' : 'video';
        const viewSubtitles = subtitleLanguages(data.subtitle?.list);
        const pageSubtitles = [];
        for (let start = 0; start < pages.length; start += PLAYER_SUBTITLE_CONCURRENCY) {
          const batch = await Promise.all(pages.slice(start, start + PLAYER_SUBTITLE_CONCURRENCY).map(async page => {
            const playerSubtitles = bvid && page.cid ? await playerSubtitleLanguages(bvid, page.cid) : [];
            return [...(page.number === 1 ? viewSubtitles : []), ...playerSubtitles]
              .filter((item, itemIndex, list) => list.findIndex(other => other.value === item.value) === itemIndex);
          }));
          pageSubtitles.push(...batch);
        }
        const items = data.pages?.length ? pages.map((page, index) => ({
          id: String(page.cid || index),
          title: page.part || `第 ${page.number} 集`,
          url: `https://www.bilibili.com/video/${videoId}?p=${page.number}`,
          thumbnail: '',
          duration: page.duration || 0,
          subtitleLanguages: pageSubtitles[index]
        })) : [{
          id: bvid || videoId,
          title: data.title || '未命名视频',
          url,
          thumbnail: data.pic || '',
          duration: data.duration || 0,
          subtitleLanguages: pageSubtitles[0]
        }];
        return { title: data.title || items[0].title, thumbnail: data.pic || '', type, items };
      }
    }
    const resource = await parseWithYtdlp(url);
    return enrichCollection(url, resource);
  }

  return { parseResource, parseFavoritePage };
}

module.exports = { createResourceParser, subtitleLanguages };
