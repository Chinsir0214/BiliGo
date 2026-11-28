const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const SCHEMA_VERSION = 1;
const STALE_TEMP_MS = 24 * 60 * 60 * 1000;
const transientLocks = new Set(['EPERM', 'EACCES', 'EBUSY']);
const sleeper = new Int32Array(new SharedArrayBuffer(4));

function assertSchemaVersion(value) {
  if (value?.schemaVersion !== undefined && value.schemaVersion !== SCHEMA_VERSION) {
    const error = new Error(`不支持的数据版本：${value.schemaVersion}`);
    error.code = 'UNSUPPORTED_SCHEMA_VERSION';
    throw error;
  }
}

function renameWithRetry(source, target, fileSystem) {
  for (let attempt = 0; ; attempt++) {
    try { fileSystem.renameSync(source, target); return; }
    catch (error) {
      if (process.platform !== 'win32' || !transientLocks.has(error.code) || attempt === 4) throw error;
      Atomics.wait(sleeper, 0, 0, 5 * 2 ** attempt);
    }
  }
}

function atomicWriteFile(filePath, text, { fs: fileSystem = fs } = {}) {
  fileSystem.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  const handle = fileSystem.openSync(temporary, 'wx', 0o600);
  try {
    try {
      fileSystem.writeFileSync(handle, text, 'utf8');
      fileSystem.fsyncSync(handle);
    } finally { fileSystem.closeSync(handle); }
    renameWithRetry(temporary, filePath, fileSystem);
  } catch (error) {
    try { fileSystem.unlinkSync(temporary); } catch { /* Preserve the write error. */ }
    throw error;
  }
}

function createJsonStore(filePath, {
  fs: fileSystem = fs, decode = value => value, encode = value => value,
  initial, recoverTemps = false
} = {}) {
  const directory = path.dirname(filePath);
  const prefix = path.basename(filePath) + '.tmp-';
  const backup = filePath + '.bak';

  function readText(candidate) {
    try { return fileSystem.readFileSync(candidate, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return undefined; }
  }

  function parse(text, candidate) {
    let value;
    try { value = JSON.parse(text); }
    catch (cause) { throw new Error('JSON 内容损坏', { cause }); }
    assertSchemaVersion(value);
    return decode(value, candidate);
  }

  function tempFiles() {
    let names;
    try { names = fileSystem.readdirSync(directory); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const entries = [];
    for (const name of names.filter(name => name.startsWith(prefix))) {
      const candidate = path.join(directory, name);
      try {
        const stat = fileSystem.statSync(candidate);
        if (stat.isFile()) entries.push({ candidate, modified: stat.mtimeMs });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return entries.sort((a, b) => b.modified - a.modified);
  }

  function* candidates() {
    yield filePath;
    yield backup;
    if (recoverTemps) for (const entry of tempFiles()) yield entry.candidate;
  }

  function read() {
    let invalid;
    for (const candidate of candidates()) {
      const text = readText(candidate);
      if (text === undefined) continue;
      try { return parse(text, candidate); }
      catch (error) {
        if (error.code === 'UNSUPPORTED_SCHEMA_VERSION') throw error;
        invalid ??= error;
      }
    }
    if (invalid) throw invalid;
    return typeof initial === 'function' ? initial() : initial;
  }

  function write(value) {
    const text = JSON.stringify(encode(value));
    const previous = readText(filePath);
    if (previous !== undefined) {
      let valid = true;
      try { parse(previous, filePath); }
      catch (error) {
        if (error.code === 'UNSUPPORTED_SCHEMA_VERSION') throw error;
        valid = false;
      }
      if (valid) atomicWriteFile(backup, previous, { fs: fileSystem });
    }
    atomicWriteFile(filePath, text, { fs: fileSystem });
    if (recoverTemps) {
      try {
        for (const entry of tempFiles()) {
          if (Date.now() - entry.modified > STALE_TEMP_MS) fileSystem.unlinkSync(entry.candidate);
        }
      } catch { /* The snapshot has already been committed. Retry housekeeping on the next write. */ }
    }
  }

  return { read, write };
}

module.exports = { createJsonStore, atomicWriteFile, SCHEMA_VERSION, assertSchemaVersion };
