const { app, BrowserWindow, ipcMain, shell, session, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const QRCode = require('qrcode');
const tools = require('./tools');

['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].forEach(key => delete process.env[key]);
process.env.NO_PROXY = '*';

const dataDir = path.join(app.getPath('userData'), 'bili-go');
const authDir = path.join(app.getPath('userData'), 'bili-go-auth');
const cookieFile = path.join(authDir, 'cookies.txt');
const historyFile = path.join(dataDir, 'history.json');
const settingsFile = path.join(dataDir, 'settings.json');
const UPDATE_REPOSITORY = 'https://github.com/Chinsir0214/BiliGo';
const UPDATE_API = 'https://api.github.com/repos/Chinsir0214/BiliGo';
const DOWNLOAD_DEFAULTS = Object.freeze({ containerFormat: 'mp4', filenameTemplate: '%(title)s.%(ext)s', subtitleLangs: 'all', retries: 3, fragmentThreads: 4, maxConcurrentTasks: 1 });
let win;
const activeTasks = new Map();
const downloadQueue = [];
let loginPoll;

function ensureDataDir() { fs.mkdirSync(dataDir, { recursive: true }); }
function ensureAuthDir() { fs.mkdirSync(authDir, { recursive: true }); }
function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...(options.headers || {}) } }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => { if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`请求失败（HTTP ${res.statusCode}）`)); try { const json = JSON.parse(body); resolve(options.withHeaders ? { json, headers: res.headers } : json); } catch (error) { reject(error); } });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('请求超时')));
  });
}
function requestText(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...(options.headers || {}) } }, res => { let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => res.statusCode === 200 ? resolve(body) : reject(new Error(`请求失败（HTTP ${res.statusCode}）`))); });
    req.on('error', reject); req.setTimeout(10000, () => req.destroy(new Error('请求超时')));
  });
}
function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }
function cookieHeader() {
  if (!fs.existsSync(cookieFile)) return '';
  return fs.readFileSync(cookieFile, 'utf8').split('\n').filter(line => line && !line.startsWith('#')).map(line => {
    const fields = line.split('\t'); return fields.length >= 7 ? `${fields[5]}=${fields[6]}` : '';
  }).filter(Boolean).join('; ');
}
function saveCookies(setCookies) {
  ensureAuthDir();
  const rows = ['# Netscape HTTP Cookie File', ...setCookies.map(item => {
    const [pair, ...attrs] = item.split(';'); const [name, ...value] = pair.trim().split('=');
    const domain = attrs.find(x => x.trim().toLowerCase().startsWith('domain='))?.trim().slice(7) || '.bilibili.com';
    const expires = attrs.find(x => x.trim().toLowerCase().startsWith('expires='));
    const expiry = expires ? Math.floor(new Date(expires.split('=').slice(1).join('=')).getTime() / 1000) : 0;
    return `${domain}\tTRUE\t/\tFALSE\t${expiry}\t${name}\t${value.join('=')}`;
  })];
  fs.writeFileSync(cookieFile, rows.join('\n'), 'utf8');
}
function readHistory() { try { const value = JSON.parse(fs.readFileSync(historyFile, 'utf8')); return Array.isArray(value) ? value : []; } catch (_) { try { if (fs.existsSync(historyFile)) fs.renameSync(historyFile, `${historyFile}.corrupt-${Date.now()}`); } catch (_) {} return []; } }
function writeHistory(items) { ensureDataDir(); fs.writeFileSync(historyFile, JSON.stringify(items.slice(0, 100), null, 2), 'utf8'); }
function readSettings() { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch (_) { return {}; } }
function writeSettings(settings) { ensureDataDir(); fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8'); }
function settingNumber(settings, key) { return Number(settings[key] || DOWNLOAD_DEFAULTS[key]); }
function versionParts(value) { return String(value || '0').replace(/^v/i, '').split(/[.-]/).map(part => Number.parseInt(part, 10) || 0); }
function isNewerVersion(latest, current) { const a = versionParts(latest); const b = versionParts(current); for (let index = 0; index < Math.max(a.length, b.length); index += 1) { if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0); } return false; }
async function checkForUpdates() {
  const currentVersion = app.getVersion();
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
function safeName(value) { return String(value || '未命名资源').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || '未命名资源'; }
function safeTemplate(value) { const template = String(value || DOWNLOAD_DEFAULTS.filenameTemplate).replace(/[\\/]/g, '_').replace(/\.\./g, '_').trim(); return template && !path.isAbsolute(template) ? template : DOWNLOAD_DEFAULTS.filenameTemplate; }
function directoryFiles(directory) { try { return fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => path.join(directory, entry.name)); } catch (_) { return []; } }
function fileSnapshot(directory) { return new Map(directoryFiles(directory).map(file => { try { const stat = fs.statSync(file); return [file, `${stat.size}:${stat.mtimeMs}`]; } catch (_) { return [file, '']; } })); }
function fileStats(files) { return files.reduce((total, file) => { try { return total + fs.statSync(file).size; } catch (_) { return total; } }, 0); }
function limitRateArg(value) { const kbps = Number.parseFloat(String(value || '').trim()); return Number.isFinite(kbps) && kbps > 0 ? `${Math.round(kbps * 1000 / 8)}B` : ''; }
function ytdlpDownloadArgs(task) {
  const retries = Math.max(1, Math.min(10, Number(task.retries || DOWNLOAD_DEFAULTS.retries)));
  const threads = Math.max(1, Math.min(16, Number(task.fragmentThreads || DOWNLOAD_DEFAULTS.fragmentThreads)));
  const args = ['--newline', '--no-warnings', '--progress', '--no-playlist', '--proxy', '', '--ffmpeg-location', tools.resolveTool(app, 'ffmpeg'), '--retries', String(retries), '--fragment-retries', String(retries), '-N', String(threads)];
  const limitRate = limitRateArg(task.rateLimit);
  if (limitRate) args.push('--limit-rate', limitRate);
  return args;
}
function downloadRecord(task, destination, modes, status, startedAt, before, error = '') {
  const files = directoryFiles(destination).filter(file => { try { const stat = fs.statSync(file); return !before.has(file) || before.get(file) !== `${stat.size}:${stat.mtimeMs}`; } catch (_) { return false; } });
  const record = { id: task.id, title: task.title, url: task.url, outputDir: destination, file: files[0] || '', files, fileCount: files.length, sizeBytes: fileStats(files), mode: modes.join(','), status, startedAt: new Date(startedAt).toISOString(), completedAt: new Date().toISOString(), durationMs: Date.now() - startedAt };
  if (error) record.error = error;
  return record;
}
function getProfile() {
  const header = cookieHeader();
  if (!header) return Promise.resolve(null);
  return requestJson('https://api.bilibili.com/x/web-interface/nav', { headers: { Cookie: header } }).then(result => result.code === 0 ? { name: result.data.uname, avatar: result.data.face } : null).catch(() => null);
}
async function parseResource(url) {
  const favoriteId = url.match(/[?&]fid=(\d+)/i)?.[1];
  if (favoriteId) {
    try {
      const items = []; let page = 1; let favoriteTitle = '';
      while (page <= 100) {
        const result = await requestJson(`https://api.bilibili.com/x/v3/fav/resource/list?media_id=${favoriteId}&ps=20&pn=${page}&platform=web`, { headers: { Cookie: cookieHeader() } });
        if (result.code !== 0) throw new Error(result.message || '无法读取收藏夹');
        favoriteTitle = result.data?.info?.title || favoriteTitle;
        const medias = result.data?.medias || [];
        items.push(...medias.filter(item => item && item.bvid).map(item => ({ id: item.bvid, title: item.title || '未命名视频', url: `https://www.bilibili.com/video/${item.bvid}`, thumbnail: item.cover || '', duration: item.duration || 0 })));
        if (!result.data?.has_more || !medias.length) break;
        page += 1;
      }
      if (items.length) return { title: favoriteTitle || '收藏夹', thumbnail: items[0].thumbnail, type: 'favorite', items };
    } catch (_) {
      // Fall back to yt-dlp for收藏夹接口不可用或需要登录的情况。
    }
  }
  const bvid = url.match(/BV[a-zA-Z0-9]+/)?.[0];
  if (bvid) {
    try {
      const view = await requestJson(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: { Cookie: cookieHeader() } });
      if (view.code === 0 && view.data) {
        const pages = view.data.pages || [];
        const type = pages.length > 1 ? 'parts' : /favlist|favorite/i.test(url) ? 'favorite' : /collection|medialist|series/i.test(url) ? 'collection' : 'video';
        const items = pages.length ? pages.map((page, index) => ({ id: String(page.cid || index), title: page.part || `第 ${index + 1} 集`, url: `${url.split('?')[0]}?p=${page.page}`, thumbnail: '', duration: page.duration || 0 })) : [{ id: bvid, title: view.data.title || '未命名视频', url, thumbnail: view.data.pic || '', duration: view.data.duration || 0 }];
        return { title: view.data.title || items[0].title, thumbnail: view.data.pic || '', type, items };
      }
    } catch (_) {
      // Fall back to yt-dlp for URLs that are not available through the public API.
    }
  }
  return new Promise((resolve, reject) => {
    const args = ['--dump-single-json', '--skip-download', '--flat-playlist', '--no-warnings', '--socket-timeout', '15', '--proxy', ''];
    if (cookieHeader()) args.push('--add-header', `Cookie: ${cookieHeader()}`);
    args.push(url);
    const child = spawn(tools.resolveTool(app, 'yt-dlp'), args, { windowsHide: true }); let output = ''; let error = ''; let timedOut = false;
    child.stdout.on('data', data => output += data); child.stderr.on('data', data => error += data);
    const timer = setTimeout(() => { timedOut = true; child.kill(); reject(new Error('解析超时，请检查链接或登录状态')); }, 45000);
    child.on('error', error => { clearTimeout(timer); reject(new Error(`解析程序启动失败：${error.message}`)); });
    child.on('close', code => { clearTimeout(timer); if (timedOut) return; if (code !== 0) return reject(new Error(error.split(/\r?\n/).filter(Boolean).pop() || '无法读取视频信息')); try {
      const info = JSON.parse(output); const entries = (info.entries || []).filter(Boolean);
      const resourceType = /favlist|favorite/i.test(url) ? 'favorite' : /collection|medialist|series/i.test(url) ? 'collection' : entries.length > 1 ? 'parts' : 'video';
      const items = entries.length ? entries.map((item, index) => ({ id: item.id || `${index}`, title: item.title || item.fulltitle || `第 ${index + 1} 集`, url: item.webpage_url || item.original_url || (resourceType === 'parts' ? `${url}${url.includes('?') ? '&' : '?'}p=${index + 1}` : item.id ? `https://www.bilibili.com/video/${item.id}` : url), thumbnail: item.thumbnail || '', duration: item.duration || 0 })) : [{ id: info.id || 'video', title: info.title || info.fulltitle || '未命名视频', url: info.webpage_url || url, thumbnail: info.thumbnail || '', duration: info.duration || 0 }];
      resolve({ title: info.playlist_title || info.title || items[0].title, thumbnail: info.thumbnail || items[0].thumbnail || '', type: resourceType, items });
    } catch (_) { reject(new Error('视频信息解析失败')); } });
  });
}
async function downloadDanmaku(url, title, destination) {
  const bvid = url.match(/BV[a-zA-Z0-9]+/)?.[0]; const aid = url.match(/av(\d+)/i)?.[1];
  if (!bvid && !aid) throw new Error('无法从链接中识别视频编号');
  const query = bvid ? `bvid=${bvid}` : `aid=${aid}`;
  const view = await requestJson(`https://api.bilibili.com/x/web-interface/view?${query}`, { headers: { Cookie: cookieHeader() } });
  const page = Number(url.match(/[?&]p=(\d+)/i)?.[1] || 1); const cid = view.data?.pages?.[page - 1]?.cid || view.data?.pages?.[0]?.cid; if (!cid) throw new Error('无法获取视频弹幕');
  const xml = await requestText(`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`, { headers: { Cookie: cookieHeader() } });
  const safeTitle = title.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || '未命名视频'; const file = path.join(destination, `${safeTitle}.xml`); fs.writeFileSync(file, xml, 'utf8'); return file;
}
function throwIfCancelled(task) { if (task.cancelled) throw new Error('下载已取消'); }
function stopTaskProcess(task) { const child = task.process; if (!child || child.killed) return; if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); else child.kill('SIGTERM'); }
async function createLogin() {
  const result = await requestJson('https://passport.bilibili.com/x/passport-login/web/qrcode/generate');
  if (result.code !== 0) throw new Error(result.message || '二维码生成失败');
  clearInterval(loginPoll);
  loginPoll = setInterval(async () => {
    try {
      const pollResponse = await requestJson(`https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(result.data.qrcode_key)}`, { withHeaders: true });
      const poll = pollResponse.json;
      send('login:poll', { code: poll.data?.code, message: poll.data?.message });
      if (poll.data?.code === 0) {
        clearInterval(loginPoll); loginPoll = null;
        const cookies = pollResponse.headers?.['set-cookie'] || [];
        if (cookies.length) saveCookies(cookies);
        send('login:success', { cookie: true, profile: await getProfile() });
      } else if (poll.data?.code === 86090) send('login:expired', {});
    } catch (error) { send('app:error', error.message); }
  }, 2000);
  const qr = QRCode.create(result.data.url, { errorCorrectionLevel: 'M' });
  return { url: result.data.url, key: result.data.qrcode_key, qr: { size: qr.modules.size, data: Array.from(qr.modules.data) } };
}
async function download({ url, urls, itemTitles, title, resourceType, mode, contentModes, videoQuality, audioQuality, outputDir, filenameTemplate, containerFormat, embedThumbnail, embedMetadata, embedChapters, subtitleLangs, rateLimit, retries, fragmentThreads }) {
  ensureDataDir();
  const info = title ? { title } : await parseResource(url);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const settings = readSettings();
  const task = { id, url, urls, itemTitles, title: info.title, thumbnail: info.thumbnail, resourceType, contentModes: contentModes?.length ? contentModes : [mode || 'video-audio'], videoQuality, audioQuality, outputDir, filenameTemplate: filenameTemplate || settings.filenameTemplate || DOWNLOAD_DEFAULTS.filenameTemplate, containerFormat: containerFormat || settings.containerFormat || DOWNLOAD_DEFAULTS.containerFormat, embedThumbnail: embedThumbnail ?? settings.embedThumbnail, embedMetadata: embedMetadata ?? settings.embedMetadata, embedChapters: embedChapters ?? settings.embedChapters, subtitleLangs: subtitleLangs || settings.subtitleLangs || DOWNLOAD_DEFAULTS.subtitleLangs, rateLimit: rateLimit ?? settings.rateLimit, retries: retries || settings.retries || DOWNLOAD_DEFAULTS.retries, fragmentThreads: Number(fragmentThreads || settings.fragmentThreads || DOWNLOAD_DEFAULTS.fragmentThreads), queuedAt: new Date().toISOString() };
  downloadQueue.push(task);
  processDownloadQueue();
  return { id, title: info.title, thumbnail: info.thumbnail, queued: true, position: downloadQueue.length + activeTasks.size };
}

