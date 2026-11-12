const { app, BrowserWindow, ipcMain, shell, session, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const QRCode = require('qrcode');
const { autoUpdater } = require('electron-updater');
const tools = require('./tools');
const { DOWNLOAD_DEFAULTS } = require('./download/constants');
const { ytdlpDownloadArgs, audioFormatArgs } = require('./download/formats');
const { validateDownloadData } = require('./download/request');
const { createDownloadTask, serializeTaskForQueue } = require('./download/task');
const { createDownloadQueue } = require('./download/queue');
const { createQueueStore } = require('./download/queue-store');
const { createDownloadExecutor } = require('./download/executor');
const { createDanmakuDownloader } = require('./download/danmaku');
const { collectAllowedLocalRoots } = require('./download/allowed-roots');
const { resolveTaskDestination } = require('./download/destination');
const { getMediaCapabilities, normalizeContentModes } = require('./download/options');
const { createUpdateChecker } = require('./update');
const { createTaskWorkspace } = require('./download/file-workspace');
const { createResourceParser, subtitleLanguages } = require('./resource/parser');
const { createAuthSession } = require('./auth/session');
const { resolveLoginCookies } = require('./auth/login-cookies');
const { assertBilibiliUrl, assertExternalUrl, isAllowedLocalPath: pathAllowedInRoots } = require('./security');
const { defaults: defaultSettings, normalizeSettings, applySettingsChanges } = require('./settings');
const { createLocalDataReader } = require('./local-data');


const dataDir = path.join(app.getPath('userData'), 'bili-go');
const authDir = path.join(app.getPath('userData'), 'bili-go-auth');
const cookieFile = path.join(authDir, 'cookies.txt');
const profileFile = path.join(authDir, 'profile.json');
const historyFile = path.join(dataDir, 'history.json');
const settingsFile = path.join(dataDir, 'settings.json');
const queueFile = path.join(dataDir, 'queue.json');
const logDir = path.join(dataDir, 'logs');
const logFile = path.join(logDir, 'biligo.log');
const MAX_JSON_BYTES = 5 * 1024 * 1024;
let win;
let rendererReady = false;
const pendingAppErrors = new Set();
let queueLoaded = false;
let maxConcurrentTasks = DOWNLOAD_DEFAULTS.maxConcurrentTasks;
// Users review and install releases from the project page.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

function ensureDataDir() { fs.mkdirSync(dataDir, { recursive: true }); }
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
function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }
function reportAppError(message) {
  if (rendererReady) send('app:error', message);
  else pendingAppErrors.add(message);
}
const { cookieHeader, pushCookieArgs, getProfile, createLogin, cancelLogin, logout, shutdown } = createAuthSession({ cookieFile, profileFile, requestJson, resolveLoginCookies, send, log, QRCode });
const localData = createLocalDataReader();
function readLocalData(read, file) {
  try { return read(file); }
  catch (error) { log('error', error.message); throw error; }
}
function readHistory() { return readLocalData(localData.readHistory, historyFile); }
function writeHistory(items) { ensureDataDir(); fs.writeFileSync(historyFile, JSON.stringify(items.slice(0, 100), null, 2), 'utf8'); }
function saveDownloadRecord(record) {
  try { writeHistory([record, ...readHistory().filter(item => item.id !== record.id)]); }
  catch (error) { log('error', `保存任务记录失败 ${record.id}: ${error.message}`); reportAppError(`任务记录保存失败：${error.message}`); }
}
function readSettings() { return readLocalData(localData.readSettings, settingsFile); }
function writeSettings(settings) { ensureDataDir(); fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8'); }
function defaultDownloadDir() { return path.join(app.getPath('downloads'), 'BiliGo'); }
function getSettings() {
  const settings = normalizeSettings(readSettings(), defaultDownloadDir());
  // Running tasks keep their last validated limit if a later settings read fails.
  maxConcurrentTasks = settings.maxConcurrentTasks;
  return settings;
}
async function playerSubtitleLanguages(bvid, cid) {
  try {
    const result = await requestJson(`https://api.bilibili.com/x/player/wbi/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}`, { headers: { Cookie: cookieHeader() } });
    return subtitleLanguages(result.data?.subtitle?.subtitles || result.data?.subtitle?.list);
  } catch (_) { return []; }
}
const checkForUpdates = createUpdateChecker({ getCurrentVersion: () => app.getVersion(), checkForUpdates: () => autoUpdater.checkForUpdates(), requestJson });
function safeName(value) {
  const name = String(value || '未命名资源').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim().replace(/[. ]+$/g, '');
  if (!name || name.toLowerCase() === '.biligo-staging') return '未命名资源';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `_${name}` : name;
}
function safeTemplate(value) { const template = String(value || DOWNLOAD_DEFAULTS.filenameTemplate).replace(/[\\/]/g, '_').replace(/\.\./g, '_').trim(); return template && !path.isAbsolute(template) ? template : DOWNLOAD_DEFAULTS.filenameTemplate; }
function fileStats(files) { return files.reduce((total, file) => { try { return total + fs.statSync(file).size; } catch (_) { return total; } }, 0); }
function allowedLocalRoots() {
  return collectAllowedLocalRoots({
    settingsDownloadDir: getSettings().downloadDir,
    defaultDownloadDir: path.join(app.getPath('downloads'), 'BiliGo'),
    history: readHistory(),
    tasks: [...downloadManager.activeTasks.values(), ...downloadManager.downloadQueue],
    safeName
  });
}
function isAllowedLocalPath(target) {
  return pathAllowedInRoots(target, allowedLocalRoots());
}
function primaryDownloadFile(files) {
  const mediaExtensions = ['.mp4', '.mkv', '.webm', '.mov', '.m4a', '.mp3', '.flac', '.wav', '.aac', '.ogg', '.opus'];
  return files.find(file => mediaExtensions.includes(path.extname(file).toLowerCase())) || files[0] || '';
}
function downloadRecord(task, destination, modes, status, startedAt, files, error = '') {
  const record = { id: task.id, title: task.title, url: task.url, outputDir: destination, file: primaryDownloadFile(files), files, fileCount: files.length, sizeBytes: fileStats(files), mode: modes.join(','), status, startedAt: new Date(startedAt).toISOString(), completedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, retryTask: serializeTaskForQueue(task) };
  if (error) record.error = error;
  return record;
}
const { parseResource } = createResourceParser({ requestJson, cookieHeader, playerSubtitleLanguages, assertBilibiliUrl, pushCookieArgs, spawn, resolveYtdlp: () => tools.resolveTool('yt-dlp'), log });
const { downloadDanmaku } = createDanmakuDownloader({ requestJson, cookieHeader, fs, path, safeName });
function throwIfCancelled(task) { if (task.cancelled) throw new Error('下载已取消'); }
const downloadExecutor = createDownloadExecutor({
  resolveYtdlp: () => tools.resolveTool('yt-dlp'),
  pushCookieArgs,
  send
});
const queueStore = createQueueStore(queueFile);
function restoreDownloadRequest(request) {
  // Older tasks could inherit embedSubs from settings even for non-video modes.
  if (request.embedSubs !== true) return request;
  const modes = normalizeContentModes(request.contentModes, request.mode ? [request.mode] : []);
  return getMediaCapabilities(modes).hasVideo ? request : { ...request, embedSubs: false };
}
function readRestoredTasks() {
  const settings = getSettings();
  const defaultDir = settings.downloadDir || path.join(app.getPath('downloads'), 'BiliGo');
  return queueStore.read(item => {
    if (typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(item.id)) throw new Error('任务 ID 无效');
    const data = validateDownloadData(restoreDownloadRequest({ ...item, outputDir: item.outputDir || defaultDir }), {
      assertBilibiliUrl,
      // These paths were selected when the task was queued; the active setting may have changed since then.
      isAllowedLocalPath: target => path.isAbsolute(target)
    });
    const restored = { ...data, filenameTemplate: safeTemplate(data.filenameTemplate) };
    for (const key of ['embedThumbnail', 'embedMetadata', 'embedChapters', 'embedSubs']) restored[key] = data[key] === true;
    const task = createDownloadTask(restored, { title: String(item.title || '未命名资源'), thumbnail: String(item.thumbnail || '') }, settings, item.id);
    task.queuedAt = item.queuedAt || task.queuedAt;
    return task;
  });
}
const downloadManager = createDownloadQueue({
  read: readRestoredTasks,
  write: queueStore.write,
  serialize: serializeTaskForQueue,
  processTask: runDownloadTask,
  maxConcurrency: () => maxConcurrentTasks,
  onTaskError: (task, error) => {
    log('error', `任务处理异常 ${task.id}: ${error.message}`);
    reportAppError(`任务处理异常：${task.title || task.id}`);
  },
  onPersistenceError: error => {
    const message = `保存下载队列失败，应用将重试：${error.message}`;
    log('error', message);
    reportAppError(message);
  }
});
function ensureQueueLoaded() {
  if (queueLoaded) return;
  downloadManager.load();
  queueLoaded = true;
}
async function download(request) {
  const data = validateDownloadData(request, { assertBilibiliUrl, isAllowedLocalPath });
  ensureQueueLoaded();
  ensureDataDir();
  const info = data.title ? { title: data.title } : await parseResource(data.url);
  const settings = getSettings();
  const pinnedOutputDir = data.outputDir || settings.downloadDir || path.join(app.getPath('downloads'), 'BiliGo');
  const task = createDownloadTask({
    ...data,
    outputDir: pinnedOutputDir,
    ...(data.filenameTemplate ? { filenameTemplate: safeTemplate(data.filenameTemplate) } : {})
  }, info, settings);
  const position = downloadManager.enqueue(task);
  return { id: task.id, title: info.title, thumbnail: info.thumbnail, url: task.url, mode: task.contentModes.join(','), queued: true, position };
}

async function runDownloadTask(task) {
  const startedAt = Date.now();
  const destinationRoot = task.outputDir || getSettings().downloadDir;
  const destination = resolveTaskDestination({ ...task, outputDir: destinationRoot }, safeName);
  const downloadUrls = task.urls?.length ? task.urls : [task.url];
  const modes = task.contentModes;
  const { mediaMode, hasVideo, hasMedia } = getMediaCapabilities(modes);
  const embedSubs = task.embedSubs && hasVideo;
  let workspace;
  log('info', `下载任务开始 ${task.id}: ${task.title}`);
  try {
    workspace = createTaskWorkspace({ destinationRoot, taskId: task.id });
    const runYtdlp = args => downloadExecutor.run(task, args, downloadUrls);
    const common = ytdlpDownloadArgs(task, modes, () => tools.resolveTool('ffmpeg'));
    const output = path.join(workspace.stageDir, safeTemplate(task.filenameTemplate));

    if (modes.includes('danmaku')) for (let index = 0; index < downloadUrls.length; index += 1) { throwIfCancelled(task); await downloadDanmaku(downloadUrls[index], task.itemTitles?.[index] || task.title, workspace.stageDir); }
    throwIfCancelled(task);
    if (hasMedia) {
      const args = [...common];
      if (mediaMode === 'audio') audioFormatArgs(task, args);
      else if (mediaMode === 'video') args.push('-f', task.videoQuality === 'bv*' ? 'bv' : task.videoQuality || 'bv');
      else args.push('-f', `${task.videoQuality === 'bv*' ? 'bv' : task.videoQuality || 'bv'}+${task.audioQuality || 'ba/b'}`, '--merge-output-format', task.containerFormat || 'mp4');
      if (task.embedThumbnail) args.push('--embed-thumbnail');
      if (task.embedMetadata) args.push('--add-metadata');
      if (task.embedChapters) args.push('--embed-chapters');
      if (embedSubs) args.push('--write-subs', '--embed-subs', '--sub-langs', task.subtitleLangs || 'all', '--sub-format', 'vtt');
      args.push('-o', output); await runYtdlp(args);
    }
    throwIfCancelled(task);
    if (modes.includes('cover')) await runYtdlp([...common, '--skip-download', '--write-thumbnail', '--convert-thumbnails', 'jpg', '-o', output]);
    throwIfCancelled(task);
    if (modes.includes('subtitle') && !embedSubs) {
      await runYtdlp([...common, '--write-subs', '--sub-langs', task.subtitleLangs || 'all', '--sub-format', 'vtt', '--skip-download', '-o', output]);
    }
    throwIfCancelled(task);

    const files = workspace.commit(destination);
    task.finalized = true;
    try { downloadManager.save(); } catch (error) { log('error', `保存队列状态失败 ${task.id}: ${error.message}`); }
    const record = downloadRecord(task, destination, modes, 'completed', startedAt, files);
    saveDownloadRecord(record);
    log('info', `下载任务完成 ${task.id}: ${task.title}`);
    send('download:done', { id: task.id, code: 0, record });
  } catch (error) {
    try { workspace?.cleanup(); } catch (cleanupError) { log('error', `清理任务临时目录失败 ${task.id}: ${cleanupError.message}`); }
    if (task.interrupted) return;
    const status = task.cancelled ? 'cancelled' : 'failed';
    const record = downloadRecord(task, destination, modes, status, startedAt, error.committedFiles || [], error.message);
    saveDownloadRecord(record);
    log('error', `下载任务${task.cancelled ? '取消' : '失败'} ${task.id}: ${task.title} - ${error.message}`);
    send('download:done', { id: task.id, code: task.cancelled ? 2 : 1, record });
  } finally {
    task.process = null;
  }
}

function createWindow() {
  rendererReady = false;
  win = new BrowserWindow({ width: 1360, height: 920, minWidth: 1000, minHeight: 700, icon: path.join(__dirname, '..', 'assets', 'icon.png'), backgroundColor: '#f7f7f5', autoHideMenuBar: true, titleBarStyle: 'hidden', titleBarOverlay: { color: '#f7f7f5', symbolColor: '#191919', height: 32 }, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('preload-error', (_, preloadPath, error) => console.error(`Preload 加载失败: ${preloadPath}`, error));
  win.webContents.on('did-finish-load', () => {
    rendererReady = true;
    for (const message of pendingAppErrors) send('app:error', message);
    pendingAppErrors.clear();
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}
app.whenReady().then(async () => {
  createWindow();
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['https://*.hdslb.com/*', 'https://*.biliimg.com/*'] }, (details, callback) => {
    const headers = details.requestHeaders || {};
    headers.Referer = 'https://www.bilibili.com/';
    headers['User-Agent'] = headers['User-Agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    callback({ requestHeaders: headers });
  });
  try {
    ensureDataDir();
    ensureQueueLoaded();
    downloadManager.pump();
  } catch (error) {
    log('error', `恢复下载队列失败：${error.message}`);
    reportAppError(`恢复下载队列失败：${error.message}。请修复后重新启动应用`);
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('before-quit', () => {
  shutdown();
  for (const task of downloadManager.activeTasks.values()) if (!task.finalized) task.interrupted = true;
  if (queueLoaded) {
    try { downloadManager.requeueActive(downloadExecutor.stop); }
    catch (error) { log('error', `退出时保存下载队列失败：${error.message}`); }
  }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
ipcMain.handle('login:start', createLogin);
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('login:cancel', cancelLogin);
ipcMain.handle('login:status', async () => { const profile = await getProfile(); return { loggedIn: Boolean(profile), profile }; });
ipcMain.handle('login:logout', logout);
ipcMain.handle('resource:parse', (_, url) => parseResource(url));
ipcMain.handle('update:check', checkForUpdates);
ipcMain.handle('download:start', (_, data) => download(data));
ipcMain.handle('queue:list', () => { ensureQueueLoaded(); return [...downloadManager.activeTasks.values(), ...downloadManager.downloadQueue].map(task => ({ id: task.id, title: task.title, url: task.url, mode: task.contentModes.join(','), outputDir: task.outputDir, queuedAt: task.queuedAt, status: downloadManager.activeTasks.has(task.id) ? 'downloading' : 'queued' })); });
ipcMain.handle('download:retry', (_, id) => {
  const item = readHistory().find(record => record.id === id);
  if (!item?.retryTask) throw new Error('这条记录没有可重试的下载配置');
  return download(restoreDownloadRequest(item.retryTask));
});
ipcMain.handle('download:cancel', (_, id) => {
  ensureQueueLoaded();
  const task = downloadManager.cancelQueued(id);
  if (task) { const record = { id, title: task.title, url: task.url, mode: task.contentModes.join(','), status: 'cancelled', file: '', files: [], fileCount: 0, sizeBytes: 0, completedAt: new Date().toISOString() }; saveDownloadRecord(record); send('download:done', { id, code: 2, record }); return true; }
  const active = downloadManager.activeTasks.get(id);
  if (active && !active.finalized) {
    active.cancelled = true;
    try { downloadManager.save(); } catch (error) { active.cancelled = false; throw error; }
    downloadExecutor.stop(active);
    return true;
  }
  return false;
});
ipcMain.handle('history:list', () => readHistory());
ipcMain.handle('history:clear', () => { writeHistory([]); return true; });
ipcMain.handle('history:remove', (_, ids) => { const remove = new Set(ids || []); writeHistory(readHistory().filter(item => !remove.has(item.id))); return true; });
ipcMain.handle('shell:open', (_, target) => {
  const resolved = target || getSettings().downloadDir;
  if (!isAllowedLocalPath(resolved)) throw new Error('不允许打开该路径');
  return shell.openPath(resolved);
});
ipcMain.handle('video:play-local', (_, file) => {
  const resolved = file || '';
  if (!resolved || !isAllowedLocalPath(resolved) || !fs.existsSync(resolved) || !/\.(mp4|mkv|webm|mov|m4a|mp3|flac|wav|aac|ogg|opus)$/i.test(resolved)) throw new Error('文件不可用或不允许打开');
  return shell.openPath(resolved);
});
ipcMain.handle('clipboard:write', (_, value) => { clipboard.writeText(String(value || '')); return true; });
ipcMain.handle('settings:get', () => getSettings());
ipcMain.handle('settings:set', (_, changes) => {
  const next = applySettingsChanges(readSettings(), changes, defaultDownloadDir(), directory => {
    try { return fs.statSync(directory).isDirectory(); } catch (_) { return false; }
  });
  writeSettings(next); maxConcurrentTasks = next.maxConcurrentTasks; return true;
});
ipcMain.handle('settings:reset', () => { const settings = defaultSettings(defaultDownloadDir()); writeSettings(settings); maxConcurrentTasks = settings.maxConcurrentTasks; return settings; });
ipcMain.handle('settings:chooseDir', async () => { const { dialog } = require('electron'); const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] }); if (result.canceled || !result.filePaths[0]) return null; const downloadDir = result.filePaths[0]; writeSettings({ ...getSettings(), downloadDir }); return downloadDir; });
ipcMain.handle('video:open', (_, url) => {
  return shell.openExternal(assertExternalUrl(url));
});
