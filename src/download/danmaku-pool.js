const { availableParallelism } = require('node:os');
const { Worker } = require('node:worker_threads');

function createDanmakuWorkerPool({ limit = Math.max(1, Math.min(2, availableParallelism() - 1)), idleMs = 5000 } = {}) {
  const workers = new Set();
  const pending = [];
  let closing;

  function settle(job, error, bytes) {
    job.signal?.removeEventListener('abort', job.abort);
    if (job.signal?.aborted) job.reject(job.signal.reason);
    else if (error) job.reject(error);
    else job.resolve(bytes);
  }

  function stop(slot) {
    if (slot.termination) return slot.termination;
    slot.stopping = true;
    clearTimeout(slot.timer);
    slot.termination = slot.worker.terminate();
    return slot.termination;
  }

  function startWorker() {
    const worker = new Worker(require.resolve('./danmaku-worker'));
    const slot = { worker, job: null, stopping: false, timer: null, failure: null };
    workers.add(slot);
    worker.on('message', ({ ok, bytes, message }) => {
      if (slot.stopping) return;
      settle(slot.job, ok ? null : new Error(message), bytes);
      slot.job = null;
      worker.unref();
      slot.timer = setTimeout(() => stop(slot), idleMs).unref();
      pump();
    });
    worker.once('error', error => { slot.failure = error; });
    worker.once('exit', code => {
      clearTimeout(slot.timer);
      workers.delete(slot);
      if (slot.job) settle(slot.job, slot.failure || new Error(`弹幕处理线程异常退出（${code}）`));
      pump();
    });
    return slot;
  }

  function pump() {
    while (!closing && pending.length) {
      let slot = [...workers].find(candidate => !candidate.job && !candidate.stopping);
      if (!slot && workers.size >= limit) return;
      const job = pending.shift();
      try {
        slot ??= startWorker();
        clearTimeout(slot.timer);
        slot.worker.ref();
        slot.job = job;
        job.slot = slot;
        slot.worker.postMessage(job.input, [job.input.body]);
      } catch (error) {
        if (!slot) settle(job, error);
        else {
          slot.failure = error;
          stop(slot);
        }
      }
    }
  }

  function decode(body, encoding, maxBytes, signal) {
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      if (closing) throw new Error('弹幕处理线程池已关闭');
      const job = { input: { body, encoding, maxBytes }, signal, resolve, reject, slot: null };
      job.abort = () => {
        if (job.slot) stop(job.slot);
        else {
          const index = pending.indexOf(job);
          if (index !== -1) {
            pending.splice(index, 1);
            settle(job);
          }
        }
      };
      signal?.addEventListener('abort', job.abort, { once: true });
      pending.push(job);
      pump();
    });
  }

  function shutdown() {
    if (!closing) {
      const error = new Error('弹幕处理线程池已关闭');
      for (const job of pending.splice(0)) settle(job, error);
      closing = Promise.all([...workers].map(slot => {
        slot.failure = error;
        return stop(slot);
      }));
    }
    return closing;
  }

  return { decode, shutdown, destroy: shutdown };
}

module.exports = { createDanmakuWorkerPool };
