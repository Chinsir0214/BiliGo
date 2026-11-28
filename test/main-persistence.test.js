const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createAppRuntime } = require('../src/main');
const { createLocalDataReader } = require('../src/local-data');
const { createQueueStore } = require('../src/download/queue-store');

function mainFixture(t, { settings = '{}', history = '[]', overrides = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'biligo-main-'));
  const dataDir = path.join(root, 'userData', 'bili-go');
  const downloadDir = path.join(root, 'downloads', 'BiliGo');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(downloadDir, { recursive: true });

  const saved = {
    id: 'saved-task', title: 'saved', url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    contentModes: ['video-audio'], outputDir: downloadDir, queuedAt: '2026-01-01T00:00:00.000Z'
  };
  const reads = [];
  const writes = [];
  const readErrors = new Map();
  const queueWrites = [];
  const sent = [];
  const handlers = new Map();
  const put = (file, value) => fs.writeFileSync(path.join(dataDir, file), value);
  const read = file => fs.readFileSync(path.join(dataDir, file), 'utf8');
  const remove = file => fs.unlinkSync(path.join(dataDir, file));
  put('settings.json', settings);
  put('history.json', history);
  put('queue.json', JSON.stringify([saved]));

  const fileSystem = {
    ...fs,
    readFileSync(file, encoding) {
      const name = path.basename(file);
      reads.push(name);
      if (readErrors.has(name)) throw readErrors.get(name);
      return fs.readFileSync(file, encoding);
    },
    renameSync(source, target) {
      fs.renameSync(source, target);
      writes.push(path.basename(target));
    }
  };
  const contents = new EventEmitter();
  contents.setWindowOpenHandler = () => {};
  contents.send = (...message) => sent.push(message);
  class Window extends EventEmitter {
    constructor() { super(); this.webContents = contents; }
    setMenuBarVisibility() {}
    loadFile() {}
    isDestroyed() { return false; }
  }

  const app = new EventEmitter();
  const exit = Promise.withResolvers();
  let completedQuits = 0;
  app.getPath = key => path.join(root, key);
  app.whenReady = async () => {};
  app.requestSingleInstanceLock = () => true;
  app.getVersion = () => '1.3.0';
  app.quit = () => {
    let prevented = false;
    app.emit('before-quit', { preventDefault() { prevented = true; } });
    if (!prevented) {
      completedQuits++;
      exit.resolve();
    }
  };

  const shell = {};
  const runtime = createAppRuntime({
    electron: {
      app, BrowserWindow: Window, shell,
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      session: { defaultSession: {
        setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
        webRequest: { onBeforeSendHeaders() {} }
      } }
    },
    process: Object.assign(new EventEmitter(), { platform: process.platform }),
    createLogger: () => ({ log() {}, flushSync() {} }),
    createAuthSession: () => ({ shutdown() {} }),
    createLocalDataReader: () => createLocalDataReader({ fs: fileSystem }),
    createQueueStore: file => {
      const store = createQueueStore(file, { fs: fileSystem });
      return {
        read: store.read,
        write(items) { store.write(items); queueWrites.push(items); }
      };
    },
    createTaskWorkspace() { throw new Error('test workspace unavailable'); },
    resolveTool: name => name,
    ...overrides
  });
  t.after(async () => {
    if (!completedQuits) app.quit();
    await exit.promise;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    saved, downloadDir, shell, put, read, remove, readErrors, reads, writes, queueWrites, sent,
    start: runtime.start,
    load: () => contents.emit('did-finish-load'),
    invoke: (channel, ...args) => handlers.get(channel)({ sender: contents }, ...args),
    quit: app.quit, exited: exit.promise, closeWindows: () => app.emit('window-all-closed'),
    get completedQuits() { return completedQuits; }
  };
}

