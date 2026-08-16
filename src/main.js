const { app, BrowserWindow, ipcMain, shell, session, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { autoUpdater } = require('electron-updater');
const tools = require('./tools');
const { ALLOWED_MODES, DOWNLOAD_DEFAULTS, AUDIO_FORMATS, CONTAINER_FORMATS, VIDEO_QUALITIES, AUDIO_QUALITIES } = require('./download/constants');
const { normalizeContentModes, ytdlpDownloadArgs, audioFormatArgs } = require('./download/formats');
const { validateDownloadData } = require('./download/request');
const { createDownloadTask, serializeTaskForQueue } = require('./download/task');
const { createDownloadQueue } = require('./download/queue');
const { createDownloadExecutor } = require('./download/executor');


const dataDir = path.join(app.getPath('userData'), 'bili-go');
const authDir = path.join(app.getPath('userData'), 'bili-go-auth');
const cookieFile = path.join(authDir, 'cookies.txt');
const profileFile = path.join(authDir, 'profile.json');
const historyFile = path.join(dataDir, 'history.json');
const settingsFile = path.join(dataDir, 'settings.json');
const queueFile = path.join(dataDir, 'queue.json');
const logDir = path.join(dataDir, 'logs');
const logFile = path.join(logDir, 'biligo.log');
const UPDATE_REPOSITORY = 'https://github.com/Chinsir0214/BiliGo';
const UPDATE_API = 'https://api.github.com/repos/Chinsir0214/BiliGo';
const MAX_JSON_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 20 * 1024 * 1024;
const ALLOWED_HOSTS = new Set(['bilibili.com', 'b23.tv']);
let win;
let loginPoll;
let loginPollInFlight = false;
let loginGeneration = 0;
// Do not silently install unsigned updates. Users can review the release page manually.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.on('download-progress', progress => send('update:progress', { percent: progress.percent, transferred: progress.transferred, total: progress.total, bytesPerSecond: progress.bytesPerSecond }));
autoUpdater.on('update-downloaded', () => send('update:downloaded', {}));

function ensureDataDir() { fs.mkdirSync(dataDir, { recursive: true }); }
function ensureAuthDir() { fs.mkdirSync(authDir, { recursive: true }); }
function ensureLogDir() { fs.mkdirSync(logDir, { recursive: true }); }
function log(level, message) { try { ensureLogDir(); fs.appendFileSync(logFile, `${new Date().toISOString()} [${level}] ${message}\n`, 'utf8'); } catch (_) {} }
function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...(options.headers || {}) } }, res => {
      let body = '';
      let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > MAX_JSON_BYTES) { req.destroy(new Error('响应内容过大')); return; } body += chunk; });
      res.on('end', () => { if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`请求失败（HTTP ${res.statusCode}）`)); try { const json = JSON.parse(body); resolve(options.withHeaders ? { json, headers: res.headers } : json); } catch (error) { reject(error); } });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('请求超时')));
  });
}
function requestText(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...(options.headers || {}) } }, res => { let body = ''; let size = 0; res.on('data', chunk => { size += chunk.length; if (size > MAX_TEXT_BYTES) { req.destroy(new Error('响应内容过大')); return; } body += chunk; }); res.on('end', () => res.statusCode === 200 ? resolve(body) : reject(new Error(`请求失败（HTTP ${res.statusCode}）`))); });
    req.on('error', reject); req.setTimeout(10000, () => req.destroy(new Error('请求超时')));
  });
}
function assertBilibiliUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '')); } catch (_) { throw new Error('链接格式无效'); }
  const hostname = parsed.hostname.toLowerCase();
  const isBilibiliHost = hostname === 'bilibili.com' || hostname.endsWith('.bilibili.com');
  if (parsed.protocol !== 'https:' || (!isBilibiliHost && !ALLOWED_HOSTS.has(hostname)) || parsed.username || parsed.password) throw new Error('只支持 HTTPS Bilibili 链接');
  return parsed.toString();
}
function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }
function cookieHeader() {
  if (!fs.existsSync(cookieFile)) return '';
  return fs.readFileSync(cookieFile, 'utf8').split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => {
    const fields = line.split('\t'); return fields.length >= 7 ? `${fields[5].replace(/[\r\n]/g, '')}=${fields[6].replace(/[\r\n]/g, '')}` : '';
  }).filter(Boolean).join('; ');
}
function hasCookieFile() {
  if (!fs.existsSync(cookieFile)) return false;
  try {
    const lines = fs.readFileSync(cookieFile, 'utf8').split(/\r?\n/).filter(line => line && !line.trim().startsWith('#'));
    if (!lines.length) return false;
    // yt-dlp 会逐行校验 Netscape 格式：必须恰好 7 个字段，且「是否含子域」标记必须与域名开头的点一致，
    // 否则会抛出 AssertionError。这里做同样的校验，遇到坏文件时跳过 cookies 而不是让下载失败。
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
  ensureAuthDir();
  const rows = ['# Netscape HTTP Cookie File', ...setCookies.map(item => {
    const [pair, ...attrs] = item.split(';'); const [name, ...value] = pair.trim().split('=');
    const domainAttr = attrs.find(x => x.trim().toLowerCase().startsWith('domain='))?.trim().slice(7) || '.bilibili.com';
    const domain = domainAttr.startsWith('.') ? domainAttr : `.${domainAttr}`;
    const expires = attrs.find(x => x.trim().toLowerCase().startsWith('expires='));
    const expiry = expires ? Math.floor(new Date(expires.split('=').slice(1).join('=')).getTime() / 1000) : 0;
    return `${domain}\tTRUE\t/\tFALSE\t${expiry}\t${name}\t${value.join('=')}`;
  })];
  fs.writeFileSync(cookieFile, rows.join('\n'), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(cookieFile, 0o600); } catch (_) {}
}
function readHistory() { try { const value = JSON.parse(fs.readFileSync(historyFile, 'utf8')); return Array.isArray(value) ? value : []; } catch (_) { try { if (fs.existsSync(historyFile)) fs.renameSync(historyFile, `${historyFile}.corrupt-${Date.now()}`); } catch (_) {} return []; } }
function writeHistory(items) { ensureDataDir(); fs.writeFileSync(historyFile, JSON.stringify(items.slice(0, 100), null, 2), 'utf8'); }
function readSettings() { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch (_) { return {}; } }
function writeSettings(settings) { ensureDataDir(); fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8'); }
function settingNumber(settings, key) { return Number(settings[key] || DOWNLOAD_DEFAULTS[key]); }
function subtitleLanguages(value) {
  if (Array.isArray(value)) return value.map(item => { const language = String(item.lan || item.lang || item.language || ''); const name = String(item.lan_doc || item.name || language); return { value: `${language}:${item.ai_type ? 'ai' : 'normal'}`, label: `${name}${item.ai_type ? 'AI字幕' : '字幕'}` }; }).filter(item => item.value);
  return Object.keys(value || {}).map(key => ({ value: key, label: key })).filter(item => item.value);
}
async function playerSubtitleLanguages(bvid, cid) {
  try {
    const result = await requestJson(`https://api.bilibili.com/x/player/wbi/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}`, { headers: { Cookie: cookieHeader() } });
    return subtitleLanguages(result.data?.subtitle?.subtitles || result.data?.subtitle?.list);
  } catch (_) { return []; }
}
function versionParts(value) { return String(value || '0').replace(/^v/i, '').split(/[.-]/).map(part => Number.parseInt(part, 10) || 0); }
function isNewerVersion(latest, current) { const a = versionParts(latest); const b = versionParts(current); for (let index = 0; index < Math.max(a.length, b.length); index += 1) { if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0); } return false; }
async function checkForUpdates() {
  const currentVersion = app.getVersion();
  try {
    const result = await autoUpdater.checkForUpdates();
    return { currentVersion, latestVersion: result?.updateInfo?.version || currentVersion, hasUpdate: Boolean(result?.updateInfo && isNewerVersion(result.updateInfo.version, currentVersion)), canDownload: false, pageUrl: UPDATE_REPOSITORY, downloadUrl: '' };
  } catch (_) {
    let latestVersion = currentVersion;
    let pageUrl = UPDATE_REPOSITORY;
    let downloadUrl = '';
    try {
      const release = await requestJson(`${UPDATE_API}/releases/latest`);
      latestVersion = release.tag_name || release.name || currentVersion;
      pageUrl = release.html_url || pageUrl;
      downloadUrl = release.assets?.find(asset => /setup|portable|\.exe$/i.test(asset.name || ''))?.browser_download_url || '';
    } catch (_) {
      const manifest = await requestJson('https://raw.githubusercontent.com/Chinsir0214/BiliGo/main/package.json');
      latestVersion = manifest.version || currentVersion;
    }
    return { currentVersion, latestVersion: String(latestVersion).replace(/^v/i, ''), hasUpdate: isNewerVersion(latestVersion, currentVersion), pageUrl, downloadUrl };
  }
}
function safeName(value) { return String(value || '未命名资源').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || '未命名资源'; }
function safeTemplate(value) { const template = String(value || DOWNLOAD_DEFAULTS.filenameTemplate).replace(/[\\/]/g, '_').replace(/\.\./g, '_').trim(); return template && !path.isAbsolute(template) ? template : DOWNLOAD_DEFAULTS.filenameTemplate; }
function directoryFiles(directory) { try { return fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => path.join(directory, entry.name)); } catch (_) { return []; } }
function fileSnapshot(directory) { return new Map(directoryFiles(directory).map(file => { try { const stat = fs.statSync(file); return [file, `${stat.size}:${stat.mtimeMs}`]; } catch (_) { return [file, '']; } })); }
function fileStats(files) { return files.reduce((total, file) => { try { return total + fs.statSync(file).size; } catch (_) { return total; } }, 0); }
function isPathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
function allowedLocalRoots() {
  const settings = readSettings();
  const roots = [settings.downloadDir, path.join(app.getPath('downloads'), 'BiliGo')];
  for (const item of readHistory()) if (item.outputDir) roots.push(item.outputDir);
  return [...new Set(roots.filter(Boolean))];
}
function isAllowedLocalPath(target) {
  if (!target || !path.isAbsolute(target)) return false;
  return allowedLocalRoots().some(root => { try { return isPathInside(root, target); } catch (_) { return false; } });
}
function primaryDownloadFile(files) {
  const mediaExtensions = ['.mp4', '.mkv', '.webm', '.mov', '.m4a', '.mp3', '.flac', '.wav', '.aac', '.ogg', '.opus'];
  return files.find(file => mediaExtensions.includes(path.extname(file).toLowerCase())) || files[0] || '';
}
function cleanupPartialFiles(directory) {
  for (const file of directoryFiles(directory)) {
    const lower = path.basename(file).toLowerCase();
    if (/\.(part|ytdl|temp|tmp)$/.test(lower) || /\.f\d+\.(mp4|m4s|flv|webm|m4a|mp3|ts|vtt|srt|ass)$/.test(lower)) {
      try { fs.unlinkSync(file); } catch (_) {}
    }
  }
}
function cleanupTaskFiles(directory, before) {
  for (const file of directoryFiles(directory)) {
    try {
      const stat = fs.statSync(file);
      const snapshot = `${stat.size}:${stat.mtimeMs}`;
      if (!before.has(file) || before.get(file) !== snapshot) fs.unlinkSync(file);
    } catch (_) {}
  }
}
function downloadRecord(task, destination, modes, status, startedAt, before, error = '') {
  const files = directoryFiles(destination).filter(file => { try { const stat = fs.statSync(file); return !before.has(file) || before.get(file) !== `${stat.size}:${stat.mtimeMs}`; } catch (_) { return false; } });
  const record = { id: task.id, title: task.title, url: task.url, outputDir: destination, file: primaryDownloadFile(files), files, fileCount: files.length, sizeBytes: fileStats(files), mode: modes.join(','), status, startedAt: new Date(startedAt).toISOString(), completedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, retryTask: serializeTaskForQueue(task) };
  if (error) record.error = error;
  return record;
}
function cookieFingerprint(header) { return crypto.createHash('sha256').update(header).digest('hex'); }
function readProfileCache(header) {
  if (!header || !fs.existsSync(profileFile)) return null;
  try {
    const cached = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
    return cached.cookieFingerprint === cookieFingerprint(header) && cached.profile?.name ? cached.profile : null;
  } catch (_) { return null; }
}
function writeProfileCache(header, profile) {
  try {
    ensureAuthDir();
    fs.writeFileSync(profileFile, JSON.stringify({ cookieFingerprint: cookieFingerprint(header), profile }), { encoding: 'utf8', mode: 0o600 });
  } catch (_) {}
}
function clearProfileCache() { try { if (fs.existsSync(profileFile)) fs.unlinkSync(profileFile); } catch (_) {} }
async function getProfile() {
  const header = cookieHeader();
  if (!header) return null;
  try {
    const result = await requestJson('https://api.bilibili.com/x/web-interface/nav', { headers: { Cookie: header, Referer: 'https://www.bilibili.com/' } });
    if (result.code !== 0 || !result.data?.uname) return readProfileCache(header);
    const profile = { name: result.data.uname, avatar: result.data.face || '' };
    writeProfileCache(header, profile);
    return profile;
  } catch (_) { return readProfileCache(header); }
}
async function parseFavoritePage(favoriteId, page) {
  const result = await requestJson(`https://api.bilibili.com/x/v3/fav/resource/list?media_id=${favoriteId}&ps=20&pn=${page}&platform=web`, { headers: { Cookie: cookieHeader(), Referer: 'https://space.bilibili.com/' } });
  if (result.code !== 0) throw new Error(result.message || '无法读取收藏夹');
  const medias = result.data?.medias || [];
  const items = medias.map(item => {
    const bvid = item?.bvid || item?.bv_id || '';
    const title = item?.title || '';
    const unavailable = !bvid || /失效|已删除|不可用/.test(title);
    return { id: bvid || `unavailable-${item?.id || Math.random().toString(36).slice(2)}`, title: title || '已失效视频', url: unavailable ? '' : `https://www.bilibili.com/video/${bvid}`, thumbnail: item?.cover || '', duration: typeof item?.duration === 'string' ? item.duration.split(':').reduce((total, part) => total * 60 + Number(part || 0), 0) : Number(item?.duration) || 0, subtitleLanguages: [], unavailable };
  });
  return { title: result.data?.info?.title || '收藏夹', items, hasMore: Boolean(result.data?.has_more), total: Number(result.data?.info?.media_count || 0) };
}
async function parseAllFavoritePages(favoriteId) {
  const items = []; let page = 1; let first; let current;
  do {
    current = await parseFavoritePage(favoriteId, page); first ||= current;
    items.push(...current.items);
    page += 1;
  } while (first && current.hasMore && page <= 500);
  return { ...first, items, hasMore: false, page: page - 1, total: items.length };
}
async function parseResource(url) {
  url = assertBilibiliUrl(url);
  const favoriteId = url.match(/[?&]fid=(\d+)/i)?.[1];
  if (favoriteId) {
    try {
      const favorite = await parseAllFavoritePages(favoriteId);
      if (favorite.items.length) return { title: favorite.title, thumbnail: favorite.items[0].thumbnail, type: 'favorite', items: favorite.items, favoriteId, page: favorite.page, hasMore: false, total: favorite.total };
    } catch (error) {
      log('error', `收藏夹接口解析失败 ${favoriteId}: ${error.message}`);
      throw error;
    }
  }
  const bvid = url.match(/BV[a-zA-Z0-9]+/)?.[0];
  const isCollectionUrl = /collection|medialist|series/i.test(url);
  if (bvid && !isCollectionUrl) {
    try {
      const view = await requestJson(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: { Cookie: cookieHeader() } });
      if (view.code === 0 && view.data) {
        const pages = view.data.pages || [];
        const type = pages.length > 1 ? 'parts' : /favlist|favorite/i.test(url) ? 'favorite' : /collection|medialist|series/i.test(url) ? 'collection' : 'video';
        const firstCid = pages[0]?.cid || view.data.cid;
        const subtitles = [...subtitleLanguages(view.data.subtitle?.list), ...(firstCid ? await playerSubtitleLanguages(bvid, firstCid) : [])].filter((item, index, list) => list.findIndex(other => other.value === item.value) === index);
        const items = pages.length ? pages.map((page, index) => ({ id: String(page.cid || index), title: page.part || `第 ${index + 1} 集`, url: `${url.split('?')[0]}?p=${page.page}`, thumbnail: '', duration: page.duration || 0, subtitleLanguages: subtitles })) : [{ id: bvid, title: view.data.title || '未命名视频', url, thumbnail: view.data.pic || '', duration: view.data.duration || 0, subtitleLanguages: subtitles }];
        return { title: view.data.title || items[0].title, thumbnail: view.data.pic || '', type, items };
      }
    } catch (_) {
      // Fall back to yt-dlp for URLs that are not available through the public API.
    }
  }
  return new Promise((resolve, reject) => {
    const args = ['--dump-single-json', '--skip-download', '--flat-playlist', '--no-warnings', '--socket-timeout', '15'];
    pushCookieArgs(args);
    args.push(url);
    const child = spawn(tools.resolveTool(app, 'yt-dlp'), args, { windowsHide: true }); let output = ''; let error = ''; let timedOut = false;
    child.stdout.on('data', data => output += data); child.stderr.on('data', data => error += data);
    const timer = setTimeout(() => { timedOut = true; child.kill(); reject(new Error('解析超时，请检查链接或登录状态')); }, 45000);
    child.on('error', error => { clearTimeout(timer); reject(new Error(`解析程序启动失败：${error.message}`)); });
    child.on('close', code => { clearTimeout(timer); if (timedOut) return; if (code !== 0) return reject(new Error(error.split(/\r?\n/).filter(Boolean).pop() || '无法读取视频信息')); try {
      const info = JSON.parse(output); const entries = (info.entries || []).filter(Boolean);
      const resourceType = /favlist|favorite/i.test(url) ? 'favorite' : /collection|medialist|series/i.test(url) ? 'collection' : entries.length > 1 ? 'parts' : 'video';
       const items = entries.length ? entries.map((item, index) => ({ id: item.id || `${index}`, title: item.title || item.fulltitle || `第 ${index + 1} 集`, url: item.webpage_url || item.original_url || (resourceType === 'parts' ? `${url}${url.includes('?') ? '&' : '?'}p=${index + 1}` : item.id ? `https://www.bilibili.com/video/${item.id}` : url), thumbnail: item.thumbnail || '', duration: item.duration || 0, subtitleLanguages: subtitleLanguages(item.subtitles) })) : [{ id: info.id || 'video', title: info.title || info.fulltitle || '未命名视频', url: info.webpage_url || url, thumbnail: info.thumbnail || '', duration: info.duration || 0, subtitleLanguages: subtitleLanguages(info.subtitles) }];
      resolve({ title: info.playlist_title || info.title || items[0].title, thumbnail: info.thumbnail || items[0].thumbnail || '', type: resourceType, items });
    } catch (_) { reject(new Error('视频信息解析失败')); } });
  });
}
async function downloadDanmaku(url, title, destination) {
  const bvid = url.match(/BV[a-zA-Z0-9]+/)?.[0]; const aid = url.match(/av(\d+)/i)?.[1];
  if (!bvid && !aid) throw new Error('无法从链接中识别视频编号');
  const query = bvid ? `bvid=${bvid}` : `aid=${aid}`;
  const view = await requestJson(`https://api.bilibili.com/x/web-interface/view?${query}`, { headers: { Cookie: cookieHeader() } });
  if (view.code !== 0 || !view.data) throw new Error(view.message || '无法读取视频信息');
  const page = Number(url.match(/[?&]p=(\d+)/i)?.[1] || 1); const cid = view.data?.pages?.[page - 1]?.cid || view.data?.pages?.[0]?.cid; if (!cid) throw new Error('无法获取视频弹幕');
  const xml = await requestText(`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`, { headers: { Cookie: cookieHeader() } });
  const suffix = bvid || (aid ? `av${aid}` : 'danmaku');
  const file = path.join(destination, `${safeName(title)} [${suffix}].xml`); fs.writeFileSync(file, xml, 'utf8'); return file;
}
function throwIfCancelled(task) { if (task.cancelled) throw new Error('下载已取消'); }
const downloadExecutor = createDownloadExecutor({
  resolveYtdlp: () => tools.resolveTool(app, 'yt-dlp'),
  resolveFfmpeg: () => tools.resolveTool(app, 'ffmpeg'),
  cookieFile,
  hasCookieFile,
  send
});
const downloadManager = createDownloadQueue({
  read: () => { try { const value = JSON.parse(fs.readFileSync(queueFile, 'utf8')); return Array.isArray(value) ? value : []; } catch (_) { return []; } },
  write: items => { ensureDataDir(); fs.writeFileSync(queueFile, JSON.stringify(items.slice(0, 1000), null, 2), 'utf8'); },
  serialize: serializeTaskForQueue,
  processTask: runDownloadTask,
  maxConcurrency: () => settingNumber(readSettings(), 'maxConcurrentTasks')
});
async function createLogin() {
  const result = await requestJson('https://passport.bilibili.com/x/passport-login/web/qrcode/generate');
  if (result.code !== 0) throw new Error(result.message || '二维码生成失败');
  clearInterval(loginPoll);
  loginGeneration += 1;
  const generation = loginGeneration;
  loginPoll = null;
  loginPoll = setInterval(async () => {
    if (loginPollInFlight || generation !== loginGeneration) return;
    loginPollInFlight = true;
    try {
      const pollResponse = await requestJson(`https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(result.data.qrcode_key)}`, { withHeaders: true });
      if (generation !== loginGeneration) return;
      const poll = pollResponse.json;
      send('login:poll', { code: poll.data?.code, message: poll.data?.message });
      if (poll.data?.code === 0) {
        clearInterval(loginPoll); loginPoll = null;
        const cookies = pollResponse.headers?.['set-cookie'] || [];
        if (cookies.length) saveCookies(cookies);
        log('info', '用户扫码登录成功');
        const profile = await getProfile();
        send('login:success', { cookie: true, loggedIn: Boolean(profile), profile });
      } else if (poll.data?.code === 86090) { clearInterval(loginPoll); loginPoll = null; send('login:expired', {}); }
    } catch (error) { if (generation === loginGeneration) send('app:error', error.message); }
    finally { loginPollInFlight = false; }
  }, 2000);
  const qr = QRCode.create(result.data.url, { errorCorrectionLevel: 'M' });
  return { url: result.data.url, key: result.data.qrcode_key, qr: { size: qr.modules.size, data: Array.from(qr.modules.data) } };
}
async function download({ url, urls, itemTitles, title, folderName, resourceType, mode, contentModes, videoQuality, audioQuality, audioFormat, outputDir, filenameTemplate, containerFormat, embedThumbnail, embedMetadata, embedChapters, embedSubs, subtitleLangs, rateLimit, retries, fragmentThreads }) {
  ({ url, urls, contentModes } = validateDownloadData({ url, urls, itemTitles, title, folderName, resourceType, mode, contentModes, videoQuality, audioQuality, outputDir, filenameTemplate, containerFormat, embedChapters, embedSubs, subtitleLangs, rateLimit, retries, fragmentThreads }, { assertBilibiliUrl, isAllowedLocalPath }));
  ensureDataDir();
  const info = title ? { title } : await parseResource(url);
  const settings = readSettings();
  const task = createDownloadTask({ url, urls, itemTitles, title, folderName, resourceType, mode, contentModes, videoQuality, audioQuality, audioFormat, outputDir, filenameTemplate, containerFormat, embedThumbnail, embedMetadata, embedChapters, embedSubs, subtitleLangs, rateLimit, retries, fragmentThreads }, info, settings);
  const position = downloadManager.enqueue(task);
  return { id: task.id, title: info.title, thumbnail: info.thumbnail, url: task.url, mode: task.contentModes.join(','), queued: true, position };
}