function processDownloadQueue() {
  const maxConcurrentTasks = Math.max(1, Math.min(10, settingNumber(readSettings(), 'maxConcurrentTasks')));
  while (activeTasks.size < maxConcurrentTasks && downloadQueue.length) {
    const task = downloadQueue.shift();
    activeTasks.set(task.id, task);
    runDownloadTask(task);
  }
}

function runDownloadTask(task) {
  (async () => {
    const startedAt = Date.now();
    const destinationRoot = task.outputDir || readSettings().downloadDir || path.join(app.getPath('downloads'), 'BiliGo');
    const destination = task.resourceType && task.resourceType !== 'video' ? path.join(destinationRoot, safeName(task.title)) : destinationRoot;
    const downloadUrls = task.urls?.length ? task.urls : [task.url];
    const modes = task.contentModes;
    fs.mkdirSync(destination, { recursive: true });
    const before = fileSnapshot(destination);
    const runYtdlp = args => new Promise((resolve, reject) => {
      const cookie = cookieHeader();
      if (cookie) args.push('--add-header', `Cookie: ${cookie}`);
      args.push(...downloadUrls);
      task.process = spawn(tools.resolveTool(app, 'yt-dlp'), args, { windowsHide: true });
      const process = task.process;
      const parse = chunk => chunk.toString().split(/\r?\n/).filter(Boolean).forEach(line => { const percent = line.match(/(\d+(?:\.\d+)?)%/); const speed = line.match(/at\s+([^\s]+\/s)/); const eta = line.match(/ETA\s+([^\s]+)/); send('download:progress', { id: task.id, line, percent: percent ? Number(percent[1]) : null, speed: speed?.[1] || '', eta: eta?.[1] || '' }); });
      process.stdout.on('data', parse); process.stderr.on('data', parse);
      process.on('error', reject);
      process.on('close', code => { task.process = null; code === 0 ? resolve() : reject(new Error(task.cancelled ? '下载已取消' : '下载失败，请检查链接、登录状态或任务设置')); });
    });
    const common = ytdlpDownloadArgs(task);
    const template = safeTemplate(task.filenameTemplate);
    const output = path.join(destination, template);
    const media = modes.includes('video-audio') || modes.includes('video') || modes.includes('audio');
    let record;
    try {
      if (modes.includes('danmaku')) for (let index = 0; index < downloadUrls.length; index += 1) { throwIfCancelled(task); await downloadDanmaku(downloadUrls[index], task.itemTitles?.[index] || task.title, destination); }
      throwIfCancelled(task);
      if (media) {
        const args = [...common];
        if (modes.includes('audio') && !modes.includes('video-audio') && !modes.includes('video')) args.push('-f', task.audioQuality || 'ba/b', '-x', '--audio-format', 'mp3');
        else if (modes.includes('video') && !modes.includes('video-audio')) args.push('-f', task.videoQuality || 'bv*');
        else args.push('-f', `${task.videoQuality || 'bv*'}+${task.audioQuality || 'ba/b'}`, '--merge-output-format', task.containerFormat || 'mp4');
        if (task.embedMetadata) args.push('--embed-metadata');
        if (task.embedChapters) args.push('--embed-chapters');
        if (task.embedThumbnail) args.push('--embed-thumbnail');
        args.push('-o', output); await runYtdlp(args);
      }
      if (modes.includes('cover')) await runYtdlp([...common, '--skip-download', '--write-thumbnail', '--convert-thumbnails', 'jpg', '-o', output]);
      if (modes.includes('subtitle')) await runYtdlp([...common, '--skip-download', '--write-subs', '--sub-langs', task.subtitleLangs || 'all', '--sub-format', 'vtt', '-o', output]);
      record = downloadRecord(task, destination, modes, 'completed', startedAt, before);
      writeHistory([record, ...readHistory().filter(item => item.id !== task.id)]);
      send('download:done', { id: task.id, code: 0, record });
    } catch (error) {
      record = downloadRecord(task, destination, modes, task.cancelled ? 'cancelled' : 'failed', startedAt, before, error.message);
      writeHistory([record, ...readHistory().filter(item => item.id !== task.id)]);
      send('download:done', { id: task.id, code: task.cancelled ? 2 : 1, record });
    } finally { task.process = null; activeTasks.delete(task.id); processDownloadQueue(); }
  })();
}

