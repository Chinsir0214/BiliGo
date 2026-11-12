const fs = require('node:fs');

class LocalDataReadError extends Error {
  constructor(filePath, label, reason, cause) {
    super(`${label}读取失败：${reason}（${filePath}）`, { cause });
    this.name = 'LocalDataReadError';
    this.code = cause?.code || 'INVALID_LOCAL_DATA';
    this.path = filePath;
  }
}

function createLocalDataReader({ fs: fileSystem = fs } = {}) {
  function read(filePath, label, kind) {
    let text;
    try { text = fileSystem.readFileSync(filePath, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return kind === 'array' ? [] : {};
      throw new LocalDataReadError(filePath, label, error.message, error);
    }
    let value;
    try { value = JSON.parse(text); }
    catch (error) { throw new LocalDataReadError(filePath, label, 'JSON 内容损坏', error); }
    const valid = kind === 'array' ? Array.isArray(value) : value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!valid) throw new LocalDataReadError(filePath, label, kind === 'array' ? '内容必须是数组' : '内容必须是对象');
    return value;
  }

  return {
    readHistory: filePath => read(filePath, '下载记录', 'array'),
    readSettings: filePath => read(filePath, '设置', 'object')
  };
}

module.exports = { createLocalDataReader, LocalDataReadError };
