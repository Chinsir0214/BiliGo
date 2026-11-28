const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const { compileFunction } = require('node:vm');

const filename = require.resolve('../src/preload');
const runPreload = compileFunction(readFileSync(filename, 'utf8'), ['require'], { filename });

function loadBridge(t) {
  const ipcRenderer = new EventEmitter();
  const exposeInMainWorld = t.mock.fn();
  runPreload(name => {
    assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld }, ipcRenderer };
  });
  assert.equal(exposeInMainWorld.mock.callCount(), 1);
  const [name, api] = exposeInMainWorld.mock.calls[0].arguments;
  assert.equal(name, 'bili');
  return { api, ipcRenderer };
}

test('bili exposes the expected methods and forwards each invocation and its result', async t => {
  const { api, ipcRenderer } = loadBridge(t);
  const url = 'https://www.bilibili.com/video/BV1xx411c7mD';
  const items = [{ url, page: 1 }, { url, page: 2 }];
  const cases = [
    ['startLogin', 'login:start'],
    ['cancelLogin', 'login:cancel'],
    ['loginStatus', 'login:status'],
    ['logout', 'login:logout'],
    ['startDownload', 'download:start', items[0]],
    ['startDownloads', 'download:start-batch', items],
    ['parseResource', 'resource:parse', url],
    ['appVersion', 'app:version'],
    ['checkForUpdates', 'update:check'],
    ['cancelDownload', 'download:cancel', 'task-1'],
    ['listQueue', 'queue:list'],
    ['retryDownload', 'download:retry', 'task-2'],
    ['openFolder', 'shell:open', '/downloads'],
    ['openVideo', 'video:open', url],
    ['playLocalVideo', 'video:play-local', '/downloads/video.mp4'],
    ['copyLink', 'clipboard:write', url],
    ['history', 'history:list'],
    ['clearHistory', 'history:clear'],
    ['removeHistory', 'history:remove', ['id-1', 'id-2']],
    ['getSettings', 'settings:get'],
    ['resetSettings', 'settings:reset'],
    ['setSettings', 'settings:set', { downloadDir: '/downloads' }],
    ['chooseDownloadDir', 'settings:chooseDir']
  ];
  assert.deepEqual(Object.keys(api).sort(), ['on', ...cases.map(([method]) => method)].sort());

  for (const [method, channel, ...args] of cases) {
    const result = { method };
    ipcRenderer.invoke = t.mock.fn(async () => result);
    assert.equal(await api[method](...args), result, method);
    assert.equal(ipcRenderer.invoke.mock.callCount(), 1, method);
    assert.deepEqual(ipcRenderer.invoke.mock.calls[0].arguments, [channel, ...args], method);
  }
});

test('on accepts each allowed event and unsubscribes only its own listener', t => {
  const { api, ipcRenderer } = loadBridge(t);
  const events = ['login:success', 'login:scanned', 'login:expired', 'login:error',
    'download:progress', 'download:done', 'app:error'];
  for (const channel of events) {
    const callback = t.mock.fn();
    const other = t.mock.fn();
    const unsubscribe = api.on(channel, callback);
    const unsubscribeOther = api.on(channel, other);
    const event = { sender: ipcRenderer };
    const data = { channel };
    ipcRenderer.emit(channel, event, data);
    assert.deepEqual(callback.mock.calls[0].arguments, [data], channel);
    unsubscribe();
    assert.equal(ipcRenderer.listenerCount(channel), 1, channel);
    ipcRenderer.emit(channel, event, data);
    assert.equal(callback.mock.callCount(), 1, channel);
    assert.equal(other.mock.callCount(), 2, channel);
    unsubscribeOther();
    assert.equal(ipcRenderer.listenerCount(channel), 0, channel);
  }
});

test('on rejects unknown channels and non-function callbacks before registering listeners', t => {
  const { api, ipcRenderer } = loadBridge(t);
  assert.throws(() => api.on('download:start', () => {}), TypeError);
  for (const invalid of [null, {}, 'callback']) {
    assert.throws(() => api.on('download:progress', invalid), TypeError);
  }
  assert.deepEqual(ipcRenderer.eventNames(), []);
});
