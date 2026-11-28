const fs = require('node:fs');
const { createJsonStore, atomicWriteFile } = require('../infra/json-store');

function parseSnapshot(value, restoreTask, quarantine) {
  if (value?.schemaVersion !== undefined && value.schemaVersion !== 1) throw new Error('不支持的队列快照版本');
  const entries = Array.isArray(value) ? value : value?.tasks;
  if (!Array.isArray(entries)) throw new Error('任务列表必须是数组');
  const valid = [];
  const rejected = [];
  for (const [index, entry] of entries.entries()) {
    try {
      const task = entry?.task ?? entry;
      if (!task || typeof task !== 'object' || Array.isArray(task)) throw new TypeError('任务内容必须是对象');
      valid.push(restoreTask(task));
    } catch (error) {
      rejected.push({ index, entry, reason: error.message });
    }
  }
  if (rejected.length) quarantine(rejected);
  return valid;
}

function createQueueStore(filePath, { fs: fileSystem = fs, onWarning = console.warn } = {}) {
  function store(restoreTask) {
    return createJsonStore(filePath, {
      fs: fileSystem, initial: [], recoverTemps: true,
      decode: (value, candidate) => parseSnapshot(value, restoreTask, rejected => {
        try { atomicWriteFile(candidate + '.rejected.json', JSON.stringify(rejected), { fs: fileSystem }); }
        catch (error) { onWarning(error); }
      }),
      encode: tasks => ({ schemaVersion: 1, tasks })
    });
  }

  function read(restoreTask = task => task) {
    try { return store(restoreTask).read(); }
    catch (cause) {
      throw Object.assign(new Error('队列快照读取失败：' + cause.message, { cause }), { code: cause.code });
    }
  }
  function write(items) {
    if (!Array.isArray(items)) throw new TypeError('队列快照必须是数组');
    store(task => task).write(items);
  }
  return { read, write };
}

module.exports = { createQueueStore };
