const { requestHeaders } = require('../infra/http-client');

const COOKIE_NAMES = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5'];
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const clean = value => value.replace(/[\r\n\t;]/g, '').trim();
const isBiliDomain = host => host === 'bilibili.com' || host.endsWith('.bilibili.com');

function loginUrl(value, base) {
  let url;
  try { url = new URL(value, base); } catch { throw new Error('登录票据链接无效'); }
  const host = url.hostname;
  if (url.protocol !== 'https:' || url.username || url.password ||
      !(isBiliDomain(host) || host === 'biligame.com' || host.endsWith('.biligame.com'))) {
    throw new Error('登录票据链接不安全');
  }
  return url;
}

function parseSetCookie(raw, host = 'passport.bilibili.com', now = Date.now()) {
  if (typeof raw !== 'string') return null;
  const [pair, ...segments] = raw.split(';');
  const split = pair.indexOf('=');
  if (split < 1) return null;
  const name = clean(pair.slice(0, split));
  const value = clean(pair.slice(split + 1));
  if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || !value) return null;
  const attributes = new Map(segments.map(segment => {
    const [key, ...parts] = segment.split('=');
    return [key.trim().toLowerCase(), clean(parts.join('='))];
  }));
  const domain = (attributes.get('domain') || host).replace(/^\./, '').toLowerCase();
  if (!isBiliDomain(domain) || (domain !== host && !host.endsWith('.' + domain))) return null;
  const path = attributes.get('path') || '/';
  if (!path.startsWith('/')) return null;
  let expiry = Math.floor(Date.parse(attributes.get('expires')) / 1000);
  const age = attributes.get('max-age');
  if (/^-?\d+$/.test(age)) {
    if (Number(age) <= 0) return null;
    expiry = Math.min(253402300799, Math.floor(now / 1000) + Number(age));
  }
  if (Number.isNaN(expiry)) expiry = 0;
  else if (expiry <= Math.floor(now / 1000)) return null;
  return { domain, subdomains: attributes.has('domain'), path, secure: attributes.has('secure'), expiry, name, value };
}

function uniqueCookies(cookies) {
  const result = new Map();
  for (const cookie of cookies.filter(Boolean)) {
    result.set(JSON.stringify([cookie.domain, cookie.path, cookie.name]), cookie);
  }
  return [...result.values()];
}

function queryCookies(url) {
  return COOKIE_NAMES.filter(name => url.searchParams.has(name))
    .map(name => `${name}=${clean(url.searchParams.get(name))}; Domain=.bilibili.com; Path=/; Secure`)
    .filter(raw => parseSetCookie(raw));
}

function responseCookies(headers, host) {
  const values = [].concat(headers?.['set-cookie'] || []);
  return values.filter(value => parseSetCookie(value, host)).map(value => {
    // Preserve the origin of host-only cookies across the ticket exchange.
    return /;\s*domain\s*=/i.test(value) ? value : { raw: value, host };
  });
}

const hasSession = cookies => cookies.some(item => parseSetCookie(item.raw || item, item.host)?.name === 'SESSDATA');

async function resolveLoginCookies(value, fetchHeaders = requestHeaders, { signal } = {}) {
  let url = loginUrl(value);
  const cookies = queryCookies(url);
  if (hasSession(cookies)) return cookies;
  for (let hop = 0; hop <= 5; hop++) {
    signal?.throwIfAborted();
    const { statusCode, headers } = await fetchHeaders(url, { Referer: 'https://www.bilibili.com/' }, { signal, allowRedirect: true });
    if (REDIRECTS.has(statusCode)) {
      if (!headers?.location || hop === 5) throw new Error('登录票据重定向异常');
      const next = loginUrl(headers.location, url);
      cookies.push(...responseCookies(headers, url.hostname), ...queryCookies(next));
      url = next;
      continue;
    }
    if (!(statusCode >= 200 && statusCode < 300)) throw new Error(`登录票据请求失败 HTTP ${statusCode}`);
    cookies.push(...responseCookies(headers, url.hostname));
    return cookies;
  }
}

module.exports = { resolveLoginCookies, parseSetCookie, uniqueCookies, isBiliDomain };
