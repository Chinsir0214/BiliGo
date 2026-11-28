const { createJsonStore, SCHEMA_VERSION } = require('./infra/json-store');

class LocalDataReadError extends Error {
  constructor(filePath, label, reason, cause) {
    super(`${label}读取失败：${reason}（${filePath}）`, { cause });
    this.name = 'LocalDataReadError';
    this.code = cause?.code || 'INVALID_LOCAL_DATA';
    this.path = filePath;
  }
}

function createLocalDataReader({ fs } = {}) {
  function settings(filePath) {
    return createJsonStore(filePath, {
      fs, initial: () => ({}),
      decode(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('内容必须是对象');
        return value;
      },
      encode: value => ({ ...value, schemaVersion: SCHEMA_VERSION })
    });
  }

  function history(filePath) {
    return createJsonStore(filePath, {
      fs, initial: () => [],
      decode(value) {
        const items = value?.schemaVersion === SCHEMA_VERSION ? value.items : value;
        if (!Array.isArray(items)) throw new Error('内容必须是数组');
        return items;
      },
      encode: items => ({ schemaVersion: SCHEMA_VERSION, items })
    });
  }

  function read(store, filePath, label) {
    try { return store(filePath).read(); }
    catch (cause) { throw new LocalDataReadError(filePath, label, cause.message, cause); }
  }

  return {
    readHistory: file => read(history, file, '下载记录'),
    readSettings: file => read(settings, file, '设置'),
    writeHistory: (file, items) => history(file).write(items),
    writeSettings: (file, value) => settings(file).write(value)
  };
}

module.exports = { createLocalDataReader, LocalDataReadError };
