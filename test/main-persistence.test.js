const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { createLocalDataReader } = require('../src/local-data');
const { createQueueStore } = require('../src/download/queue-store');

function mainFixture(settings = '{}', history = '[]', modules = {}) {
  const saved = { id: 'saved-task', title: 'saved', url: 'https://www.bilibili.com/video/BV1xx411c7mD', contentModes: ['video-audio'], outputDir: path.resolve('downloads'), queuedAt: '2026-01-01T00:00:00.000Z' };
  const files = new Map([['settings.json', settings], ['history.json', history], ['queue.json', JSON.stringify([saved])]]);
  const writes = [];
  const reads = [];
  const imports = [];
  const queueWrites = [];
  const sent = [];
  const handlers = new Map();
  const app = new EventEmitter();
  let start;
  app.getPath = key => path.resolve('test-user-data', key);
  app.whenReady = () => ({ then: callback => { start = callback; } });
  app.getVersion = () => '1.3.0';
  let completedQuits = 0;
  app.quit = () => {
    let prevented = false;
    app.emit('before-quit', { preventDefault() { prevented = true; } });
    if (!prevented) completedQuits++;
  };
  const contents = new EventEmitter();
  contents.setWindowOpenHandler = () => {};
  contents.send = (...message) => sent.push(message);
  class Window {
    constructor() { this.webContents = contents; }
    setMenuBarVisibility() {}
    loadFile() {}
    isDestroyed() { return false; }
    static getAllWindows() { return []; }
  }
  const fileSystem = {
    readFileSync(file) {
      reads.push(path.basename(file));
      const value = files.get(path.basename(file));
      if (value instanceof Error) throw value;
      if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return value;
    },
    readdirSync() { return [...files.keys()]; },
    statSync() { return { mtimeMs: 0 }; },
    writeFileSync(file, value) { writes.push([path.basename(file), value]); files.set(path.basename(file), value); },
    mkdirSync() {}, appendFileSync() {}
  };
  const mainFile = path.resolve(__dirname, '../src/main.js');
  const mainRequire = createRequire(mainFile);
  function requireMain(name) {
    imports.push(name);
    if (Object.hasOwn(modules, name)) return modules[name];
    if (name === 'electron') return { app, BrowserWindow: Window, ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, shell: {}, session: { defaultSession: { webRequest: { onBeforeSendHeaders() {} } } } };
    if (name === 'fs') return fileSystem;
    if (name === 'qrcode') return {};
    if (name === 'electron-updater') return { autoUpdater: {} };
    if (name === './auth/session') return { createAuthSession: () => ({ shutdown() {} }) };
    if (name === './download/file-workspace') return { createTaskWorkspace() { throw new Error('test workspace unavailable'); } };
    if (name === './local-data') return { createLocalDataReader: () => createLocalDataReader({ fs: fileSystem }) };
    if (name === './download/queue-store') return { createQueueStore: file => ({
      read: createQueueStore(file, { fs: fileSystem }).read,
      write: items => queueWrites.push(items)
    }) };
    return mainRequire(name);
  }
  vm.runInNewContext(fs.readFileSync(mainFile, 'utf8'), { require: requireMain, __dirname: path.dirname(mainFile), console, process, Buffer, URL, URLSearchParams, setTimeout, clearTimeout });
  return { files, saved, reads, imports, writes, queueWrites, sent, contents, start: () => start(), invoke: (channel, ...args) => handlers.get(channel)({}, ...args), quit: app.quit, closeWindows: () => app.emit('window-all-closed'), get completedQuits() { return completedQuits; } };
}

test('first window loads before queue recovery and optional feature imports', async () => {
  const autoUpdater = { checkForUpdates: async () => ({ updateInfo: { version: '1.4.0' } }) };
  const fixture = mainFixture('{}', '[]', { 'electron-updater': { autoUpdater } });
  fixture.files.set('queue.json', '[]');
  await fixture.start();
  assert.deepEqual(fixture.reads, []);
  fixture.contents.emit('did-finish-load');
  assert.ok(fixture.reads.includes('queue.json'));
  assert.ok(!fixture.imports.includes('qrcode'));
  assert.ok(!fixture.imports.includes('electron-updater'));
  const reads = fixture.reads.length;
  fixture.contents.emit('did-finish-load');
  assert.equal(fixture.reads.length, reads);
  assert.equal((await fixture.invoke('update:check')).hasUpdate, true);
  assert.ok(fixture.imports.includes('electron-updater'));
  assert.equal(autoUpdater.autoDownload, false);
  assert.equal(autoUpdater.autoInstallOnAppQuit, false);
});

