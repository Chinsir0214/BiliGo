const defaultHttps = require('https');
const zlib = require('zlib');
const { TextDecoder } = require('util');
const { identifyVideo, requestedVideoPage, fetchVideoInfo, videoPages, selectVideoPage } = require('../resource/video-info');

const DEFAULT_MAX_TEXT_BYTES = 20 * 1024 * 1024;

function createDanmakuDownloader({ requestJson, cookieHeader, fs, path, safeName, httpsClient = defaultHttps, maxTextBytes = DEFAULT_MAX_TEXT_BYTES }) {
  const https = httpsClient;
  const MAX_TEXT_BYTES = maxTextBytes;

  function requestText(url, options = {}) {
    return new Promise((resolve, reject) => {
      let finished = false;
      const fail = error => { if (!finished) { finished = true; reject(error); } };
      const succeed = value => { if (!finished) { finished = true; resolve(value); } };
      const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'gzip, deflate', ...(options.headers || {}) } }, res => {
        const chunks = [];
        let size = 0;
        res.on('data', chunk => {
          if (finished) return;
          size += chunk.length;
          if (size > MAX_TEXT_BYTES) {
            fail(new Error('弹幕响应压缩体过大'));
            req.destroy();
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (finished) return;
          if (res.statusCode !== 200) return fail(new Error(`请求失败（HTTP ${res.statusCode}）`));
          try {
            const encoding = String(res.headers['content-encoding'] || 'identity').trim().toLowerCase();
            const body = Buffer.concat(chunks);
            let decoded;
            if (encoding === 'identity' || !encoding) decoded = body;
            else if (encoding === 'gzip') decoded = zlib.gunzipSync(body, { maxOutputLength: MAX_TEXT_BYTES });
            else if (encoding === 'deflate') {
              try { decoded = zlib.inflateSync(body, { maxOutputLength: MAX_TEXT_BYTES }); }
              catch (error) {
                if (error.code === 'ERR_BUFFER_TOO_LARGE') throw error;
                decoded = zlib.inflateRawSync(body, { maxOutputLength: MAX_TEXT_BYTES });
              }
            } else throw new Error(`不支持的弹幕响应压缩格式：${encoding}`);
            if (decoded.length > MAX_TEXT_BYTES) throw new Error('弹幕响应解压后过大');
            succeed(new TextDecoder('utf-8', { fatal: true }).decode(decoded));
          } catch (error) {
            fail(error.code === 'ERR_BUFFER_TOO_LARGE' ? new Error('弹幕响应解压后过大') : new Error(`弹幕响应解码失败：${error.message}`));
          }
        });
        res.on('error', fail);
        res.on('aborted', () => fail(new Error('弹幕响应传输中断')));
      });
      req.on('error', fail); req.setTimeout(10000, () => req.destroy(new Error('请求超时')));
    });
  }
  function validateDanmakuXml(xml) {
    const source = xml.replace(/^\uFEFF/, '');
    let pos = 0;
    const stack = [];
    let rootClosed = false;
    const invalid = () => { throw new Error('弹幕响应不是有效 XML'); };
    const name = '[A-Za-z_][\\w:.-]*';
    const closingTag = new RegExp(`<\/(${name})\\s*>`, 'y');
    const openingTag = new RegExp(`<(${name})((?:\\s+${name}\\s*=\\s*(?:"[^"<]*"|'[^'<]*'))*)\\s*(\\/?)>`, 'y');
    const attribute = new RegExp(`\\s+(${name})\\s*=\\s*(?:"([^"<]*)"|'([^'<]*)')`, 'y');
    const entity = /&(?:amp|lt|gt|quot|apos|#([0-9]+)|#x([0-9a-f]+));/iy;
    const validEntities = value => {
      for (let amp = value.indexOf('&'); amp !== -1; amp = value.indexOf('&', entity.lastIndex)) {
        entity.lastIndex = amp;
        const match = entity.exec(value);
        if (!match) invalid();
        if (match[1] || match[2]) {
          const number = Number.parseInt(match[1] || match[2], match[1] ? 10 : 16);
          if (!(number === 9 || number === 10 || number === 13 || (number >= 32 && number <= 0xD7FF) || (number >= 0xE000 && number <= 0xFFFD) || (number >= 0x10000 && number <= 0x10FFFF))) invalid();
        }
      }
    };
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/.test(source)) invalid();
    if (source.startsWith('<?xml')) {
      const declaration = /^<\?xml\s+version\s*=\s*(?:"1\.[01]"|'1\.[01]')(?:\s+encoding\s*=\s*(?:"UTF-8"|'UTF-8'))?(?:\s+standalone\s*=\s*(?:"(?:yes|no)"|'(?:yes|no)'))?\s*\?>/.exec(source);
      if (!declaration) invalid();
      pos = declaration[0].length;
    }
    while (pos < source.length) {
      if (source[pos] !== '<') {
        const end = source.indexOf('<', pos);
        const text = source.slice(pos, end === -1 ? source.length : end);
        if ((!stack.length && text.trim()) || text.includes(']]>')) invalid();
        validEntities(text);
        pos = end === -1 ? source.length : end;
        continue;
      }
      if (source.startsWith('<!--', pos)) {
        const end = source.indexOf('-->', pos + 4);
        if (end === -1) invalid();
        const comment = source.slice(pos + 4, end);
        if (comment.includes('--') || comment.includes('<!--') || comment.endsWith('-')) invalid();
        pos = end + 3;
        continue;
      }
      if (source.startsWith('<![CDATA[', pos)) {
        const end = source.indexOf(']]>', pos + 9);
        if (!stack.length || end === -1) invalid();
        pos = end + 3;
        continue;
      }
      closingTag.lastIndex = pos;
      const closing = closingTag.exec(source);
      if (closing) {
        if (stack.pop() !== closing[1]) invalid();
        if (!stack.length) rootClosed = true;
        pos = closingTag.lastIndex;
        continue;
      }
      openingTag.lastIndex = pos;
      const opening = openingTag.exec(source);
      if (!opening || rootClosed || (!stack.length && opening[1] !== 'i')) invalid();
      const seenAttributes = new Set();
      for (let offset = 0; offset < opening[2].length; offset = attribute.lastIndex) {
        attribute.lastIndex = offset;
        const match = attribute.exec(opening[2]);
        if (!match || seenAttributes.has(match[1])) invalid();
        seenAttributes.add(match[1]);
        validEntities(match[2] === undefined ? match[3] : match[2]);
      }
      if (!opening[3]) stack.push(opening[1]);
      else if (!stack.length) rootClosed = true;
      pos = openingTag.lastIndex;
    }
    if (!rootClosed || stack.length) invalid();
    return source;
  }
  async function downloadDanmaku(url, title, destination) {
    const video = identifyVideo(url);
    if (!video) throw new Error('无法从链接中识别视频编号');
    const pageNumber = requestedVideoPage(url) ?? 1;
    const data = await fetchVideoInfo(video, { requestJson, cookieHeader });
    const { cid } = selectVideoPage(videoPages(data), pageNumber);
    if (!cid) throw new Error(`无法获取视频第 ${pageNumber} P 弹幕`);
    const xml = validateDanmakuXml(await requestText(`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`, { headers: { Cookie: cookieHeader() } }));
    const suffix = video.bvid || `av${video.aid}`;
    const file = path.join(destination, `${safeName(title)} [${suffix}].xml`);
    fs.writeFileSync(file, xml, 'utf8');
    return file;
  }
  return { requestText, validateDanmakuXml, downloadDanmaku };
}

module.exports = { createDanmakuDownloader };
