const https = require('node:https');

const COOKIE_NAMES = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5'];

function loginUrl(value, base) {
  let url;
  try { url = new URL(value, base); } catch (_) { throw new Error('登录票据链接无效'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password ||
      !(host === 'bilibili.com' || host.endsWith('.bilibili.com') || host === 'biligame.com' || host.endsWith('.biligame.com'))) {
    throw new Error('登录票据链接不安全');
  }
  return url;
}

function queryCookies(url) {
  return COOKIE_NAMES.filter(name => url.searchParams.has(name))
    .map(name => `${name}=${url.searchParams.get(name)}; Domain=.bilibili.com; Path=/`);
}

function responseCookies(headers, host) {
  const values = headers?.['set-cookie'] || [];
  return values.flatMap(cookie => {
    const domain = cookie.match(/(?:^|;)\s*domain=([^;]+)/i)?.[1]?.trim().replace(/^\./, '').toLowerCase() || host;
    if (domain !== 'bilibili.com' && !domain.endsWith('.bilibili.com')) return [];
    return [cookie.includes('Domain=') || /;\s*domain=/i.test(cookie)
      ? cookie
      : `${cookie}; Domain=.bilibili.com`];
  });
}

function getHeaders(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Referer: 'https://www.bilibili.com/' } }, res => {
      res.resume();
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('登录票据请求超时')));
  });
}

async function resolveLoginCookies(value, fetchHeaders = getHeaders) {
  let url = loginUrl(value);
  const cookies = queryCookies(url);
  if (cookies.some(cookie => cookie.startsWith('SESSDATA='))) return cookies;
  for (let redirect = 0; redirect < 6; redirect += 1) {
    const response = await fetchHeaders(url);
    cookies.push(...responseCookies(response.headers, url.hostname.toLowerCase()));
    if (cookies.some(cookie => cookie.startsWith('SESSDATA='))) return cookies;
    const location = response.headers?.location;
    if (![301, 302, 303, 307, 308].includes(response.statusCode) || !location) break;
    url = loginUrl(location, url);
    cookies.push(...queryCookies(url));
    if (cookies.some(cookie => cookie.startsWith('SESSDATA='))) return cookies;
  }
  return cookies;
}

module.exports = { resolveLoginCookies };
