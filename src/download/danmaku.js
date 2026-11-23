const defaultHttps = require('node:https');
const { identifyVideo, requestedVideoPage, fetchVideoInfo, videoPages, selectVideoPage } = require('../resource/video-info');

const DEFAULT_MAX_TEXT_BYTES = 20 * 1024 * 1024;

function createDanmakuDownloader({ requestJson, cookieHeader, fs, path, safeName, httpsClient = defaultHttps, maxTextBytes = DEFAULT_MAX_TEXT_BYTES }) {
  let workerPool;

  function requestBody(url, signal) {
    return new Promise((resolve, reject) => {
      const req = httpsClient.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'gzip, deflate', Cookie: cookieHeader() },
        signal
      }, res => {
        const chunks = [];
        let size = 0;
        let failed = false;
        const fail = error => { failed = true; reject(error); };
        res.on('data', chunk => {
          if (failed) return;
          size += chunk.length;
          if (size > maxTextBytes) {
            fail(new Error('弹幕响应压缩体过大'));
            req.destroy();
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (failed) return;
          if (res.statusCode !== 200) return fail(new Error(`请求失败（HTTP ${res.statusCode}）`));
          // Network chunks may share Node's buffer pool. Transfer only our own allocation.
          const body = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.length;
          }
          const encoding = String(res.headers['content-encoding'] || 'identity').trim().toLowerCase();
          resolve({ body: body.buffer, encoding });
        });
        res.on('error', fail);
        res.on('aborted', () => fail(new Error('弹幕响应传输中断')));
      });
      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(new Error('请求超时')));
    });
  }

  async function downloadDanmaku(url, title, destination, signal) {
    signal?.throwIfAborted();
    const video = identifyVideo(url);
    if (!video) throw new Error('无法从链接中识别视频编号');
    const pageNumber = requestedVideoPage(url) ?? 1;
    const metadataRequest = signal ? (url, options) => requestJson(url, { ...options, signal }) : requestJson;
    const data = await fetchVideoInfo(video, { requestJson: metadataRequest, cookieHeader });
    signal?.throwIfAborted();
    const { cid } = selectVideoPage(videoPages(data), pageNumber);
    if (!cid) throw new Error(`无法获取视频第 ${pageNumber} P 弹幕`);
    const { body, encoding } = await requestBody(`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`, signal);
    workerPool ??= require('./danmaku-pool').createDanmakuWorkerPool();
    const bytes = await workerPool.decode(body, encoding, maxTextBytes, signal);
    signal?.throwIfAborted();
    const suffix = video.bvid || `av${video.aid}`;
    const file = path.join(destination, `${safeName(title)} [${suffix}].xml`);
    await fs.promises.writeFile(file, bytes, { signal });
    return file;
  }
  return { downloadDanmaku };
}

module.exports = { createDanmakuDownloader };