async function runDownloadTask(task) {
    const startedAt = Date.now();
    const destinationRoot = task.outputDir || readSettings().downloadDir || path.join(app.getPath('downloads'), 'BiliGo');
    const group = task.folderName || (task.resourceType && task.resourceType !== 'video' ? task.title : '');
    const destination = group ? path.join(destinationRoot, safeName(group)) : destinationRoot;
    const downloadUrls = task.urls?.length ? task.urls : [task.url];
    const modes = task.contentModes;
    const concurrentDestination = [...downloadManager.activeTasks.values()].some(active => active !== task && (active.outputDir || readSettings().downloadDir || path.join(app.getPath('downloads'), 'BiliGo')) === destinationRoot && (active.folderName || (active.resourceType && active.resourceType !== 'video' ? active.title : '')) === group);
    const destinationExisted = fs.existsSync(destination);
    fs.mkdirSync(destination, { recursive: true });
    const before = fileSnapshot(destination);
    const runYtdlp = args => downloadExecutor.run(task, args, downloadUrls);
    const common = ytdlpDownloadArgs(task, modes, downloadExecutor.resolveFfmpeg);
    const template = safeTemplate(task.filenameTemplate);
    const output = path.join(destination, template);
    const media = modes.includes('video-audio') || modes.includes('video') || modes.includes('audio');
    let record;
    log('info', `下载任务开始 ${task.id}: ${task.title}`);
    try {
      if (modes.includes('danmaku')) for (let index = 0; index < downloadUrls.length; index += 1) { throwIfCancelled(task); await downloadDanmaku(downloadUrls[index], task.itemTitles?.[index] || task.title, destination); }
      throwIfCancelled(task);
      if (media) {
        const args = [...common];
        if (modes.includes('audio') && !modes.includes('video-audio') && !modes.includes('video')) audioFormatArgs(task, args);
        else if (modes.includes('video') && !modes.includes('video-audio')) args.push('-f', task.videoQuality === 'bv*' ? 'bv' : task.videoQuality || 'bv');
        else args.push('-f', `${task.videoQuality === 'bv*' ? 'bv' : task.videoQuality || 'bv'}+${task.audioQuality || 'ba/b'}`, '--merge-output-format', task.containerFormat || 'mp4');
        if (task.embedThumbnail) args.push('--embed-thumbnail');
        if (task.embedMetadata) args.push('--add-metadata');
        if (task.embedChapters) args.push('--embed-chapters');
        if (task.embedSubs && (modes.includes('video-audio') || modes.includes('video'))) args.push('--write-subs', '--embed-subs', '--sub-langs', task.subtitleLangs || 'all', '--sub-format', 'vtt');
        args.push('-o', output); await runYtdlp(args);
      }
      throwIfCancelled(task);
      if (modes.includes('cover')) await runYtdlp([...common, '--skip-download', '--write-thumbnail', '--convert-thumbnails', 'jpg', '-o', output]);
      throwIfCancelled(task);
        if (modes.includes('subtitle') && (!task.embedSubs || !media)) {
        const subtitleArgs = [...common, '--write-subs', '--sub-langs', task.subtitleLangs || 'all', '--sub-format', 'vtt'];
        subtitleArgs.push('--skip-download');
        subtitleArgs.push('-o', output);
        await runYtdlp(subtitleArgs);
      }
      throwIfCancelled(task);
      record = downloadRecord(task, destination, modes, 'completed', startedAt, before);
      writeHistory([record, ...readHistory().filter(item => item.id !== task.id)]);
      log('info', `下载任务完成 ${task.id}: ${task.title}`);
      send('download:done', { id: task.id, code: 0, record });
    } catch (error) {
      if (task.cancelled) {
        if (!concurrentDestination) cleanupTaskFiles(destination, before);
        if (!destinationExisted) {
          try { if (!fs.readdirSync(destination).length) fs.rmdirSync(destination); } catch (_) {}
        }
      } else {
        if (!concurrentDestination) cleanupTaskFiles(destination, before);
        if (!destinationExisted) {
          try { if (!fs.readdirSync(destination).length) fs.rmdirSync(destination); } catch (_) {}
        }
      }
      record = downloadRecord(task, destination, modes, task.cancelled ? 'cancelled' : 'failed', startedAt, before, error.message);
      writeHistory([record, ...readHistory().filter(item => item.id !== task.id)]);
      log('error', `下载任务${task.cancelled ? '取消' : '失败'} ${task.id}: ${task.title} - ${error.message}`);
      send('download:done', { id: task.id, code: task.cancelled ? 2 : 1, record });
    } finally { task.process = null; }
}

