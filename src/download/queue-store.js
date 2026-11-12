const fs = require('node:fs');
const path = require('node:path');

function queueReadError(candidate, reason, cause) {
  const error = new Error(`队列快照读取失败：${reason}（${candidate}）`, { cause });
  error.code = cause?.code || 'INVALID_QUEUE_SNAPSHOT';
  return error;
}

function parseSnapshot(text, restoreTask) {
  let value;
  try { value = JSON.parse(text); }
  catch (error) { throw new Error('JSON 内容损坏', { cause: error }); }
  const entries = Array.isArray(value) ? value : value?.tasks;
  if (!Array.isArray(entries)) throw new Error('任务列表必须是数组');
  return entries.map(entry => {
    const task = entry?.task ?? entry;
    if (!task || typeof task !== 'object' || Array.isArray(task)) throw new Error('任务内容必须是对象');
    return restoreTask(task);
  });
}

function createQueueStore(filePath, { fs: fileSystem = fs } = {}) {
  const directory = path.dirname(filePath);
  const tempPrefix = `${path.basename(filePath)}.tmp-`;

  function readCandidate(candidate, readFile) {
    try {
      return readFile(candidate);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw queueReadError(candidate, error.message, error);
    }
  }

  function read(restoreTask = task => task) {
    const candidates = [filePath];
    try {
      for (const name of fileSystem.readdirSync(directory)) {
        if (name.startsWith(tempPrefix)) candidates.push(path.join(directory, name));
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw queueReadError(directory, error.message, error);
    }

    const snapshots = [];
    for (const candidate of candidates) {
      const stat = readCandidate(candidate, file => fileSystem.statSync(file));
      if (stat) snapshots.push({ candidate, modified: stat.mtimeMs });
    }
    snapshots.sort((a, b) => b.modified - a.modified);

    let invalid;
    for (const { candidate } of snapshots) {
      const text = readCandidate(candidate, file => fileSystem.readFileSync(file, 'utf8'));
      if (text === null) continue;
      try {
        return parseSnapshot(text, restoreTask);
      } catch (error) {
        invalid ||= queueReadError(candidate, error.message, error);
      }
    }
    if (invalid) throw invalid;
    return [];
  }

  function write(items) {
    if (!Array.isArray(items)) throw new TypeError('队列快照必须是数组');
    fileSystem.mkdirSync(directory, { recursive: true });
    const tempPath = path.join(directory, `${tempPrefix}${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const handle = fileSystem.openSync(tempPath, 'wx');
    try {
      try {
        fileSystem.writeFileSync(handle, JSON.stringify(items, null, 2), 'utf8');
        fileSystem.fsyncSync(handle);
      } finally { fileSystem.closeSync(handle); }
      fileSystem.renameSync(tempPath, filePath);
    } catch (error) {
      try { fileSystem.unlinkSync(tempPath); } catch (_) {}
      throw error;
    }
    try {
      for (const name of fileSystem.readdirSync(directory)) {
        if (name.startsWith(tempPrefix)) fileSystem.unlinkSync(path.join(directory, name));
      }
    } catch (_) { /* Stale temp files are harmless and can aid recovery. */ }
  }

  return { read, write };
}

module.exports = { createQueueStore };
