const { isMarkedAsUntransferable, parentPort } = require('node:worker_threads');
const zlib = require('node:zlib');

function decodeBody(body, encoding, maxBytes) {
  try {
    const limits = { maxOutputLength: maxBytes };
    if (encoding === 'gzip') return zlib.gunzipSync(body, limits);
    if (encoding === 'deflate') {
      try { return zlib.inflateSync(body, limits); }
      catch (error) {
        if (error.code === 'ERR_BUFFER_TOO_LARGE') throw error;
        return zlib.inflateRawSync(body, limits);
      }
    }
    if (encoding === 'identity' || !encoding) return body;
    throw new Error(`不支持的弹幕响应压缩格式：${encoding}`);
  } catch (error) {
    if (error.code === 'ERR_BUFFER_TOO_LARGE') throw new Error('弹幕响应解压后过大');
    throw new Error(`弹幕响应解码失败：${error.message}`);
  }
}

function validateDanmakuXml(source) {
  let pos = 0;
  const stack = [];
  let rootClosed = false;
  const invalid = () => { throw new Error('弹幕响应不是有效 XML'); };
  const name = '[A-Za-z_][\\w:.-]*';
  const closingTag = new RegExp(`<\/(${name})\\s*>`, 'y');
  const openingTag = new RegExp(`<(${name})((?:\\s+${name}\\s*=\\s*(?:"[^"<]*"|'[^'<]*'))*)\\s*(\\/?)>`, 'y');
  const attribute = new RegExp(`\\s+(${name})\\s*=\\s*(?:"([^"<]*)"|'([^'<]*)')`, 'y');
  const entity = /&(?:amp|lt|gt|quot|apos|#([0-9]+)|#x([0-9a-fA-F]+));/y;
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
    const declaration = /^<\?xml\s+version\s*=\s*(?:"1\.[01]"|'1\.[01]')(?:\s+encoding\s*=\s*(?:"[Uu][Tt][Ff]-8"|'[Uu][Tt][Ff]-8'))?(?:\s+standalone\s*=\s*(?:"(?:yes|no)"|'(?:yes|no)'))?\s*\?>/.exec(source);
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
      if (comment.includes('--') || comment.endsWith('-')) invalid();
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
}

function decodeMessage({ body, encoding, maxBytes }) {
  const decoded = decodeBody(new Uint8Array(body), encoding, maxBytes);
  if (decoded.byteLength > maxBytes) throw new Error('弹幕响应解压后过大');
  // The original decoder consumed a UTF-8 BOM, then the XML validator stripped a second one.
  let offset = 0;
  while (offset < 6 && decoded[offset] === 0xef && decoded[offset + 1] === 0xbb && decoded[offset + 2] === 0xbf) offset += 3;
  let bytes = decoded.subarray(offset);
  let xml;
  try { xml = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch (error) { throw new Error(`弹幕响应解码失败：${error.message}`); }
  validateDanmakuXml(xml);
  // Small zlib results can share a larger buffer. Only transfer storage owned by this response.
  if (bytes.byteOffset || bytes.byteLength !== bytes.buffer.byteLength || isMarkedAsUntransferable(bytes.buffer)) {
    bytes = new Uint8Array(bytes);
  }
  return bytes;
}

parentPort.on('message', input => {
  try {
    const bytes = decodeMessage(input);
    parentPort.postMessage({ ok: true, bytes }, [bytes.buffer]);
  } catch (error) {
    parentPort.postMessage({ ok: false, message: error.message });
  }
});
