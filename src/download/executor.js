const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

function createDownloadExecutor({ resolveYtdlp, pushCookieArgs, send, spawnProcess = spawn }) {
  function stop(task) {
    task.danmakuController?.abort(new Error('下载已取消'));
    const child = task.process;
    if (!child || child.killed) return;
    if (process.platform === 'win32' && child.pid) {
      const terminator = spawnProcess('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      const fallback = () => {
        if (!child.killed && child.exitCode == null && child.signalCode == null) child.kill('SIGTERM');
      };
      terminator.on('error', fallback);
      terminator.on('close', code => { if (code !== 0) fallback(); });
    } else child.kill('SIGTERM');
  }

  function run(task, args, urls) {
    return new Promise((resolve, reject) => {
      const processArgs = pushCookieArgs([...args]);
      processArgs.push(...urls);
      const child = spawnProcess(resolveYtdlp(), processArgs, {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
      });
      task.process = child;
      let lastProgressAt = 0;
      let lastError = '';
      let inTraceback = false;
      let settled = false;

      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (task.process === child) task.process = null;
        error ? reject(error) : resolve();
      };
      const parseLine = rawLine => {
        if (settled) return;
        const line = rawLine.trim();
        if (!line) return;
        const percent = line.match(/^(?:\[download\]\s*)?(\d+(?:\.\d+)?)%(?:\s|$)/);
        const value = percent ? Number(percent[1]) : null;
        if (value === null || value < 0 || value > 100) {
          if (/^(?:\[[^\]]+\]\s*)?ERROR\s*:/i.test(line)) {
            lastError = line;
            inTraceback = false;
          } else if (/^Traceback \(most recent call last\):$/.test(line)) {
            inTraceback = true;
            if (!lastError) lastError = '下载程序异常：Traceback';
          } else if (inTraceback && /^[\w.]+(?:Error|Exception|Interrupt):\s*/.test(line)) {
            lastError = `下载程序异常：${line}`;
            inTraceback = false;
          }
          return;
        }
        const speed = line.match(/at\s+([^\s]+\/s)/);
        const eta = line.match(/ETA\s+([^\s]+)/);
        const now = Date.now();
        if (now - lastProgressAt < 200 && value !== 100) return;
        lastProgressAt = now;
        send('download:progress', { id: task.id, line, percent: value, speed: speed?.[1] || '', eta: eta?.[1] || '' });
      };
      const bufferedLines = (stream, label) => {
        const decoder = new StringDecoder('utf8');
        let pending = '';
        stream.on('data', chunk => {
          pending += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          const lines = pending.split(/[\r\n]/);
          pending = lines.pop();
          for (const line of lines) parseLine(line);
        });
        stream.on('error', error => {
          if (settled) return;
          if (!task.cancelled) {
            try { stop(task); } catch { /* Keep the original stream error. */ }
          }
          finish(new Error(task.cancelled ? '下载已取消' : `下载程序${label}输出读取失败：${error.message}`));
        });
        return () => {
          pending += decoder.end();
          parseLine(pending);
          pending = '';
        };
      };

      const flushStdout = bufferedLines(child.stdout, '标准');
      const flushStderr = bufferedLines(child.stderr, '错误');
      child.on('error', error => finish(new Error(task.cancelled ? '下载已取消' : `下载程序启动失败：${error.message}`)));
      child.on('close', (code, signal) => {
        flushStdout();
        flushStderr();
        if (code === 0) return finish();
        const exitReason = signal ? `信号 ${signal}` : `退出码 ${code ?? '未知'}`;
        finish(new Error(task.cancelled ? '下载已取消' : lastError || `下载失败，请检查链接、登录状态或任务设置（${exitReason}）`));
      });
    });
  }

  return { run, stop };
}

module.exports = { createDownloadExecutor };
