const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDownloadQueue } = require('../src/download/queue');
const { createQueueStore } = require('../src/download/queue-store');

function task(id) { return { id, url: `https://www.bilibili.com/video/${id}`, contentModes: ['video'], queuedAt: '2026-01-01T00:00:00.000Z' }; }
function tick() { return new Promise(resolve => setImmediate(resolve)); }

test('persists active and waiting tasks and resumes each ID once', async () => {
  let snapshot = [];
  let finish;
  const running = new Promise(resolve => { finish = resolve; });
  const queue = createDownloadQueue({
    read: () => snapshot,
    write: items => { snapshot = structuredClone(items); },
    serialize: value => ({ ...value }),
    processTask: () => running,
    maxConcurrency: () => 1
  });
  queue.enqueue(task('a'));
  queue.enqueue(task('b'));
  assert.deepEqual(snapshot.map(item => [item.id, item.queueStatus]), [['a', 'running'], ['b', 'queued']]);

  const resumed = [];
  const restart = createDownloadQueue({
    read: () => [...snapshot, snapshot[0]],
    write: () => {}, serialize: value => value,
    processTask: async value => { resumed.push(value.id); },
    maxConcurrency: () => 1
  });
  restart.load();
  restart.load();
  assert.deepEqual(restart.downloadQueue.map(item => item.id), ['a', 'b']);
  assert.ok(restart.downloadQueue.every(item => !('queueStatus' in item)));
  restart.pump();
  await tick();
  await tick();
  assert.deepEqual(resumed, ['a', 'b']);
  finish();
  await tick();
});

test('catches task setup and async failures even when reporting rejects', async () => {
  const failures = [];
  let snapshot = [];
  const queue = createDownloadQueue({
    read: () => [], write: items => { snapshot = items; }, serialize: value => value,
    processTask: value => {
      if (value.id === 'setup') throw new Error('setup failed');
      return Promise.reject(new Error('download failed'));
    },
    onTaskError: async (value, error) => { failures.push([value.id, error.message]); throw new Error('report failed'); },
    maxConcurrency: () => 1
  });
  queue.enqueue(task('setup'));
  queue.enqueue(task('async'));
  await tick();
  await tick();
  assert.deepEqual(failures, [['setup', 'setup failed'], ['async', 'download failed']]);
  assert.deepEqual(snapshot, []);
  assert.equal(queue.activeTasks.size, 0);
});

test('atomic store reads legacy data and recovers a newer valid temporary snapshot', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biligo-queue-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'queue.json');
  const store = createQueueStore(file);
  assert.deepEqual(store.read(), []);
  fs.writeFileSync(file, JSON.stringify([task('legacy')]));
  assert.deepEqual(store.read().map(value => value.id), ['legacy']);
  store.write([task('new')]);
  assert.deepEqual(store.read().map(value => value.id), ['new']);
  assert.deepEqual(fs.readdirSync(dir), ['queue.json']);

  fs.writeFileSync(file, '{broken');
  assert.throws(() => store.read(), /队列快照读取失败.*JSON 内容损坏/);
  fs.writeFileSync(path.join(dir, 'queue.json.tmp-recovery'), JSON.stringify({ tasks: [{ task: task('recovered') }] }));
  assert.deepEqual(store.read().map(value => value.id), ['recovered']);
  fs.writeFileSync(path.join(dir, 'queue.json.tmp-broken'), '{partial');
  assert.deepEqual(store.read().map(value => value.id), ['recovered']);
});

test('a directory enumeration failure cannot be treated as a missing queue', () => {
  const denied = Object.assign(new Error('access denied'), { code: 'EACCES' });
  const store = createQueueStore(path.resolve('queue.json'), {
    fs: { readdirSync() { throw denied; } }
  });
  assert.throws(() => store.read(), { code: 'EACCES', cause: denied });
});

