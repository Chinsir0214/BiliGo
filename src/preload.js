const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bili', {
  startLogin: () => ipcRenderer.invoke('login:start'),
  cancelLogin: () => ipcRenderer.invoke('login:cancel'),
  loginStatus: () => ipcRenderer.invoke('login:status'),
  logout: () => ipcRenderer.invoke('login:logout'),
  startDownload: data => ipcRenderer.invoke('download:start', data),
  parseResource: url => ipcRenderer.invoke('resource:parse', url),
  loadMoreResource: data => ipcRenderer.invoke('resource:more', data),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
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
  on: (channel, callback) => { const allowed = ['login:poll', 'login:success', 'login:expired', 'download:progress', 'download:done', 'update:progress', 'update:downloaded', 'app:error']; if (allowed.includes(channel)) ipcRenderer.on(channel, (_, data) => callback(data)); }
});
