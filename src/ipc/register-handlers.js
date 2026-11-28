const fs = require('node:fs');
const path = require('node:path');
const { assertExternalUrl } = require('../security');
const { isPlayableMediaPath } = require('../download/options');

function boundedString(value, max, label, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.length) || value.length > max) {
    throw new TypeError(label + '无效');
  }
  return value;
}

function registerHandlers({
  ipcMain, isTrustedSender, app, authSession, resourceParser, downloads,
  checkForUpdates, shell, clipboard, dialog, getWindow
}) {
  function handle(channel, fn) {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrustedSender(event)) throw new Error('IPC 请求来源无效');
      return fn(...args);
    });
  }

  async function openLocal(target, directory) {
    if (directory && (target == null || target === '')) target = downloads.getSettings().downloadDir;
    if (typeof target !== 'string' || !downloads.isAllowedLocalPath(target)) throw new Error('不允许打开该路径');
    const resolved = path.resolve(target);
    const stat = fs.statSync(resolved);
    if (directory ? !stat.isDirectory() : !stat.isFile() || !isPlayableMediaPath(resolved)) {
      throw new Error(directory ? '下载目录无效' : '文件不可用或不允许打开');
    }
    const err = await shell.openPath(resolved);
    if (err) throw new Error('打开失败：' + err);
    return true;
  }

  handle('app:version', () => app.getVersion());
  handle('login:start', () => authSession.createLogin());
  handle('login:cancel', () => authSession.cancelLogin());
  handle('login:logout', () => authSession.logout());
  handle('login:status', async () => {
    const profile = await authSession.getProfile();
    return { loggedIn: Boolean(profile), profile };
  });
  handle('resource:parse', url => resourceParser.parseResource(url));
  handle('update:check', () => checkForUpdates());
  handle('download:start', data => downloads.download(data));
  handle('download:start-batch', items => downloads.downloadBatch(items));
  handle('download:cancel', id => downloads.cancel(boundedString(id, 80, '下载任务 ID')));
  handle('download:retry', id => downloads.retry(boundedString(id, 80, '下载任务 ID')));
  handle('queue:list', () => downloads.listQueue());
  handle('history:list', () => downloads.readHistory());
  handle('history:clear', () => { downloads.writeHistory([]); return true; });
  handle('history:remove', ids => {
    if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string' && id.length <= 80)) {
      throw new TypeError('记录 ID 列表无效');
    }
    const remove = new Set(ids);
    downloads.writeHistory(downloads.readHistory().filter(item => !remove.has(item?.id)));
    return true;
  });
  handle('settings:get', () => downloads.getSettings());
  handle('settings:set', changes => downloads.setSettings(changes));
  handle('settings:reset', () => downloads.resetSettings());
  handle('settings:chooseDir', async () => {
    const win = getWindow();
    const result = await dialog.showOpenDialog(win && !win.isDestroyed() ? win : undefined,
      { properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    return downloads.setSettings({ downloadDir: result.filePaths[0] }).downloadDir;
  });
  handle('shell:open', target => openLocal(target, true));
  handle('video:play-local', file => openLocal(file, false));
  handle('video:open', url => shell.openExternal(assertExternalUrl(url)));
  handle('clipboard:write', value => {
    clipboard.writeText(boundedString(value, 65536, '剪贴板文本', true));
    return true;
  });
}

module.exports = { registerHandlers };