test('completion persistence retries with backoff before starting the next worker', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reports = [];
  const started = [];
  const writes = [];
  let failures = 0;
  let finish;
  const running = new Promise(resolve => { finish = resolve; });
  const queue = createDownloadQueue({
    read: () => [], serialize: value => value, maxConcurrency: () => 1,
    write: items => {
      writes.push(items.map(item => [item.id, item.queueStatus]));
      if (failures > 0) {
        failures -= 1;
        throw new Error('temporarily unavailable');
      }
    },
    processTask: async value => {
      started.push(value.id);
      if (value.id === 'first') await running;
    },
    onPersistenceError: error => { reports.push(error.message); }
  });
  queue.enqueue(task('first'));
  queue.enqueue(task('second'));
  const initialWrites = writes.length;
  failures = 2;
  finish();
  await tick();
  assert.deepEqual(started, ['first']);
  assert.equal(writes.length, initialWrites + 1);
  queue.pump();
  t.mock.timers.tick(249);
  assert.equal(writes.length, initialWrites + 1);
  t.mock.timers.tick(1);
  assert.equal(writes.length, initialWrites + 2);
  t.mock.timers.tick(499);
  assert.deepEqual(started, ['first']);
  t.mock.timers.tick(1);
  assert.deepEqual(started, ['first', 'second']);
  await tick();
  assert.deepEqual(writes.slice(-3), [[['second', 'queued']], [['second', 'running']], []]);
  assert.deepEqual(reports, ['temporarily unavailable']);
});

test('a failed running snapshot leaves work queued until retry persists the transition', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = [];
  let snapshot = [];
  let blocked = true;
  const queue = createDownloadQueue({
    read: () => [], serialize: value => value, maxConcurrency: () => 1,
    write: items => {
      if (blocked && items.some(item => item.queueStatus === 'running')) throw new Error('disk busy');
      snapshot = items;
    },
    processTask: async value => { started.push(value.id); }
  });
  queue.enqueue(task('waiting'));
  assert.equal(snapshot[0].queueStatus, 'queued');
  assert.deepEqual(started, []);
  blocked = false;
  t.mock.timers.tick(250);
  assert.equal(snapshot[0].queueStatus, 'running');
  assert.deepEqual(started, ['waiting']);
  await tick();
  assert.deepEqual(snapshot, []);
});

test('shutdown requeues only unfinished work without runtime cancellation flags', () => {
  let snapshot = [];
  const stopped = [];
  const queue = createDownloadQueue({
    read: () => [], write: items => { snapshot = items; }, serialize: value => ({ ...value }),
    processTask: () => new Promise(() => {}), maxConcurrency: () => 2
  });
  queue.enqueue(task('done'));
  queue.enqueue(task('running'));
  queue.enqueue(task('waiting'));
  queue.activeTasks.get('done').finalized = true;
  queue.save();
  assert.deepEqual(snapshot.map(item => [item.id, item.queueStatus]), [['running', 'running'], ['waiting', 'queued']]);

  queue.requeueActive(value => { stopped.push(value.id); });
  assert.deepEqual(stopped, ['running']);
  assert.deepEqual(snapshot.map(item => item.id), ['running', 'waiting']);
  assert.ok(snapshot.every(item => !('cancelled' in item) && item.queueStatus === 'queued'));
  queue.pump();
  assert.deepEqual(snapshot.map(item => item.id), ['running', 'waiting']);
});

test('a failed cancellation save restores the waiting task', () => {
  let fail = false;
  const queue = createDownloadQueue({
    read: () => [], write: () => { if (fail) throw new Error('disk full'); }, serialize: value => value,
    processTask: () => new Promise(() => {}), maxConcurrency: () => 1
  });
  queue.enqueue(task('running'));
  queue.enqueue(task('waiting'));
  fail = true;
  assert.throws(() => queue.cancelQueued('waiting'), /disk full/);
  assert.equal(queue.downloadQueue[0].id, 'waiting');
  assert.equal(queue.downloadQueue[0].cancelled, false);
});