test('first window loads before queue recovery and optional feature imports', async t => {
  const imports = [];
  const autoUpdater = { checkForUpdates: async () => ({ updateInfo: { version: '1.4.0' } }) };
  const main = require.cache[require.resolve('../src/main')];
  const originalRequire = main.require;
  t.mock.method(main, 'require', function (name) {
    imports.push(name);
    if (name === 'electron-updater') return { autoUpdater };
    return originalRequire.call(this, name);
  });
  const fixture = mainFixture(t);
  fixture.put('queue.json', '[]');
  await fixture.start();
  assert.deepEqual(fixture.reads, []);
  fixture.load();
  assert.ok(fixture.reads.includes('queue.json'));
  assert.ok(!imports.includes('qrcode'));
  assert.ok(!imports.includes('electron-updater'));
  const reads = fixture.reads.length;
  fixture.load();
  assert.equal(fixture.reads.length, reads);
  assert.equal((await fixture.invoke('update:check')).hasUpdate, true);
  assert.ok(imports.includes('electron-updater'));
  assert.equal(autoUpdater.autoDownload, false);
  assert.equal(autoUpdater.autoInstallOnAppQuit, false);
});

test('quit before the first window loads leaves saved downloads for the next launch', async t => {
  const fixture = mainFixture(t);
  await fixture.start();
  fixture.quit();
  fixture.load();
  await fixture.exited;
  assert.deepEqual(fixture.reads, []);
  assert.deepEqual(fixture.queueWrites, []);
});

for (const status of ['completed', 'failed']) {
  test(`quit during an asynchronous publish records ${status} outputs exactly once`, async t => {
    const publishing = Promise.withResolvers();
    const commit = Promise.withResolvers();
    const activeDownload = Promise.withResolvers();
    const fixture = mainFixture(t, { settings: '{"maxConcurrentTasks":2}', overrides: {
      createDownloadExecutor: () => ({
        run: task => task.id === 'active' ? activeDownload.promise : Promise.resolve(),
        stop: () => activeDownload.reject(new Error('interrupted'))
      }),
      createTaskWorkspace: () => ({
        stageDir: fixture.downloadDir,
        cleanup() {},
        commit() { publishing.resolve(); return commit.promise; }
      })
    } });
    const output = path.join(fixture.downloadDir, 'video.mp4');
    fixture.put('queue.json', JSON.stringify([fixture.saved, { ...fixture.saved, id: 'active' }, { ...fixture.saved, id: 'queued' }]));
    await fixture.start();
    fixture.load();
    await publishing.promise;
    assert.equal(await fixture.invoke('download:cancel', fixture.saved.id), false);
    if (status === 'completed' && process.platform !== 'darwin') fixture.closeWindows();
    else fixture.quit();
    assert.equal(fixture.completedQuits, 0);
    assert.equal(await fixture.invoke('download:cancel', 'active'), false);
    await assert.rejects(fixture.invoke('download:start', fixture.saved), /正在退出/);
    if (status === 'completed') commit.resolve([output]);
    else commit.reject(Object.assign(new Error('disk full'), { committedFiles: [output] }));
    await fixture.exited;
    assert.equal(fixture.completedQuits, 1);
    assert.deepEqual(fixture.queueWrites.at(-1).map(task => task.id), ['active', 'queued']);
    const history = JSON.parse(fixture.read('history.json')).items;
    assert.equal(history.length, 1);
    assert.equal(history[0].status, status);
    assert.deepEqual(history[0].files, [output]);
  });
}

test('failed settings restore preserves the saved queue through quit and reports after window load', async t => {
  const fixture = mainFixture(t, { settings: '{' });
  await fixture.start();
  assert.deepEqual(fixture.queueWrites, []);
  assert.equal(fixture.sent.length, 0);
  fixture.load();
  assert.equal(fixture.sent[0][0], 'app:error');
  assert.match(fixture.sent[0][1], /设置读取失败.*JSON/);
  assert.throws(() => fixture.invoke('queue:list'), /设置读取失败/);
  fixture.quit();
  await fixture.exited;
  assert.deepEqual(fixture.queueWrites, []);
  assert.equal(fixture.read('settings.json'), '{');
});

test('repairing settings permits reloading the original queue and cancelling despite history failure', async t => {
  const fixture = mainFixture(t, { settings: '{', history: '{' });
  await fixture.start();
  fixture.load();
  fixture.put('settings.json', '{}');
  const queue = fixture.invoke('queue:list');
  assert.equal(queue.length, 1);
  assert.equal(queue[0].id, 'saved-task');
  assert.equal(await fixture.invoke('download:cancel', 'saved-task'), true);
  assert.equal(fixture.queueWrites.at(-1).length, 0);
  assert.equal(fixture.read('history.json'), '{');
  assert.ok(!fixture.writes.includes('history.json'));
  assert.ok(fixture.sent.some(([channel, message]) => channel === 'app:error' && /任务记录保存失败/.test(message)));
});