test('quit before the first window loads leaves saved downloads for the next launch', async () => {
  const fixture = mainFixture();
  await fixture.start();
  fixture.quit();
  fixture.contents.emit('did-finish-load');
  assert.deepEqual(fixture.reads, []);
  assert.deepEqual(fixture.queueWrites, []);
});

for (const status of ['completed', 'failed']) {
  test(`quit during an asynchronous publish records ${status} outputs exactly once`, async () => {
    let started;
    const publishing = new Promise(resolve => { started = resolve; });
    let finish;
    const output = path.resolve('downloads', 'video.mp4');
    let interrupt;
    const fixture = mainFixture('{"maxConcurrentTasks":2}', '[]', {
      './tools': { resolveTool: name => name },
      './download/executor': { createDownloadExecutor: () => ({
        run: task => task.id === 'active' ? new Promise((_, reject) => { interrupt = reject; }) : Promise.resolve(),
        stop: () => interrupt(new Error('interrupted'))
      }) },
      './download/file-workspace': { createTaskWorkspace: () => ({
        stageDir: path.resolve('stage'),
        cleanup() {},
        commit: () => new Promise((resolve, reject) => {
          finish = () => status === 'completed' ? resolve([output]) : reject(Object.assign(new Error('disk full'), { committedFiles: [output] }));
          started();
        })
      }) }
    });
    fixture.files.set('queue.json', JSON.stringify([fixture.saved, { ...fixture.saved, id: 'active' }, { ...fixture.saved, id: 'queued' }]));
    await fixture.start();
    fixture.contents.emit('did-finish-load');
    await publishing;
    assert.equal(fixture.invoke('download:cancel', fixture.saved.id), false);
    if (status === 'completed' && process.platform !== 'darwin') fixture.closeWindows();
    else fixture.quit();
    assert.equal(fixture.completedQuits, 0);
    assert.equal(fixture.invoke('download:cancel', 'active'), false);
    await assert.rejects(fixture.invoke('download:start', fixture.saved), /正在退出/);
    finish();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fixture.completedQuits, 1);
    assert.deepEqual(Array.from(fixture.queueWrites.at(-1), task => task.id), ['active', 'queued']);
    const history = JSON.parse(fixture.files.get('history.json'));
    assert.equal(history.length, 1);
    assert.equal(history[0].status, status);
    assert.deepEqual(history[0].files, [output]);
  });
}

test('failed settings restore preserves the saved queue through quit and reports after window load', async () => {
  const fixture = mainFixture('{');
  await fixture.start();
  assert.deepEqual(fixture.queueWrites, []);
  assert.equal(fixture.sent.length, 0);
  fixture.contents.emit('did-finish-load');
  assert.equal(fixture.sent[0][0], 'app:error');
  assert.match(fixture.sent[0][1], /设置读取失败.*JSON/);
  assert.throws(() => fixture.invoke('queue:list'), /设置读取失败/);
  fixture.quit();
  assert.deepEqual(fixture.queueWrites, []);
  assert.equal(fixture.files.get('settings.json'), '{');
});

test('repairing settings permits reloading the original queue and cancelling despite history failure', async () => {
  const fixture = mainFixture('{', '{');
  await fixture.start();
  fixture.contents.emit('did-finish-load');
  fixture.files.set('settings.json', '{}');
  const queue = fixture.invoke('queue:list');
  assert.equal(queue.length, 1);
  assert.equal(queue[0].id, 'saved-task');
  assert.equal(fixture.invoke('download:cancel', 'saved-task'), true);
  assert.equal(fixture.queueWrites.at(-1).length, 0);
  assert.equal(fixture.files.get('history.json'), '{');
  assert.equal(fixture.writes.length, 0);
  assert.ok(fixture.sent.some(([channel, message]) => channel === 'app:error' && /任务记录保存失败/.test(message)));
});

