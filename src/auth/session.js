const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createAuthSession({
  cookieFile,
  profileFile,
  requestJson,
  resolveLoginCookies = async () => [],
  send,
  log,
  QRCode,
  pollIntervalMs = 2000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
}) {
  let generation = 0;
  let currentSession = null;

  function cookieHeader() {
    if (!fs.existsSync(cookieFile)) return '';
    return fs.readFileSync(cookieFile, 'utf8').split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => {
      const fields = line.split('\t');
      return fields.length >= 7 ? `${fields[5].replace(/[\r\n]/g, '')}=${fields[6].replace(/[\r\n]/g, '')}` : '';
    }).filter(Boolean).join('; ');
  }

  function hasCookieFile() {
    if (!fs.existsSync(cookieFile)) return false;
    try {
      const lines = fs.readFileSync(cookieFile, 'utf8').split(/\r?\n/).filter(line => line && !line.trim().startsWith('#'));
      if (!lines.length) return false;
      // yt-dlp requires exactly seven Netscape cookie fields and matching subdomain notation.
      return lines.every(line => {
        const fields = line.split('\t');
        if (fields.length !== 7) return false;
        const [domain, includeSubdomains] = fields;
        return includeSubdomains === 'TRUE' ? domain.startsWith('.') : !domain.startsWith('.');
      });
    } catch (_) { return false; }
  }

  function pushCookieArgs(args) {
    if (hasCookieFile()) args.push('--cookies', cookieFile);
    return args;
  }

  function saveCookies(setCookies) {
    fs.mkdirSync(path.dirname(cookieFile), { recursive: true });
    const rows = ['# Netscape HTTP Cookie File', ...setCookies.map(item => {
      const [pair, ...attrs] = item.split(';');
      const [name, ...value] = pair.trim().split('=');
      const domainAttr = attrs.find(x => x.trim().toLowerCase().startsWith('domain='))?.trim().slice(7) || '.bilibili.com';
      const domain = domainAttr.startsWith('.') ? domainAttr : `.${domainAttr}`;
      const expires = attrs.find(x => x.trim().toLowerCase().startsWith('expires='));
      const parsedExpiry = expires ? Math.floor(new Date(expires.split('=').slice(1).join('=')).getTime() / 1000) : 0;
      const expiry = Number.isFinite(parsedExpiry) ? parsedExpiry : 0;
      return `${domain}\tTRUE\t/\tFALSE\t${expiry}\t${name}\t${value.join('=')}`;
    })];
    fs.writeFileSync(cookieFile, rows.join('\n'), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(cookieFile, 0o600); } catch (_) {}
  }

  function profileFingerprint(header) {
    return crypto.createHash('sha256').update(header).digest('hex');
  }

  function readProfileCache(header) {
    if (!header || !fs.existsSync(profileFile)) return null;
    try {
      const cached = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
      return cached.cookieFingerprint === profileFingerprint(header) && cached.profile?.name ? cached.profile : null;
    } catch (_) { return null; }
  }

  function writeProfileCache(header, profile) {
    try {
      fs.mkdirSync(path.dirname(profileFile), { recursive: true });
      fs.writeFileSync(profileFile, JSON.stringify({ cookieFingerprint: profileFingerprint(header), profile }), { encoding: 'utf8', mode: 0o600 });
    } catch (_) {}
  }

  function clearProfileCache() {
    try { if (fs.existsSync(profileFile)) fs.unlinkSync(profileFile); } catch (_) {}
  }

  async function getProfile() {
    const header = cookieHeader();
    if (!header) return null;
    const startedGeneration = generation;
    const stillCurrent = () => startedGeneration === generation && header === cookieHeader();
    try {
      const result = await requestJson('https://api.bilibili.com/x/web-interface/nav', {
        headers: { Cookie: header, Referer: 'https://www.bilibili.com/' }
      });
      if (!stillCurrent()) return null;
      if (result.code !== 0 || !result.data?.uname) {
        clearProfileCache();
        return null;
      }
      const profile = { name: result.data.uname, avatar: result.data.face || '' };
      writeProfileCache(header, profile);
      return profile;
    } catch (_) { return stillCurrent() ? readProfileCache(header) : null; }
  }

  function stopCurrentSession() {
    if (!currentSession) return;
    currentSession.active = false;
    clearIntervalFn(currentSession.timer);
    currentSession = null;
  }

  function cancelLogin() {
    generation += 1;
    stopCurrentSession();
    return true;
  }

  function logout() {
    cancelLogin();
    if (fs.existsSync(cookieFile)) fs.unlinkSync(cookieFile);
    clearProfileCache();
    return true;
  }

  function shutdown() {
    return cancelLogin();
  }

  async function createLogin() {
    generation += 1;
    const thisGeneration = generation;
    stopCurrentSession();
    const result = await requestJson('https://passport.bilibili.com/x/passport-login/web/qrcode/generate');
    if (thisGeneration !== generation) throw new Error('登录已取消');
    if (result.code !== 0) throw new Error(result.message || '二维码生成失败');
    const qr = QRCode.create(result.data.url, { errorCorrectionLevel: 'M' });
    const session = { active: true, pollInFlight: false, scanned: false, timer: null };
    currentSession = session;
    const isCurrent = () => thisGeneration === generation && session.active && currentSession === session;
    async function poll() {
      if (!isCurrent() || session.pollInFlight) return;
      session.pollInFlight = true;
      try {
        const pollResponse = await requestJson(`https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(result.data.qrcode_key)}`, { withHeaders: true });
        if (!isCurrent()) return;
        const pollResult = pollResponse.json;
        if (pollResult.data?.code === 0) {
          stopCurrentSession();
          let cookies = pollResponse.headers?.['set-cookie'] || [];
          if (!cookies.some(cookie => /^SESSDATA=/i.test(cookie))) {
            cookies = [...cookies, ...await resolveLoginCookies(pollResult.data?.url)];
          }
          // stopCurrentSession() marks the scanned QR inactive, so the poller's
          // isCurrent() predicate no longer applies here. The generation still
          // identifies this login attempt and must guard the awaited ticket exchange.
          if (thisGeneration !== generation) return;
          if (!cookies.some(cookie => /^SESSDATA=/i.test(cookie))) throw new Error('登录凭据未返回，请刷新二维码重试');
          saveCookies(cookies);
          const profile = await getProfile();
          if (thisGeneration !== generation) return;
          if (!profile) throw new Error('登录凭据校验失败，请刷新二维码重试');
          log('info', '用户扫码登录成功');
          send('login:success', { cookie: true, loggedIn: Boolean(profile), profile });
        } else if (pollResult.data?.code === 86090) {
          if (!session.scanned) { session.scanned = true; send('login:scanned', {}); }
        } else if (pollResult.data?.code === 86038) {
          stopCurrentSession();
          send('login:expired', {});
        }
      } catch (error) {
        if (thisGeneration === generation) { log('error', `扫码登录失败: ${error.message}`); send('login:error', { message: error.message }); }
      } finally {
        session.pollInFlight = false;
      }
    }
    session.timer = setIntervalFn(poll, pollIntervalMs);
    return { url: result.data.url, key: result.data.qrcode_key, qr: { size: qr.modules.size, data: Array.from(qr.modules.data) } };
  }

  return { cookieHeader, hasCookieFile, pushCookieArgs, getProfile, createLogin, cancelLogin, logout, shutdown };
}

module.exports = { createAuthSession };
