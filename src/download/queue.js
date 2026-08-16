function createDownloadQueue({ read, write, serialize, processTask, maxConcurrency }) {
  const downloadQueue = [];
  const activeTasks = new Map();

  function save() { write(downloadQueue); }

  function load() {
    const saved = read().filter(item => item && item.url && Array.isArray(item.contentModes) && item.contentModes.length);
    downloadQueue.push(...saved);
  }

  function pump() {
    const limit = Math.max(1, Math.min(10, Number(maxConcurrency()) || 1));
    while (activeTasks.size < limit && downloadQueue.length) {
      const task = downloadQueue.shift();
      activeTasks.set(task.id, task);
      Promise.resolve().then(() => processTask(task)).finally(() => {
        activeTasks.delete(task.id);
        pump();
      });
    }
    save();
  }

  function enqueue(task) {
    downloadQueue.push(task);
    save();
    pump();
    return downloadQueue.length + activeTasks.size;
  }

  function cancelQueued(id) {
    const index = downloadQueue.findIndex(task => task.id === id);
    if (index < 0) return null;
    const [task] = downloadQueue.splice(index, 1);
    task.cancelled = true;
    save();
    return task;
  }

  function requeueActive(stopTask) {
    for (const task of activeTasks.values()) {
      const wasCancelled = task.cancelled;
      task.cancelled = true;
      stopTask(task);
      if (!wasCancelled && !downloadQueue.some(queued => queued.id === task.id)) downloadQueue.unshift(serialize(task));
    }
    save();
  }

  return { downloadQueue, activeTasks, load, save, pump, enqueue, cancelQueued, requeueActive };
}

module.exports = { createDownloadQueue };
