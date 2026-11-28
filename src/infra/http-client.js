const https = require('node:https');

const DESKTOP_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';
const redirects = new Set([301, 302, 303, 307, 308]);

function createHttpClient({ httpsGet = https.get, timeoutMs: defaultTimeout = 10000 } = {}) {
  function fetchResponse(url, headers, options, headersOnly) {
    // Older callers use the Node-style { headers, signal } options object.
    if (!options && headers && ('headers' in headers || 'signal' in headers)) {
      options = headers;
      headers = options.headers;
    }
    const { signal, timeoutMs = defaultTimeout, maxBytes = 32 * 1024 * 1024,
      allowRedirect = false, acceptStatus = status => status >= 200 && status < 300 } = options || {};

    return new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      let request;
      let settled = false;
      function settle(error, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(value);
      }
      function stop(error) {
        settle(error);
        request?.destroy(error);
      }
      function abort() { stop(signal.reason); }

      const timer = setTimeout(() => stop(Object.assign(new Error('请求超时'), { code: 'ETIMEDOUT' })), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      try {
        request = httpsGet(url, { headers: { 'User-Agent': DESKTOP_USER_AGENT, ...headers }, signal }, response => {
          const { statusCode, headers: responseHeaders } = response;
          const meta = { statusCode, headers: responseHeaders };
          response.on('error', settle);
          const incomplete = () => settle(Object.assign(new Error('响应传输中断'), { code: 'ECONNRESET' }));
          response.on('aborted', incomplete);
          response.on('close', () => { if (!response.complete) incomplete(); });
          if (!acceptStatus(statusCode) && !(headersOnly && allowRedirect && redirects.has(statusCode))) {
            response.resume?.();
            const error = Object.assign(new Error(`请求失败（HTTP ${statusCode}）`), { statusCode });
            settle(error);
            response.destroy?.();
            return;
          }
          if (headersOnly) {
            response.resume?.();
            settle(null, meta);
            response.destroy?.();
            return;
          }
          const chunks = [];
          let size = 0;
          response.on('data', chunk => {
            if (settled) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.length;
            if (size > maxBytes) {
              stop(new Error('响应体过大'));
              response.destroy?.();
            } else chunks.push(bytes);
          });
          response.on('end', () => {
            if (response.complete === false) incomplete();
            else if (!settled) settle(null, { ...meta, body: Buffer.concat(chunks, size) });
          });
        });
        request.on('error', settle);
      } catch (error) { settle(error); }
    });
  }

  const requestBufferWithHeaders = (url, headers, options) => fetchResponse(url, headers, options, false);
  const requestHeaders = (url, headers, options) => fetchResponse(url, headers, options, true);
  async function requestJsonWithHeaders(url, headers, options) {
    const { body, ...meta } = await requestBufferWithHeaders(url, headers, options);
    return { ...meta, data: JSON.parse(body.toString('utf8')) };
  }
  const requestJson = async (...args) => (await requestJsonWithHeaders(...args)).data;
  const requestBuffer = async (...args) => (await requestBufferWithHeaders(...args)).body;
  return { requestJson, requestJsonWithHeaders, requestBuffer, requestBufferWithHeaders, requestHeaders };
}

module.exports = { DESKTOP_USER_AGENT, createHttpClient, ...createHttpClient() };
