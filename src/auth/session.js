const fs = require('node:fs');
const crypto = require('node:crypto');
const { atomicWriteFile } = require('../infra/json-store');
const { resolveLoginCookies: exchangeTicket, parseSetCookie, uniqueCookies, isBiliDomain } = require('./login-cookies');

function optionalRead(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

function removeFile(file) {
  try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function parseNetscape(text) {
  const rows = (text || '').split(/\r?\n/).map(line => line.replace(/^#HttpOnly_/, ''))
    .filter(line => line && !line.startsWith('#'));
  const cookies = [];
  let valid = true;
  for (const line of rows) {
    const fields = line.split('\t');
    const [domain, subdomains, path, secure, expiry, name, value] = fields;
    if (fields.length !== 7 || !['TRUE', 'FALSE'].includes(subdomains) ||
        (subdomains === 'TRUE') !== domain.startsWith('.') || !['TRUE', 'FALSE'].includes(secure) ||
        !/^\d+$/.test(expiry) || !isBiliDomain(domain.replace(/^\./, '').toLowerCase()) ||
        !path.startsWith('/') || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) ||
        !value || /[;\r\n]/.test(value + path)) {
      valid = false;
      continue;
    }
    if (Number(expiry) && Number(expiry) <= Date.now() / 1000) continue;
    cookies.push({ domain: domain.replace(/^\./, '').toLowerCase(), subdomains: subdomains === 'TRUE', path,
      secure: secure === 'TRUE', expiry: Number(expiry), name, value });
  }
  return { cookies: uniqueCookies(cookies), valid };
}

function netscape(cookies) {
  return ['# Netscape HTTP Cookie File', ...cookies.map(c => [
    (c.subdomains ? '.' : '') + c.domain, c.subdomains ? 'TRUE' : 'FALSE', c.path,
    c.secure ? 'TRUE' : 'FALSE', c.expiry, c.name, c.value
  ].join('\t'))].join('\n');
}

function headerFor(cookies, url = 'https://api.bilibili.com/x/web-interface/nav') {
  const { hostname, pathname, protocol } = new URL(url);
  return cookies.filter(c => (c.domain === hostname || (c.subdomains && hostname.endsWith('.' + c.domain))) &&
    (!c.secure || protocol === 'https:') && (pathname === c.path || pathname.startsWith(c.path.endsWith('/') ? c.path : c.path + '/')))
    .sort((a, b) => b.path.length - a.path.length)
    .map(c => `${c.name}=${c.value}`).join('; ');
}

function createAuthSession({
  cookieFile, profileFile, requestJson, requestJsonWithHeaders,
  resolveLoginCookies = (url, options) => exchangeTicket(url, undefined, options),
  send, log, QRCode, pollIntervalMs = 2000, ttlMs = 180000, maxFailures = 3,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout
}) {
  let generation = 0;
  let currentSession;
  const cookieHeader = url => headerFor(parseNetscape(optionalRead(cookieFile)).cookies, url);

  function hasCookieFile() {
    const { valid, cookies } = parseNetscape(optionalRead(cookieFile));
    return valid && cookies.length > 0;
  }

  function pushCookieArgs(args) {
    if (hasCookieFile()) args.push('--cookies', cookieFile);
    return args;
  }

  const fingerprint = header => crypto.createHash('sha256').update(header).digest('hex');
  function writeProfileCache(header, profile) {
    atomicWriteFile(profileFile, JSON.stringify({ cookieFingerprint: fingerprint(header), profile }));
  }

  async function fetchProfileWithCookie(header, signal) {
    const result = await requestJson('https://api.bilibili.com/x/web-interface/nav',
      { Cookie: header, Referer: 'https://www.bilibili.com/' }, { signal });
    if (result.code === -101 || result.data?.isLogin === false) return null;
    if (result.code !== 0 || !result.data?.uname) throw new Error('登录凭据校验失败');
    return { name: result.data.uname, avatar: result.data.face || '' };
  }

  async function getProfile() {
    const header = cookieHeader();
    if (!header) return null;
    const started = generation;
    const stillCurrent = () => started === generation && header === cookieHeader();
    let profile;
    try { profile = await fetchProfileWithCookie(header); }
    catch {
      if (!stillCurrent()) return null;
      try {
        const cached = JSON.parse(optionalRead(profileFile));
        return cached?.cookieFingerprint === fingerprint(header) && cached.profile?.name ? cached.profile : null;
      } catch { return null; }
    }
    if (!stillCurrent()) return null;
    if (!profile) {
      removeFile(cookieFile);
      removeFile(profileFile);
    } else {
      try { writeProfileCache(header, profile); } catch (error) { log('warn', '用户资料缓存写入失败', error); }
    }
    return profile;
  }

  function cancelLogin() {
    generation++;
    if (currentSession) {
      const session = currentSession;
      currentSession = null;
      clearIntervalFn(session.poll);
      clearTimeoutFn(session.deadline);
      session.controller.abort(new Error('登录已取消'));
    }
    return true;
  }
  function logout() {
    cancelLogin();
    removeFile(cookieFile);
    removeFile(profileFile);
    return true;
  }

  function commitLogin(cookies, header, profile) {
    // The fingerprint makes an interrupted two-file commit safe to read.
    const oldCache = optionalRead(profileFile);
    writeProfileCache(header, profile);
    try { atomicWriteFile(cookieFile, netscape(cookies)); }
    catch (error) {
      if (oldCache === null) removeFile(profileFile);
      else atomicWriteFile(profileFile, oldCache);
      throw error;
    }
  }

  async function createLogin() {
    cancelLogin();
    const session = { controller: new AbortController(), inFlight: false, scanned: false, failures: 0 };
    currentSession = session;
    const signal = session.controller.signal;
    const active = () => currentSession === session;
    const finish = (event, payload = {}) => {
      if (active()) { cancelLogin(); send(event, payload); }
    };
    session.deadline = setTimeoutFn(() => finish('login:expired'), ttlMs);
    session.deadline?.unref?.();
    try {
      const result = await requestJson('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', {}, { signal });
      signal.throwIfAborted();
      if (result.code !== 0 || !result.data?.qrcode_key || !result.data?.url) throw new Error(result.message || '二维码生成失败');
      const qr = QRCode.create(result.data.url, { errorCorrectionLevel: 'M' });
      const pollUrl = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(result.data.qrcode_key);
      session.poll = setIntervalFn(async () => {
        if (!active() || session.inFlight) return;
        session.inFlight = true;
        let confirmed = false;
        try {
          const response = await requestJsonWithHeaders(pollUrl, {}, { signal });
          if (!active()) return;
          const poll = response.data;
          if (poll?.code !== 0) throw new Error(poll?.message || '登录轮询失败');
          const status = poll.data?.code;
          if (status === 0) {
            confirmed = true;
            let candidates = [].concat(response.headers?.['set-cookie'] || []);
            const parse = () => uniqueCookies(candidates.map(item => parseSetCookie(item?.raw || item, item?.host)));
            let cookies = parse();
            if (!cookies.some(c => c.name === 'SESSDATA') && poll.data.url) {
              candidates.push(...await resolveLoginCookies(poll.data.url, { signal }));
              cookies = parse();
            }
            if (!active()) return;
            const header = headerFor(cookies);
            if (!/(^|; )SESSDATA=/.test(header)) throw new Error('登录凭据未返回，请刷新二维码重试');
            const profile = await fetchProfileWithCookie(header, signal);
            if (!active()) return;
            if (!profile) throw new Error('登录凭据校验失败，请刷新二维码重试');
            commitLogin(cookies, header, profile);
            log('info', '用户扫码登录成功');
            finish('login:success', { cookie: true, loggedIn: true, profile });
          } else if (status === 86038) finish('login:expired');
          else if (status === 86090) {
            if (!session.scanned) send('login:scanned', {});
            session.scanned = true;
          } else if (status !== 86101) throw new Error('登录轮询状态无效');
          session.failures = 0;
        } catch (error) {
          if (active() && (confirmed || ++session.failures >= maxFailures)) {
            log('error', '扫码登录失败', error);
            finish('login:error', { message: error.message });
          }
        } finally { session.inFlight = false; }
      }, pollIntervalMs);
      return { url: result.data.url, key: result.data.qrcode_key, qr: { size: qr.modules.size, data: Array.from(qr.modules.data) } };
    } catch (error) {
      if (active()) cancelLogin();
      throw error;
    }
  }
  return { cookieHeader, hasCookieFile, pushCookieArgs, getProfile, createLogin, cancelLogin, logout, shutdown: cancelLogin };
}

module.exports = { createAuthSession };