function createWindow() {
  win = new BrowserWindow({ width: 1360, height: 920, minWidth: 360, minHeight: 560, icon: path.join(__dirname, '..', 'assets', 'icon.png'), backgroundColor: '#f7f7f5', autoHideMenuBar: true, titleBarStyle: 'hidden', titleBarOverlay: { color: '#f7f7f5', symbolColor: '#191919', height: 32 }, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('preload-error', (_, preloadPath, error) => console.error(`Preload 加载失败: ${preloadPath}`, error));
  win.loadFile(path.join(__dirname, 'index.html'));
}
app.whenReady().then(async () => {
  ensureDataDir();
  downloadManager.load();
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['https://*.hdslb.com/*', 'https://*.biliimg.com/*'] }, (details, callback) => {
    const headers = details.requestHeaders || {};
    headers.Referer = 'https://www.bilibili.com/';
    headers['User-Agent'] = headers['User-Agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    callback({ requestHeaders: headers });
  });
  createWindow();
  downloadManager.pump();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('before-quit', () => {
  clearInterval(loginPoll); loginPoll = null; loginGeneration += 1;
   downloadManager.requeueActive(downloadExecutor.stop);
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
ipcMain.handle('login:start', createLogin);
ipcMain.handle('login:cancel', () => { clearInterval(loginPoll); loginPoll = null; loginGeneration += 1; return true; });
ipcMain.handle('login:status', async () => { const profile = await getProfile(); return { loggedIn: Boolean(profile), profile }; });
ipcMain.handle('login:logout', () => { if (fs.existsSync(cookieFile)) fs.unlinkSync(cookieFile); clearProfileCache(); return true; });
ipcMain.handle('resource:parse', (_, url) => parseResource(url));
ipcMain.handle('resource:more', async (_, data) => {
  const favoriteId = String(data?.favoriteId || '');
  const requestedPage = Number(data?.page);
  const page = Number.isFinite(requestedPage) ? Math.max(1, Math.floor(requestedPage)) : 1;
  if (!/^\d+$/.test(favoriteId)) throw new Error('收藏夹 ID 无效');
  const result = await parseFavoritePage(favoriteId, page);
  return { items: result.items, page, hasMore: result.hasMore, total: result.total };
});
ipcMain.handle('update:check', checkForUpdates);
ipcMain.handle('update:download', async () => { await autoUpdater.downloadUpdate(); return true; });
ipcMain.handle('update:install', () => { autoUpdater.quitAndInstall(); return true; });
ipcMain.handle('download:start', (_, data) => download(data));
ipcMain.handle('queue:list', () => [...downloadManager.activeTasks.values(), ...downloadManager.downloadQueue].map(task => ({ id: task.id, title: task.title, url: task.url, mode: task.contentModes.join(','), outputDir: task.outputDir, queuedAt: task.queuedAt, status: downloadManager.activeTasks.has(task.id) ? 'downloading' : 'queued' })));
ipcMain.handle('download:retry', (_, id) => {
  const item = readHistory().find(record => record.id === id);
  if (!item?.retryTask) throw new Error('这条记录没有可重试的下载配置');
  return download(item.retryTask);
});
ipcMain.handle('download:cancel', (_, id) => {
  const task = downloadManager.cancelQueued(id);
  if (task) { const record = { id, title: task.title, url: task.url, mode: task.contentModes.join(','), status: 'cancelled', file: '', files: [], fileCount: 0, sizeBytes: 0, completedAt: new Date().toISOString() }; writeHistory([record, ...readHistory().filter(item => item.id !== id)]); send('download:done', { id, code: 2, record }); return true; }
  const active = downloadManager.activeTasks.get(id);
   if (active) { active.cancelled = true; downloadExecutor.stop(active); return true; }
  return false;
});
ipcMain.handle('history:list', () => readHistory());
ipcMain.handle('history:clear', () => { writeHistory([]); return true; });
ipcMain.handle('history:remove', (_, ids) => { const remove = new Set(ids || []); writeHistory(readHistory().filter(item => !remove.has(item.id))); return true; });
ipcMain.handle('shell:open', (_, target) => {
  const resolved = target || readSettings().downloadDir || path.join(app.getPath('downloads'), 'BiliGo');
  if (!isAllowedLocalPath(resolved)) throw new Error('不允许打开该路径');
  return shell.openPath(resolved);
});
ipcMain.handle('video:play-local', (_, file) => {
  const resolved = file || '';
  if (!resolved || !isAllowedLocalPath(resolved) || !fs.existsSync(resolved) || !/\.(mp4|mkv|webm|mov|m4a|mp3|flac|wav|aac|ogg|opus)$/i.test(resolved)) throw new Error('文件不可用或不允许打开');
  return shell.openPath(resolved);
});
ipcMain.handle('clipboard:write', (_, value) => { clipboard.writeText(String(value || '')); return true; });
ipcMain.handle('settings:get', () => { const settings = readSettings(); return { downloadDir: settings.downloadDir || path.join(app.getPath('downloads'), 'BiliGo'), showThumbnails: settings.showThumbnails === true, contentModes: settings.contentModes?.length ? settings.contentModes : ['video-audio'], videoQuality: settings.videoQuality || DOWNLOAD_DEFAULTS.videoQuality, audioQuality: settings.audioQuality || DOWNLOAD_DEFAULTS.audioQuality, audioFormat: AUDIO_FORMATS.has(settings.audioFormat) ? settings.audioFormat : DOWNLOAD_DEFAULTS.audioFormat, fragmentThreads: Math.max(1, Math.min(16, settingNumber(settings, 'fragmentThreads'))), maxConcurrentTasks: Math.max(1, Math.min(10, settingNumber(settings, 'maxConcurrentTasks'))), containerFormat: CONTAINER_FORMATS.has(settings.containerFormat) ? settings.containerFormat : DOWNLOAD_DEFAULTS.containerFormat, filenameTemplate: settings.filenameTemplate || DOWNLOAD_DEFAULTS.filenameTemplate, subtitleLangs: settings.subtitleLangs || DOWNLOAD_DEFAULTS.subtitleLangs, rateLimit: settings.rateLimit || '', retries: settings.retries || String(DOWNLOAD_DEFAULTS.retries), embedThumbnail: settings.embedThumbnail === true, embedMetadata: settings.embedMetadata === true, embedSubs: settings.embedSubs === true, embedChapters: settings.embedChapters === true }; });
ipcMain.handle('settings:set', (_, changes) => {
  if (!changes || typeof changes !== 'object') throw new Error('设置参数无效');
  const allowed = new Set(['downloadDir', 'showThumbnails', 'contentModes', 'videoQuality', 'audioQuality', 'audioFormat', 'fragmentThreads', 'maxConcurrentTasks', 'containerFormat', 'filenameTemplate', 'subtitleLangs', 'rateLimit', 'retries', 'embedThumbnail', 'embedMetadata', 'embedSubs', 'embedChapters']);
  const safeChanges = Object.fromEntries(Object.entries(changes).filter(([key]) => allowed.has(key)));
  if (safeChanges.downloadDir !== undefined) {
    const directory = String(safeChanges.downloadDir);
    let isDirectory = false;
    try { isDirectory = path.isAbsolute(directory) && fs.statSync(directory).isDirectory(); } catch (_) {}
    if (!isDirectory) throw new Error('下载目录无效');
  }
  if (safeChanges.contentModes !== undefined) {
    safeChanges.contentModes = normalizeContentModes(safeChanges.contentModes, []);
    if (!safeChanges.contentModes.length || safeChanges.contentModes.some(mode => !ALLOWED_MODES.has(mode))) throw new Error('下载内容类型无效');
    const mediaMode = safeChanges.contentModes.find(mode => ['video-audio', 'video', 'audio'].includes(mode));
    if (safeChanges.contentModes.filter(mode => ['video-audio', 'video', 'audio'].includes(mode)).length > 1) throw new Error('下载类型冲突：只能选择一种媒体类型');
    if (safeChanges.embedSubs === true && !['video-audio', 'video'].includes(mediaMode)) throw new Error('嵌入字幕仅支持视频模式');
  }
  if (safeChanges.videoQuality !== undefined && !VIDEO_QUALITIES.has(String(safeChanges.videoQuality))) throw new Error('视频画质无效');
  if (safeChanges.audioQuality !== undefined && !AUDIO_QUALITIES.has(String(safeChanges.audioQuality))) throw new Error('音频质量无效');
  const current = readSettings();
  const effectiveModes = safeChanges.contentModes || current.contentModes || ['video-audio'];
  if (safeChanges.embedSubs === true && !effectiveModes.includes('video-audio') && !effectiveModes.includes('video')) throw new Error('嵌入字幕仅支持视频模式');
  const next = { ...current, ...safeChanges };
  if (safeChanges.audioFormat !== undefined && !AUDIO_FORMATS.has(String(safeChanges.audioFormat))) next.audioFormat = DOWNLOAD_DEFAULTS.audioFormat;
  if (safeChanges.containerFormat !== undefined && !CONTAINER_FORMATS.has(String(safeChanges.containerFormat))) next.containerFormat = DOWNLOAD_DEFAULTS.containerFormat;
  if (safeChanges.fragmentThreads !== undefined) next.fragmentThreads = Math.max(1, Math.min(16, Number(safeChanges.fragmentThreads) || 4));
  if (safeChanges.maxConcurrentTasks !== undefined) next.maxConcurrentTasks = Math.max(1, Math.min(10, Number(safeChanges.maxConcurrentTasks) || 1));
  writeSettings(next); return true;
});
ipcMain.handle('settings:reset', () => { const defaults = { downloadDir: path.join(app.getPath('downloads'), 'BiliGo'), showThumbnails: false, contentModes: ['video-audio'], videoQuality: DOWNLOAD_DEFAULTS.videoQuality, audioQuality: DOWNLOAD_DEFAULTS.audioQuality, audioFormat: DOWNLOAD_DEFAULTS.audioFormat, fragmentThreads: DOWNLOAD_DEFAULTS.fragmentThreads, maxConcurrentTasks: DOWNLOAD_DEFAULTS.maxConcurrentTasks, containerFormat: DOWNLOAD_DEFAULTS.containerFormat, filenameTemplate: DOWNLOAD_DEFAULTS.filenameTemplate, subtitleLangs: DOWNLOAD_DEFAULTS.subtitleLangs, rateLimit: '', retries: String(DOWNLOAD_DEFAULTS.retries), embedThumbnail: false, embedMetadata: false, embedSubs: false, embedChapters: false }; writeSettings(defaults); return defaults; });
ipcMain.handle('settings:chooseDir', async () => { const { dialog } = require('electron'); const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] }); if (result.canceled || !result.filePaths[0]) return null; const downloadDir = result.filePaths[0]; writeSettings({ ...readSettings(), downloadDir }); return downloadDir; });
ipcMain.handle('video:open', (_, url) => {
  const value = String(url || '');
  if (!/^https?:\/\//i.test(value)) throw new Error('只允许打开 HTTP(S) 链接');
  return shell.openExternal(value);
});