test('an unreadable queue rejects new downloads and stays untouched through quit', async t => {
  const fixture = mainFixture(t);
  const savedQueue = fixture.read('queue.json');
  fixture.readErrors.set('queue.json', Object.assign(new Error('access denied'), { code: 'EACCES' }));
  fixture.put('queue.json.tmp-backup', savedQueue);
  await fixture.start();
  fixture.load();
  assert.ok(fixture.sent.some(([channel, message]) => channel === 'app:error' && /队列快照读取失败.*access denied/.test(message)));
  assert.throws(() => fixture.invoke('queue:list'), /队列快照读取失败/);
  await assert.rejects(fixture.invoke('download:start', { url: fixture.saved.url, contentModes: ['video'] }), /队列快照读取失败/);
  await assert.rejects(fixture.invoke('download:cancel', fixture.saved.id), /队列快照读取失败/);
  fixture.quit();
  await fixture.exited;
  assert.deepEqual(fixture.queueWrites, []);
  assert.equal(fixture.read('queue.json'), savedQueue);
});

test('repairing a damaged queue restores and normalizes the legacy task snapshot', async t => {
  const fixture = mainFixture(t);
  fixture.put('queue.json', '{');
  await fixture.start();
  fixture.load();
  assert.throws(() => fixture.invoke('queue:list'), /队列快照读取失败/);
  assert.deepEqual(fixture.queueWrites, []);

  const legacy = { ...fixture.saved, cancelled: true, finalized: true, contentModes: ['audio', 'subtitle'], embedSubs: true };
  const invalid = { id: 'bad' };
  fixture.put('queue.json.tmp-backup', JSON.stringify({ tasks: [{ queueStatus: 'running', task: legacy }, invalid] }));
  const queue = fixture.invoke('queue:list');
  assert.equal(queue.length, 1);
  const [restored] = queue;
  assert.equal(restored.id, fixture.saved.id);
  assert.equal(restored.status, 'queued');
  assert.equal(restored.queuedAt, fixture.saved.queuedAt);
  assert.equal(restored.mode, 'audio,subtitle');
  const [rejected] = JSON.parse(fixture.read('queue.json.tmp-backup.rejected.json'));
  assert.deepEqual(rejected.entry, invalid);
  fixture.quit();
  await fixture.exited;
  const [persisted] = fixture.queueWrites.at(-1);
  assert.equal(persisted.queuedAt, fixture.saved.queuedAt);
  assert.equal(persisted.queueStatus, 'queued');
  assert.equal(persisted.embedSubs, false);
  assert.deepEqual(persisted.contentModes, ['audio', 'subtitle']);
});

test('history retry accepts the inherited legacy subtitle flag while direct IPC rejects it', async t => {
  const fixture = mainFixture(t);
  const legacy = { ...fixture.saved, contentModes: ['audio', 'subtitle'], embedSubs: true };
  fixture.remove('queue.json');
  fixture.put('history.json', JSON.stringify([{ id: legacy.id, outputDir: legacy.outputDir, retryTask: legacy }]));
  await fixture.start();
  await assert.rejects(fixture.invoke('download:start', legacy), /嵌入字幕仅支持视频模式/);
  assert.deepEqual(fixture.queueWrites, []);
  const retried = await fixture.invoke('download:retry', legacy.id);
  assert.equal(retried.mode, 'audio,subtitle');
  const [persisted] = fixture.queueWrites[0];
  assert.equal(persisted.id, retried.id);
  assert.equal(persisted.embedSubs, false);
  assert.deepEqual(persisted.contentModes, ['audio', 'subtitle']);
});

test('failed settings/history reads reject IPC updates without overwriting their files', async t => {
  for (const code of [null, 'EACCES', 'EIO']) {
    const fixture = mainFixture(t, { settings: '{', history: '{' });
    if (code) {
      const error = Object.assign(new Error('read failed'), { code });
      fixture.readErrors.set('settings.json', error);
      fixture.readErrors.set('history.json', error);
    }
    await fixture.start();
    assert.throws(() => fixture.invoke('settings:set', { retries: '5' }), /设置读取失败/);
    assert.throws(() => fixture.invoke('history:remove', ['old']), /下载记录读取失败/);
    assert.equal(fixture.writes.length, 0);
    assert.equal(fixture.read('settings.json'), '{');
    assert.equal(fixture.read('history.json'), '{');
  }
});