function createWindow() {
  win = new BrowserWindow({ width: 1360, height: 920, minWidth: 360, minHeight: 560, backgroundColor: '#f7f7f5', autoHideMenuBar: true, titleBarStyle: 'hidden', titleBarOverlay: { color: '#f7f7f5', symbolColor: '#191919', height: 32 }, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  win.setMenuBarVisibility(false);
  win.webContents.on('preload-error', (_, preloadPath, error) => console.error(`Preload 加载失败: ${preloadPath}`, error));
  win.loadFile(path.join(__dirname, 'index.html'));
}
app.whenReady().then(async () => { await session.defaultSession.setProxy({ mode: 'direct' }); ensureDataDir(); createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); });
app.on('before-quit', () => { clearInterval(loginPoll); loginPoll = null; for (const task of activeTasks.values()) { task.cancelled = true; stopTaskProcess(task); } });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
ipcMain.handle('login:start', createLogin);
ipcMain.handle('login:status', async () => ({ loggedIn: fs.existsSync(cookieFile) && cookieHeader().length > 0, profile: await getProfile() }));
ipcMain.handle('login:logout', () => { if (fs.existsSync(cookieFile)) fs.unlinkSync(cookieFile); return true; });
ipcMain.handle('resource:parse', (_, url) => parseResource(url));
ipcMain.handle('update:check', checkForUpdates);
ipcMain.handle('download:start', (_, data) => download(data));
ipcMain.handle('download:cancel', (_, id) => {
  const queued = downloadQueue.findIndex(task => task.id === id);
  if (queued >= 0) { const [task] = downloadQueue.splice(queued, 1); task.cancelled = true; const record = { id, title: task.title, url: task.url, mode: task.contentModes.join(','), status: 'cancelled', file: '', files: [], fileCount: 0, sizeBytes: 0, completedAt: new Date().toISOString() }; writeHistory([record, ...readHistory().filter(item => item.id !== id)]); send('download:done', { id, code: 2, record }); return true; }
  const active = activeTasks.get(id);
  if (active) { active.cancelled = true; stopTaskProcess(active); return true; }
  return false;
});
ipcMain.handle('history:list', () => readHistory());
ipcMain.handle('history:clear', () => { writeHistory([]); return true; });
ipcMain.handle('history:remove', (_, ids) => { const remove = new Set(ids || []); writeHistory(readHistory().filter(item => !remove.has(item.id))); return true; });
ipcMain.handle('shell:open', (_, target) => shell.openPath(target || readSettings().downloadDir || path.join(app.getPath('downloads'), 'BiliGo')));
ipcMain.handle('video:play-local', (_, file) => shell.openPath(file || ''));
ipcMain.handle('clipboard:write', (_, value) => { clipboard.writeText(String(value || '')); return true; });
ipcMain.handle('settings:get', () => { const settings = readSettings(); return { downloadDir: settings.downloadDir || path.join(app.getPath('downloads'), 'BiliGo'), showThumbnails: settings.showThumbnails === true, fragmentThreads: Math.max(1, Math.min(16, settingNumber(settings, 'fragmentThreads'))), maxConcurrentTasks: Math.max(1, Math.min(10, settingNumber(settings, 'maxConcurrentTasks'))), containerFormat: settings.containerFormat || DOWNLOAD_DEFAULTS.containerFormat, filenameTemplate: settings.filenameTemplate || DOWNLOAD_DEFAULTS.filenameTemplate, subtitleLangs: settings.subtitleLangs || DOWNLOAD_DEFAULTS.subtitleLangs, rateLimit: settings.rateLimit || '', retries: settings.retries || String(DOWNLOAD_DEFAULTS.retries), embedThumbnail: settings.embedThumbnail === true, embedMetadata: settings.embedMetadata === true, embedChapters: settings.embedChapters === true }; });
ipcMain.handle('settings:set', (_, changes) => { const current = readSettings(); const next = { ...current, ...changes }; if (changes.fragmentThreads !== undefined) next.fragmentThreads = Math.max(1, Math.min(16, Number(changes.fragmentThreads) || 4)); if (changes.maxConcurrentTasks !== undefined) next.maxConcurrentTasks = Math.max(1, Math.min(10, Number(changes.maxConcurrentTasks) || 1)); writeSettings(next); return true; });
ipcMain.handle('settings:reset', () => { const defaults = { downloadDir: path.join(app.getPath('downloads'), 'BiliGo'), showThumbnails: false, fragmentThreads: DOWNLOAD_DEFAULTS.fragmentThreads, maxConcurrentTasks: DOWNLOAD_DEFAULTS.maxConcurrentTasks, containerFormat: DOWNLOAD_DEFAULTS.containerFormat, filenameTemplate: DOWNLOAD_DEFAULTS.filenameTemplate, subtitleLangs: DOWNLOAD_DEFAULTS.subtitleLangs, rateLimit: '', retries: String(DOWNLOAD_DEFAULTS.retries), embedThumbnail: false, embedMetadata: false, embedChapters: false }; writeSettings(defaults); return defaults; });
ipcMain.handle('settings:chooseDir', async () => { const { dialog } = require('electron'); const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] }); if (result.canceled || !result.filePaths[0]) return null; const downloadDir = result.filePaths[0]; writeSettings({ ...readSettings(), downloadDir }); return downloadDir; });
ipcMain.handle('video:open', (_, url) => shell.openExternal(url));