test('an unreadable queue rejects new downloads and stays untouched through quit', async () => {
  const fixture = mainFixture();
  const denied = Object.assign(new Error('access denied'), { code: 'EACCES' });
  fixture.files.set('queue.json', denied);
  fixture.files.set('queue.json.tmp-backup', JSON.stringify([fixture.saved]));
  await fixture.start();
  fixture.contents.emit('did-finish-load');
  assert.ok(fixture.sent.some(([channel, message]) => channel === 'app:error' && /队列快照读取失败.*access denied/.test(message)));
  assert.throws(() => fixture.invoke('queue:list'), /队列快照读取失败/);
  await assert.rejects(fixture.invoke('download:start', { url: fixture.saved.url, contentModes: ['video'] }), /队列快照读取失败/);
  assert.throws(() => fixture.invoke('download:cancel', fixture.saved.id), /队列快照读取失败/);
  fixture.quit();
  assert.deepEqual(fixture.queueWrites, []);
  assert.equal(fixture.files.get('queue.json'), denied);
});

test('repairing a damaged queue restores and normalizes the legacy task snapshot', async () => {
  const fixture = mainFixture();
  fixture.files.set('queue.json', JSON.stringify([fixture.saved, { id: 'bad' }]));
  await fixture.start();
  fixture.contents.emit('did-finish-load');
  assert.throws(() => fixture.invoke('queue:list'), /队列快照读取失败/);
  assert.deepEqual(fixture.queueWrites, []);

  const legacy = { ...fixture.saved, cancelled: true, finalized: true, contentModes: ['audio', 'subtitle'], embedSubs: true };
  fixture.files.set('queue.json.tmp-backup', JSON.stringify({ tasks: [{ queueStatus: 'running', task: legacy }] }));
  const [restored] = fixture.invoke('queue:list');
  assert.equal(restored.id, fixture.saved.id);
  assert.equal(restored.status, 'queued');
  assert.equal(restored.queuedAt, fixture.saved.queuedAt);
  assert.equal(restored.mode, 'audio,subtitle');
  fixture.quit();
  const [persisted] = fixture.queueWrites.at(-1);
  assert.equal(persisted.queuedAt, fixture.saved.queuedAt);
  assert.equal(persisted.queueStatus, 'queued');
  assert.equal(persisted.embedSubs, false);
  assert.deepEqual(persisted.contentModes, ['audio', 'subtitle']);
});

test('history retry accepts the inherited legacy subtitle flag while direct IPC rejects it', async () => {
  const fixture = mainFixture();
  const legacy = { ...fixture.saved, contentModes: ['audio', 'subtitle'], embedSubs: true };
  fixture.files.delete('queue.json');
  fixture.files.set('history.json', JSON.stringify([{ id: legacy.id, outputDir: legacy.outputDir, retryTask: legacy }]));
  await assert.rejects(fixture.invoke('download:start', legacy), /嵌入字幕仅支持视频模式/);
  assert.deepEqual(fixture.queueWrites, []);

  const retried = await fixture.invoke('download:retry', legacy.id);
  assert.equal(retried.mode, 'audio,subtitle');
  const [persisted] = fixture.queueWrites[0];
  assert.equal(persisted.id, retried.id);
  assert.equal(persisted.embedSubs, false);
  assert.deepEqual(persisted.contentModes, ['audio', 'subtitle']);
});

test('failed settings/history reads reject IPC updates without overwriting their files', () => {
  for (const value of ['{', Object.assign(new Error('access denied'), { code: 'EACCES' }), Object.assign(new Error('IO failed'), { code: 'EIO' })]) {
    const fixture = mainFixture(value, value);
    assert.throws(() => fixture.invoke('settings:set', { retries: '5' }), /设置读取失败/);
    assert.throws(() => fixture.invoke('history:remove', ['old']), /下载记录读取失败/);
    assert.equal(fixture.writes.length, 0);
    assert.equal(fixture.files.get('settings.json'), value);
    assert.equal(fixture.files.get('history.json'), value);
  }
});

test('first launch with absent local files uses defaults without error notifications', () => {
  const fixture = mainFixture();
  fixture.files.clear();
  const settings = fixture.invoke('settings:get');
  assert.equal(settings.maxConcurrentTasks, 1);
  assert.equal(fixture.invoke('history:list').length, 0);
  assert.equal(fixture.sent.length, 0);
  assert.equal(fixture.writes.length, 0);
});
