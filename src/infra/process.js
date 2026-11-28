const { spawn } = require('node:child_process');

const stopping = new WeakMap();

function killProcessTree(child, { spawnProcess = spawn, forceAfterMs = 1500 } = {}) {
  if (!child) return Promise.resolve();
  if (stopping.has(child)) return stopping.get(child);

  const windows = process.platform === 'win32';
  const pid = Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null;
  const delay = Number.isFinite(forceAfterMs) ? Math.max(0, forceAfterMs) : 1500;
  const stopped = new Promise(resolve => {
    let closed = false;
    let finished = false;
    let deadline;
    let fallback;

    function finish() {
      finished = true;
      clearTimeout(deadline);
      clearTimeout(fallback);
      child.removeListener('close', onClose);
      resolve();
    }
    function groupAlive() {
      if (windows || !pid) return false;
      try { process.kill(-pid, 0); return true; }
      catch (error) { return error.code === 'EPERM'; }
    }
    function onClose() {
      closed = true;
      if (!groupAlive()) finish();
    }
    function signalTree(signal) {
      if (!windows && pid) {
        try { process.kill(-pid, signal); return; }
        catch { /* The process may have exited or have no separate process group. */ }
      }
      if (!closed && child.exitCode == null && child.signalCode == null) {
        try { child.kill(signal); } catch { /* Process already gone. */ }
      }
    }

    child.once('close', onClose);
    deadline = setTimeout(() => {
      signalTree('SIGKILL');
      if (closed || finished) return finish();
      fallback = setTimeout(finish, Math.min(Math.max(delay, 1), 1000));
    }, delay);

    if (child.exitCode != null || child.signalCode != null) {
      if (!windows && groupAlive()) signalTree('SIGTERM');
      return;
    }
    if (windows && pid) {
      try {
        const killer = spawnProcess('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
        killer.once('error', () => signalTree('SIGTERM'));
        killer.once('close', code => { if (code !== 0) signalTree('SIGTERM'); });
      } catch { signalTree('SIGTERM'); }
    } else {
      signalTree('SIGTERM');
    }
  });
  stopping.set(child, stopped);
  return stopped;
}

function createYtdlpErrorExtractor() {
  let errorLine = '';
  let exception = '';
  let inTraceback = false;
  function push(rawLine, stream = 'stderr') {
    const line = rawLine.trim();
    if (/^(?:\[[^\]]+\]\s*)?ERROR\s*:/i.test(line)) {
      errorLine = line;
      if (stream === 'stderr') inTraceback = false;
      return;
    }
    if (stream !== 'stderr') return;
    if (/^Traceback \(most recent call last\):$/.test(line)) {
      inTraceback = true;
    } else if (inTraceback && /^[\w.]+(?:Error|Exception|Interrupt):\s*/.test(line)) {
      exception = '下载程序异常：' + line;
      inTraceback = false;
    }
  }
  return { push, message: () => errorLine || exception };
}

module.exports = { killProcessTree, createYtdlpErrorExtractor };
