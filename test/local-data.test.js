const assert = require('node:assert/strict');
const test = require('node:test');
const { createLocalDataReader, LocalDataReadError } = require('../src/local-data');

test('missing local data uses defaults without writing or renaming files', () => {
  const reader = createLocalDataReader({ fs: { readFileSync() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } } });
  assert.deepEqual(reader.readHistory('history.json'), []);
  assert.deepEqual(reader.readSettings('settings.json'), {});
});

test('valid settings and history retain their contents', () => {
  const reader = createLocalDataReader({ fs: { readFileSync: file => file === 'settings.json' ? '{"retries":"5"}' : '[{"id":"old"}]' } });
  assert.deepEqual(reader.readSettings('settings.json'), { retries: '5' });
  assert.deepEqual(reader.readHistory('history.json'), [{ id: 'old' }]);
});

test('invalid JSON and root shapes fail instead of becoming empty data', () => {
  for (const [method, invalid] of [['readSettings', ['{', 'null', '[]', '5']], ['readHistory', ['{', 'null', '{}', '5']]]) {
    for (const text of invalid) {
      const reader = createLocalDataReader({ fs: { readFileSync: () => text } });
      assert.throws(() => reader[method]('data.json'), error => error instanceof LocalDataReadError && error.path === 'data.json' && error.code === 'INVALID_LOCAL_DATA');
    }
  }
});

test('permission and IO errors retain their causes and never mutate the original', () => {
  for (const code of ['EACCES', 'EIO']) {
    const cause = Object.assign(new Error('disk unavailable'), { code });
    const reader = createLocalDataReader({ fs: { readFileSync() { throw cause; } } });
    for (const method of ['readSettings', 'readHistory']) {
      assert.throws(() => reader[method]('data.json'), error => error instanceof LocalDataReadError && error.code === code && error.cause === cause && error.message.includes('data.json'));
    }
  }
});
