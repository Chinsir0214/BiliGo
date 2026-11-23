const INITIAL_RETRY_MS = 250;
const MAX_RETRY_MS = 5000;

function withoutRuntimeState(task) {
  const { cancelled, finalized, interrupted, process, queueStatus, ...saved } = task;
  return saved;
}

function createDownloadQueue({ read, write, serialize, processTask, maxConcurrency, onTaskError, onPersistenceError }) {
  const downloadQueue = [];
  const activeTasks = new Map();
  let stopping = false;
  let pendingCompletion;
  let retryTimer;
  let retryDelay = INITIAL_RETRY_MS;

  function persistentTask(task) {
    return withoutRuntimeState(serialize(task));
  }

  function snapshot() {
    const entries = [];
    for (const task of activeTasks.values()) {
      if (!task.cancelled && !task.finalized) entries.push({ ...persistentTask(task), queueStatus: 'running' });
    }
    for (const task of downloadQueue) {
      if (!task.cancelled) entries.push({ ...persistentTask(task), queueStatus: 'queued' });
    }
    return entries;
  }

  function save() {
    write(snapshot());
    pendingCompletion = undefined;
  }

  function load() {
    const entries = read();
    if (!Array.isArray(entries)) throw new TypeError('恢复任务列表必须是数组');
    const knownIds = new Set([...activeTasks.keys(), ...downloadQueue.map(task => task.id)]);
    for (const task of entries) {
      if (!task || !task.id || !task.url || !Array.isArray(task.contentModes) || !task.contentModes.length || knownIds.has(task.id)) continue;
      downloadQueue.push(withoutRuntimeState(task));
      knownIds.add(task.id);
    }
  }

  async function reportError(report, ...args) {
    try { await report?.(...args); } catch (_) { /* Error reporting must not reject the queue worker. */ }
  }

  function retryPersistence(task, error) {
    const firstFailure = retryDelay === INITIAL_RETRY_MS;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      pump();
    }, retryDelay);
    retryTimer.unref();
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
    if (firstFailure) {
      if (onPersistenceError) void reportError(onPersistenceError, error);
      else void reportError(onTaskError, task, error);
    }
  }

  async function execute(task) {
    try {
      await processTask(task);
    } catch (error) {
      await reportError(onTaskError, task, error);
    } finally {
      activeTasks.delete(task.id);
      if (!stopping) {
        pendingCompletion = task;
        try { pump(); } catch (error) { await reportError(onTaskError, task, error); }
      }
    }
  }

  function pump() {
    if (stopping || retryTimer) return;
    if (pendingCompletion) {
      try { save(); } catch (error) {
        retryPersistence(pendingCompletion, error);
        return;
      }
    }
    const limit = Math.max(1, Math.min(10, Number(maxConcurrency()) || 1));
    while (activeTasks.size < limit && downloadQueue.length) {
      const task = downloadQueue.shift();
      activeTasks.set(task.id, task);
      try { save(); } catch (error) {
        activeTasks.delete(task.id);
        downloadQueue.unshift(task);
        retryPersistence(task, error);
        return;
      }
      void execute(task);
    }
    retryDelay = INITIAL_RETRY_MS;
  }

  function enqueue(task) {
    if (stopping) throw new Error('应用正在退出');
    if (!task?.id || activeTasks.has(task.id) || downloadQueue.some(queued => queued.id === task.id)) throw new Error('下载任务 ID 无效或重复');
    downloadQueue.push(task);
    try { save(); } catch (error) { downloadQueue.pop(); throw error; }
    pump();
    return downloadQueue.length + activeTasks.size;
  }

  function cancelQueued(id) {
    const index = downloadQueue.findIndex(task => task.id === id);
    if (index < 0) return null;
    const [task] = downloadQueue.splice(index, 1);
    task.cancelled = true;
    try { save(); } catch (error) {
      task.cancelled = false;
      downloadQueue.splice(index, 0, task);
      throw error;
    }
    return task;
  }

  function requeueActive(stopTask, shouldFinish = () => false) {
    stopping = true;
    clearTimeout(retryTimer);
    for (const task of activeTasks.values()) {
      if (task.finalized || shouldFinish(task)) continue;
      const wasCancelled = task.cancelled;
      task.cancelled = true;
      try {
        const result = stopTask(task);
        if (result && typeof result.then === 'function') void Promise.resolve(result).catch(error => reportError(onTaskError, task, error));
      } catch (error) { void reportError(onTaskError, task, error); }
      if (!wasCancelled && !downloadQueue.some(queued => queued.id === task.id)) downloadQueue.unshift(persistentTask(task));
    }
    save();
  }

  return { downloadQueue, activeTasks, load, save, pump, enqueue, cancelQueued, requeueActive };
}

module.exports = { createDownloadQueue };
