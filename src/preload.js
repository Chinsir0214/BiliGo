const { contextBridge, ipcRenderer } = require('electron');

const allowedEvents = new Set([
  'login:success', 'login:scanned', 'login:expired', 'login:error',
  'download:progress', 'download:done', 'app:error'
]);

contextBridge.exposeInMainWorld('bili', {
  startLogin: () => ipcRenderer.invoke('login:start'),
  cancelLogin: () => ipcRenderer.invoke('login:cancel'),
  loginStatus: () => ipcRenderer.invoke('login:status'),
  logout: () => ipcRenderer.invoke('login:logout'),
  startDownload: data => ipcRenderer.invoke('download:start', data),
  startDownloads: items => ipcRenderer.invoke('download:start-batch', items),
  parseResource: url => ipcRenderer.invoke('resource:parse', url),
  appVersion: () => ipcRenderer.invoke('app:version'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  cancelDownload: id => ipcRenderer.invoke('download:cancel', id),
  listQueue: () => ipcRenderer.invoke('queue:list'),
  retryDownload: id => ipcRenderer.invoke('download:retry', id),
  openFolder: path => ipcRenderer.invoke('shell:open', path),
  openVideo: url => ipcRenderer.invoke('video:open', url),
  playLocalVideo: file => ipcRenderer.invoke('video:play-local', file),
  copyLink: url => ipcRenderer.invoke('clipboard:write', url),
  history: () => ipcRenderer.invoke('history:list'),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  removeHistory: ids => ipcRenderer.invoke('history:remove', ids),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),
  setSettings: changes => ipcRenderer.invoke('settings:set', changes),
  chooseDownloadDir: () => ipcRenderer.invoke('settings:chooseDir'),
  on(channel, callback) {
    if (!allowedEvents.has(channel)) throw new TypeError('事件通道无效');
    if (typeof callback !== 'function') throw new TypeError('事件回调必须为函数');
    const listener = (_, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
});
