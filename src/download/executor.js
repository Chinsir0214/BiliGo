const { spawn } = require('child_process');

function createDownloadExecutor({ resolveYtdlp, resolveFfmpeg, cookieFile, hasCookieFile, send, spawnProcess = spawn }) {
  function pushCookieArgs(args) {
    if (hasCookieFile()) args.push('--cookies', cookieFile);
    return args;
  }

  function stop(task) {
    const child = task.process;
    if (!child || child.killed) return;
    if (process.platform === 'win32' && child.pid) spawnProcess('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGTERM');
  }

  function run(task, args, urls) {
    return new Promise((resolve, reject) => {
      pushCookieArgs(args);
      args.push(...urls);
      const child = spawnProcess(resolveYtdlp(), args, { windowsHide: true });
      task.process = child;
      let lastProgressAt = 0;
      let lastError = '';
      let settled = false;

      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (task.process === child) task.process = null;
        error ? reject(error) : resolve();
      };
      const emitProgress = line => {
        const percent = line.match(/(\d+(?:\.\d+)?)%/);
        const speed = line.match(/at\s+([^\s]+\/s)/);
        const eta = line.match(/ETA\s+([^\s]+)/);
        const value = percent ? Number(percent[1]) : null;
        const now = Date.now();
        if (now - lastProgressAt < 200 && value !== 100) return;
        lastProgressAt = now;
        send('download:progress', { id: task.id, line, percent: value, speed: speed?.[1] || '', eta: eta?.[1] || '' });
      };
      const parse = chunk => {
        for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
          emitProgress(line);
          if (!/(\d+(?:\.\d+)?%|ETA\s+|at\s+[^\s]+\/s)/.test(line) && line.trim()) lastError = line.trim();
        }
      };

      child.stdout.on('data', parse);
      child.stderr.on('data', parse);
      child.on('error', error => finish(new Error(`下载程序启动失败：${error.message}`)));
      child.on('close', code => {
        if (code === 0) return finish();
        finish(new Error(task.cancelled ? '下载已取消' : lastError || `下载失败，请检查链接、登录状态或任务设置（退出码 ${code ?? '未知'}）`));
      });
    });
  }

  return { run, stop, resolveFfmpeg };
}

module.exports = { createDownloadExecutor };