test('first launch with absent local files uses defaults without error notifications', async t => {
  const fixture = mainFixture(t);
  for (const file of ['settings.json', 'history.json', 'queue.json']) fixture.remove(file);
  await fixture.start();
  fixture.load();
  assert.equal(fixture.invoke('settings:get').maxConcurrentTasks, 1);
  assert.deepEqual(fixture.invoke('history:list'), []);
  assert.deepEqual(fixture.invoke('queue:list'), []);
  assert.deepEqual(fixture.sent, []);
  assert.deepEqual(fixture.writes, []);
});

test('shell and playback IPC open only the expected kind of local path and report shell errors', async t => {
  const fixture = mainFixture(t);
  await fixture.start();
  const media = path.join(fixture.downloadDir, 'movie.mp4');
  const executable = path.join(fixture.downloadDir, 'tool.exe');
  const directory = path.join(fixture.downloadDir, 'folder.mp4');
  fs.writeFileSync(media, '');
  fs.writeFileSync(executable, '');
  fs.mkdirSync(directory);
  const opened = [];
  let shellResult = '';
  fixture.shell.openPath = async target => { opened.push(target); return shellResult; };
  for (const file of [media, executable]) {
    await assert.rejects(fixture.invoke('shell:open', file), /下载目录无效/);
  }
  await assert.rejects(fixture.invoke('video:play-local', directory), /文件不可用/);
  await assert.rejects(fixture.invoke('video:play-local', executable), /文件不可用/);
  assert.deepEqual(opened, []);

  assert.equal(await fixture.invoke('shell:open', fixture.downloadDir), true);
  assert.equal(await fixture.invoke('video:play-local', media), true);
  shellResult = 'no application available';
  await assert.rejects(fixture.invoke('shell:open', fixture.downloadDir), /打开失败.*no application available/);
  await assert.rejects(fixture.invoke('video:play-local', media), /打开失败.*no application available/);
  assert.deepEqual(opened, [fixture.downloadDir, media, fixture.downloadDir, media]);
});

test('history:remove requires an array and persists only the selected removals', async t => {
  const items = [{ id: 'keep' }, { id: 'remove' }];
  const fixture = mainFixture(t, { history: JSON.stringify(items) });
  await fixture.start();
  assert.throws(() => fixture.invoke('history:remove', 'remove'), /记录 ID 列表无效/);
  assert.deepEqual(fixture.writes, []);
  assert.equal(fixture.invoke('history:remove', ['remove']), true);
  assert.deepEqual(fixture.invoke('history:list'), [items[0]]);
  assert.deepEqual(JSON.parse(fixture.read('history.json')).items, [items[0]]);
});

test('settings:set returns normalized settings and starts queued work when concurrency increases', async t => {
  const running = new Map();
  const fixture = mainFixture(t, { overrides: {
    createDownloadExecutor: () => ({
      run(task) {
        const gate = Promise.withResolvers();
        running.set(task.id, gate);
        return gate.promise;
      },
      stop(task) { running.get(task.id).reject(new Error('interrupted')); }
    }),
    createTaskWorkspace: () => ({ stageDir: fixture.downloadDir, cleanup() {} })
  } });
  fixture.put('queue.json', JSON.stringify([fixture.saved, { ...fixture.saved, id: 'next' }]));
  await fixture.start();
  fixture.load();
  assert.deepEqual([...running.keys()], [fixture.saved.id]);

  const settings = fixture.invoke('settings:set', { maxConcurrentTasks: '2', retries: 3 });
  assert.equal(settings.maxConcurrentTasks, 2);
  assert.equal(settings.retries, '3');
  assert.equal(settings.downloadDir, fixture.downloadDir);
  assert.deepEqual(settings, fixture.invoke('settings:get'));
  assert.deepEqual(JSON.parse(fixture.read('settings.json')), settings);
  assert.deepEqual([...running.keys()], [fixture.saved.id, 'next']);
});
