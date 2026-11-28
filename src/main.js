const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const httpClient = require('./infra/http-client');
const { resolveLoginCookies } = require('./auth/login-cookies');
const { safeName } = require('./download/destination');
const { assertBilibiliUrl, assertExternalUrl } = require('./security');

function createAppRuntime(overrides = {}) {
  const electron = overrides.electron || (overrides.app ? overrides : require('electron'));
  const { app, BrowserWindow, ipcMain, session, shell, clipboard, dialog } = electron;
  const {
    process: runtimeProcess = process,
    createLogger = require('./infra/logger').createLogger,
    createAuthSession = require('./auth/session').createAuthSession,
    createResourceParser = require('./resource/parser').createResourceParser,
    createDanmakuDownloader = require('./download/danmaku').createDanmakuDownloader,
    createDownloadExecutor = require('./download/executor').createDownloadExecutor,
    createQueueStore = require('./download/queue-store').createQueueStore,
    createTaskWorkspace = require('./download/file-workspace').createTaskWorkspace,
    createLocalDataReader = require('./local-data').createLocalDataReader,
    createDownloadService = require('./services/download-service').createDownloadService,
    createUpdateChecker = require('./update').createUpdateChecker,
    registerHandlers = require('./ipc/register-handlers').registerHandlers,
    resolveTool = require('./tools').resolveTool,
    requestJson = httpClient.requestJson,
    requestJsonWithHeaders = httpClient.requestJsonWithHeaders,
    requestHeaders = httpClient.requestHeaders
  } = overrides;

  let win = null;
  let rendererReady = false;
  let startup;
  const pendingAppErrors = new Set();

  function getWindow() {
    return win;
  }

  function isTrustedSender(event) {
    return Boolean(win && !win.isDestroyed() && event?.sender && event.sender === win.webContents);
  }

  function send(channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  function reportAppError(message) {
    if (rendererReady) send('app:error', message);
    else pendingAppErrors.add(message);
  }

  async function startPrimaryInstance() {
    if (!app.requestSingleInstanceLock()) {
      app.quit();
      return;
    }

    const userData = app.getPath('userData');
    const dataDir = path.join(userData, 'bili-go');
    const authDir = path.join(userData, 'bili-go-auth');
    const logger = createLogger({ logPath: path.join(dataDir, 'logs', 'biligo.log') });
    const { log } = logger;

    runtimeProcess.on('uncaughtException', err => log('error', '未捕获异常', err));
    runtimeProcess.on('unhandledRejection', err => log('error', '未处理 Promise 拒绝', err));

    const authSession = createAuthSession({
      cookieFile: path.join(authDir, 'cookies.txt'),
      profileFile: path.join(authDir, 'profile.json'),
      requestJson, requestJsonWithHeaders, resolveLoginCookies, send, log,
      QRCode: { create: (...args) => require('qrcode').create(...args) }
    });
    const { cookieHeader, pushCookieArgs } = authSession;
    const resolveYtdlp = () => resolveTool('yt-dlp');
    const resourceParser = createResourceParser({
      requestJson, requestHeaders, cookieHeader, assertBilibiliUrl, pushCookieArgs,
      spawn, resolveYtdlp, log
    });
    const danmakuDownloader = createDanmakuDownloader({ requestJson, cookieHeader, fs, path, safeName });
    const downloadExecutor = createDownloadExecutor({ resolveYtdlp, pushCookieArgs, send });
    const downloads = createDownloadService({
      dataDir,
      defaultDownloadDir: path.join(app.getPath('downloads'), 'BiliGo'),
      log, send, reportAppError,
      parseResource: resourceParser.parseResource,
      downloadDanmaku: danmakuDownloader.downloadDanmaku,
      downloadExecutor,
      resolveFfmpeg: () => resolveTool('ffmpeg'),
      localData: createLocalDataReader(),
      queueStore: createQueueStore(path.join(dataDir, 'queue.json')),
      makeWorkspace: createTaskWorkspace
    });
    const checkForUpdates = createUpdateChecker({
      getCurrentVersion: () => app.getVersion(),
      checkForUpdates: () => {
        const { autoUpdater } = require('electron-updater');
        autoUpdater.autoDownload = false;
        autoUpdater.autoInstallOnAppQuit = false;
        return autoUpdater.checkForUpdates();
      },
      requestJson, log, assertExternalUrl
    });

    let resumed = false;
    let quitting = false;
    let shutdownComplete = false;

    function createWindow() {
      rendererReady = false;
      win = new BrowserWindow({
        width: 1360, height: 920, minWidth: 1000, minHeight: 700,
        icon: path.join(__dirname, '..', 'assets', 'icon.png'),
        backgroundColor: '#f7f7f5',
        autoHideMenuBar: true,
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: '#f7f7f5', symbolColor: '#191919', height: 32 },
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
          contextIsolation: true, nodeIntegration: false, sandbox: true
        }
      });
      win.on('closed', () => {
        win = null;
        rendererReady = false;
      });
      win.setMenuBarVisibility(false);
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', event => event.preventDefault());
      win.webContents.on('preload-error', (_, preloadPath, error) => {
        log('error', `Preload 加载失败：${preloadPath}`, error);
      });
      win.webContents.on('render-process-gone', (_, details) => {
        rendererReady = false;
        log('error', `渲染进程已退出：${details.reason}（${details.exitCode}）`);
      });
      win.webContents.on('did-start-loading', () => { rendererReady = false; });
      win.webContents.on('did-finish-load', async () => {
        rendererReady = true;
        for (const message of pendingAppErrors) send('app:error', message);
        pendingAppErrors.clear();
        if (resumed || quitting) return;
        resumed = true;
        try {
          await downloads.resume();
        } catch (error) {
          log('error', '恢复下载队列失败', error);
          reportAppError(`恢复下载队列失败：${error?.message || String(error)}。请修复后重新启动应用`);
        }
      });
      win.loadFile(path.join(__dirname, 'index.html'));
    }

    registerHandlers({
      ipcMain, isTrustedSender, app, authSession, resourceParser, downloads,
      checkForUpdates, shell, clipboard, dialog, getWindow
    });

    app.on('second-instance', () => {
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });
    app.on('window-all-closed', () => {
      if (runtimeProcess.platform !== 'darwin') app.quit();
    });
    app.on('before-quit', event => {
      if (shutdownComplete) return;
      event.preventDefault();
      if (quitting) return;
      quitting = true;

      const shutdowns = [
        () => resourceParser.shutdown(),
        () => danmakuDownloader.shutdown(),
        () => authSession.shutdown(),
        () => downloads.shutdown()
      ];
      const drained = Promise.all(shutdowns.map(async shutdown => {
        try {
          await shutdown();
        } catch (error) {
          log('error', '退出时清理服务失败', error);
        }
      }));
      let timer;
      const deadline = new Promise(resolve => {
        timer = setTimeout(() => {
          log('warn', '退出时等待服务清理超时');
          resolve();
        }, 5000);
      });
      Promise.race([drained, deadline]).finally(() => {
        clearTimeout(timer);
        shutdownComplete = true;
        try {
          logger.flushSync();
        } finally {
          app.quit();
        }
      });
    });

    await app.whenReady();
    if (quitting) return;
    const { defaultSession } = session;
    defaultSession.setPermissionRequestHandler((_, __, cb) => cb(false));
    defaultSession.setPermissionCheckHandler(() => false);
    app.on('web-contents-created', (_, contents) => {
      contents.on('will-attach-webview', event => event.preventDefault());
    });
    defaultSession.webRequest.onBeforeSendHeaders({
      urls: ['https://*.hdslb.com/*', 'https://*.biliimg.com/*']
    }, (details, callback) => {
      const headers = { ...details.requestHeaders };
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === 'referer' || name.toLowerCase() === 'user-agent') delete headers[name];
      }
      headers.Referer = 'https://www.bilibili.com/';
      headers['User-Agent'] = httpClient.DESKTOP_USER_AGENT;
      callback({ requestHeaders: headers });
    });
    app.on('activate', () => {
      if (!quitting && !win) createWindow();
    });
    createWindow();
  }

  function start() {
    startup ??= startPrimaryInstance();
    return startup;
  }

  return { start, getWindow, isTrustedSender };
}

module.exports = { createAppRuntime };

if (require.main === module) {
  createAppRuntime().start();
}
