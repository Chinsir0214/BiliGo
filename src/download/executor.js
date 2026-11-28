const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { killProcessTree, createYtdlpErrorExtractor } = require('../infra/process');

const MAX_LINE_BYTES = 16 * 1024;

function readLines(stream, onLine, onActivity) {
  const buffer = Buffer.allocUnsafe(MAX_LINE_BYTES);
  let used = 0;
  let overflow = false;

  function flush() {
    if (used) {
      const bytes = buffer.subarray(0, used);
      onLine(overflow ? new StringDecoder('utf8').write(bytes) : bytes.toString('utf8'));
    }
    used = 0;
    overflow = false;
  }
  stream.on('data', chunk => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!bytes.length) return;
    onActivity();
    let start = 0;
    for (let i = 0; i <= bytes.length; i++) {
      if (i !== bytes.length && bytes[i] !== 10 && bytes[i] !== 13) continue;
      const count = Math.min(i - start, MAX_LINE_BYTES - used);
      bytes.copy(buffer, used, start, start + count);
      used += count;
      if (count < i - start) overflow = true;
      if (i < bytes.length) flush();
      start = i + 1;
    }
  });
  return flush;
}

function createDownloadExecutor({
  resolveYtdlp, pushCookieArgs, send, spawnProcess = spawn, silenceTimeoutMs = 120000, forceAfterMs
}) {
  function stop(task) {
    task.danmakuController?.abort(new Error('下载已取消'));
    return killProcessTree(task.process, { spawnProcess, forceAfterMs });
  }

  function run(task, args, urls) {
    if (task.cancelled) return Promise.reject(new Error('下载已取消'));
    return new Promise((resolve, reject) => {
      const processArgs = pushCookieArgs([...args]);
      processArgs.push(...urls);
      const child = spawnProcess(resolveYtdlp(), processArgs, {
        detached: process.platform !== 'win32',
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
      });
      task.process = child;
      const errors = createYtdlpErrorExtractor();
      let lastProgressAt = 0;
      let settled = false;
      let failure;
      let watchdog;

      function finish(error) {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        if (task.process === child) task.process = null;
        if (task.cancelled) reject(new Error('下载已取消'));
        else if (failure || error) reject(failure || error);
        else resolve();
      }
      function terminate(error) {
        if (settled || failure) return;
        failure = error;
        clearTimeout(watchdog);
        killProcessTree(child, { spawnProcess, forceAfterMs }).then(() => finish());
      }
      function resetWatchdog() {
        if (settled || failure || silenceTimeoutMs <= 0) return;
        if (watchdog) watchdog.refresh();
        else watchdog = setTimeout(() => terminate(new Error('下载程序长时间无输出，已超时终止')), silenceTimeoutMs);
      }
      function parseLine(rawLine, stream) {
        if (settled || failure || task.cancelled) return;
        const line = rawLine.trim();
        errors.push(line, stream);
        const percent = line.match(/^(?:\[download\]\s*)?(\d+(?:\.\d+)?)%(?:\s|$)/);
        if (!percent) return;
        const value = Number(percent[1]);
        if (value > 100) return;
        const now = Date.now();
        if (now - lastProgressAt < 200 && value !== 100) return;
        lastProgressAt = now;
        const speed = line.match(/at\s+([^\s]+\/s)/);
        const eta = line.match(/ETA\s+([^\s]+)/);
        send('download:progress', { id: task.id, line, percent: value, speed: speed?.[1] || '', eta: eta?.[1] || '' });
      }

      const flushStdout = readLines(child.stdout, line => parseLine(line, 'stdout'), resetWatchdog);
      const flushStderr = readLines(child.stderr, line => parseLine(line, 'stderr'), resetWatchdog);
      for (const [stream, label] of [[child.stdout, '标准'], [child.stderr, '错误']]) {
        stream.on('error', error => terminate(new Error('下载程序' + label + '输出读取失败：' + error.message)));
      }
      child.on('error', error => finish(new Error('下载程序启动失败：' + error.message)));
      child.once('close', (code, signal) => {
        flushStdout();
        flushStderr();
        if (failure) return; // The termination promise also waits for any surviving process group.
        if (code === 0) return finish();
        const reason = signal ? '信号 ' + signal : '退出码 ' + (code ?? '未知');
        finish(new Error(errors.message() || '下载失败，请检查链接、登录状态或任务设置（' + reason + '）'));
      });
      resetWatchdog();
    });
  }

  return { run, stop };
}

module.exports = { createDownloadExecutor };
