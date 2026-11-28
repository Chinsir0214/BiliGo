const { createHttpClient } = require('../infra/http-client');
const { identifyVideo, requestedVideoPage, fetchVideoInfo, videoPages, selectVideoPage } = require('../resource/video-info');

const DEFAULT_MAX_TEXT_BYTES = 20 * 1024 * 1024;

function createDanmakuDownloader({
  httpsClient, httpClient = createHttpClient({ httpsGet: httpsClient?.get.bind(httpsClient) }),
  requestJson = httpClient.requestJson, cookieHeader, fs, path, safeName, maxTextBytes = DEFAULT_MAX_TEXT_BYTES
}) {
  const lifetime = new AbortController();
  const active = new Set();
  let workerPool;
  let closing;

  async function download(url, title, destination, signal) {
    signal.throwIfAborted();
    const video = identifyVideo(url);
    if (!video) throw new Error('无法从链接中识别视频编号');
    const pageNumber = requestedVideoPage(url) ?? 1;
    const data = await fetchVideoInfo(video, { requestJson, cookieHeader, signal });
    signal.throwIfAborted();
    const pages = videoPages(data);
    const { cid } = selectVideoPage(pages, pageNumber);
    if (!cid) throw new Error(`无法获取视频第 ${pageNumber} P 弹幕`);

    const endpoint = `https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`;
    const headers = { 'Accept-Encoding': 'gzip, deflate' };
    const cookie = cookieHeader(endpoint);
    if (cookie) headers.Cookie = cookie;
    const { body, headers: responseHeaders } = await httpClient.requestBufferWithHeaders(endpoint, headers, {
      signal, maxBytes: maxTextBytes, acceptStatus: status => status === 200
    });
    signal.throwIfAborted();
    const encoding = String(responseHeaders['content-encoding'] || 'identity').trim().toLowerCase();
    workerPool ??= require('./danmaku-pool').createDanmakuWorkerPool();
    // Network buffers can share an allocation with other responses.
    const bytes = await workerPool.decode(new Uint8Array(body).buffer, encoding, maxTextBytes, signal);
    signal.throwIfAborted();
    const suffix = video.bvid || `av${video.aid}`;
    const part = pages.length > 1 ? `_P${pageNumber}` : '';
    const file = path.join(destination, `${safeName(title)} [${suffix}]${part}.xml`);
    await fs.promises.writeFile(file, bytes, { signal });
    return file;
  }

  function downloadDanmaku(url, title, destination, signal) {
    const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const work = download(url, title, destination, combined);
    active.add(work);
    return work.finally(() => active.delete(work));
  }

  function shutdown() {
    lifetime.abort();
    closing ??= Promise.allSettled([...active, workerPool?.shutdown()]);
    return closing;
  }

  return { downloadDanmaku, shutdown };
}

module.exports = { createDanmakuDownloader };
