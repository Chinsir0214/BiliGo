const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createDownloadExecutor } = require('../src/download/executor');

test('stopping a danmaku-only task aborts its signal without a media child process', () => {
  const executor = createDownloadExecutor({});
  const danmakuController = new AbortController();
  executor.stop({ danmakuController });
  assert.equal(danmakuController.signal.aborted, true);
  assert.match(danmakuController.signal.reason.message, /下载已取消/);
});

function createHarness({ terminator } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.killSignals = [];
  child.kill = signal => {
    child.killed = true;
    child.killSignals.push(signal);
  };
  const sent = [];
  let spawned;
  const executor = createDownloadExecutor({
    resolveYtdlp: () => 'yt-dlp',
    pushCookieArgs: args => [...args, '--cookies', 'cookies.txt'],
    send: (channel, payload) => sent.push({ channel, payload }),
    spawnProcess: (command, args, options) => {
      spawned = { command, args, options };
      return command === 'taskkill' && terminator ? terminator : child;
    }
  });
  return { child, executor, sent, get spawned() { return spawned; } };
}

test('buffers progress and UTF-8 errors separately across process output chunks', async () => {
  const harness = createHarness();
  const task = { id: 'split' };
  const args = ['--progress'];
  const running = harness.executor.run(task, args, ['https://example.test/video']);
  assert.deepEqual(args, ['--progress']);
  assert.deepEqual(harness.spawned.args, ['--progress', '--cookies', 'cookies.txt', 'https://example.test/video']);
  assert.equal(harness.spawned.options.env.PYTHONIOENCODING, 'utf-8');

  harness.child.stdout.emit('data', Buffer.from('[download] 12.'));
  const error = Buffer.from('ERROR: 登录已过期，中文路径下载失败 50%');
  const split = Buffer.byteLength('ERROR: ') + 1;
  harness.child.stderr.emit('data', error.subarray(0, split));
  assert.equal(harness.sent.length, 0);
  harness.child.stdout.emit('data', Buffer.from('5% of 1MiB at 1MiB/s ETA 00:10\n'));
  harness.child.stdout.emit('data', Buffer.from('[download] 13.0% of 1MiB at 1MiB/s ETA 00:09\n'));
  harness.child.stderr.emit('data', error.subarray(split));
  assert.deepEqual(harness.sent.map(event => event.payload.percent), [12.5]);
  assert.equal(harness.sent[0].payload.speed, '1MiB/s');
  assert.equal(harness.sent[0].payload.eta, '00:10');
  harness.child.emit('close', 1);
  await assert.rejects(running, { message: 'ERROR: 登录已过期，中文路径下载失败 50%' });
  assert.equal(harness.sent.length, 1);
  assert.equal(task.process, null);
});

test('flushes an unterminated final progress line and does not throttle completion', async () => {
  const harness = createHarness();
  const running = harness.executor.run({ id: 'complete' }, [], []);
  harness.child.stdout.emit('data', Buffer.from('[download] 25% of 1MiB\r[download] 100% of 1MiB'));
  harness.child.emit('close', 0);
  await running;
  assert.deepEqual(harness.sent.map(event => event.payload.percent), [25, 100]);
});

test('keeps a real error after ordinary destination and status lines', async () => {
  const harness = createHarness();
  const running = harness.executor.run({ id: 'real-error' }, [], []);
  harness.child.stdout.emit('data', Buffer.from('[download] Destination: C:\\视频\\example.m4a\n'));
  harness.child.stderr.emit('data', Buffer.from('ERROR: HTTP Error 403: Forbidden\n'));
  harness.child.stdout.emit('data', Buffer.from('[download] 53.4% of 8MiB\n'));
  harness.child.stdout.emit('data', Buffer.from('[download] Destination: C:\\视频\\example.mp4\n'));
  harness.child.emit('close', 1);
  await assert.rejects(running, error => error.message === 'ERROR: HTTP Error 403: Forbidden');
});

test('reports exit code instead of a destination when there is no explicit error', async () => {
  const harness = createHarness();
  const running = harness.executor.run({ id: 'no-error' }, [], []);
  harness.child.stdout.emit('data', Buffer.from('[download] Destination: C:\\视频\\example.m4a\n'));
  harness.child.stderr.emit('data', Buffer.from('WARNING: Retrying fragment 1\n'));
  harness.child.emit('close', 7);
  await assert.rejects(running, error => /退出码 7/.test(error.message) && !/Destination|WARNING/.test(error.message));
});

test('uses the final exception in a Python traceback', async () => {
  const harness = createHarness();
  const running = harness.executor.run({ id: 'traceback' }, [], []);
  harness.child.stderr.emit('data', Buffer.from('Traceback (most recent call last):\n  File "yt_dlp.py", line 1\nyt_dlp.utils.DownloadError: 文件不可写\n'));
  harness.child.emit('close', 1);
  await assert.rejects(running, /下载程序异常：yt_dlp\.utils\.DownloadError: 文件不可写/);
});

for (const [streamName, label] of [['stdout', '标准'], ['stderr', '错误']]) {
  test(`handles ${streamName} read errors once and clears the active process`, async () => {
    const harness = createHarness();
    const task = { id: streamName };
    const running = harness.executor.run(task, [], []);
    const rejected = assert.rejects(running, new RegExp(`下载程序${label}输出读取失败：broken pipe`));
    harness.child[streamName].emit('error', new Error('broken pipe'));
    harness.child[streamName].emit('data', Buffer.from('[download] 100% of 1MiB\n'));
    harness.child.emit('close', 0);
    await rejected;
    assert.equal(task.process, null);
    assert.deepEqual(harness.child.killSignals, ['SIGTERM']);
    assert.equal(harness.sent.length, 0);
  });
}

test('reports the termination signal when no explicit error was emitted', async () => {
  const harness = createHarness();
  const running = harness.executor.run({ id: 'signal' }, [], []);
  harness.child.emit('close', null, 'SIGKILL');
  await assert.rejects(running, /信号 SIGKILL/);
});

test('cancellation takes precedence over a prior error and stream read errors', async () => {
  const harness = createHarness();
  const task = { id: 'cancelled', cancelled: true };
  const running = harness.executor.run(task, [], []);
  harness.child.stderr.emit('data', Buffer.from('ERROR: HTTP Error 403: Forbidden\n'));
  harness.child.stderr.emit('error', new Error('broken pipe'));
  harness.child.emit('close', 1);
  await assert.rejects(running, error => error.message === '下载已取消');
  assert.equal(task.process, null);
  assert.deepEqual(harness.child.killSignals, []);
});

test('falls back to killing the download when Windows taskkill exits unsuccessfully', { skip: process.platform !== 'win32' }, async () => {
  const terminator = new EventEmitter();
  const harness = createHarness({ terminator });
  harness.child.pid = 4242;
  harness.child.exitCode = null;
  harness.child.signalCode = null;
  const task = { id: 'taskkill-fallback', cancelled: true };
  const running = harness.executor.run(task, [], []);
  harness.executor.stop(task);
  assert.equal(harness.spawned.command, 'taskkill');
  assert.deepEqual(harness.spawned.args, ['/pid', '4242', '/T', '/F']);
  terminator.emit('close', 1);
  assert.deepEqual(harness.child.killSignals, ['SIGTERM']);
  harness.child.emit('close', null, 'SIGTERM');
  await assert.rejects(running, error => error.message === '下载已取消');
  assert.equal(task.process, null);
});
