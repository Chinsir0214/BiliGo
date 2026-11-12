const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { defaults, normalizeSettings, applySettingsChanges } = require('../src/settings');

const downloadDir = path.resolve('BiliGo-test-downloads');

test('settings defaults and persisted values use one normalized shape', () => {
  assert.deepEqual(normalizeSettings({}, downloadDir), defaults(downloadDir));
  const restored = normalizeSettings({
    contentModes: ['audio'], embedSubs: true, audioFormat: 'bad',
    fragmentThreads: '100', maxConcurrentTasks: 'not-a-number'
  }, downloadDir);
  assert.deepEqual(restored.contentModes, ['audio']);
  assert.equal(restored.embedSubs, false);
  assert.equal(restored.audioFormat, 'original');
  assert.equal(restored.fragmentThreads, 16);
  assert.equal(restored.maxConcurrentTasks, 1);
});

test('a partial mode change cannot persist embedded subtitles without video', () => {
  const current = { contentModes: ['video'], embedSubs: true };
  const changed = applySettingsChanges(current, { contentModes: ['audio'] }, downloadDir, () => true);
  assert.deepEqual(changed.contentModes, ['audio']);
  assert.equal(changed.embedSubs, false);
  assert.throws(() => applySettingsChanges(current, { contentModes: ['audio'], embedSubs: true }, downloadDir, () => true), /嵌入字幕仅支持视频模式/);
  assert.throws(() => applySettingsChanges(current, { contentModes: [] }, downloadDir, () => true), /下载内容类型无效/);
});

test('settings updates validate directories and reject conflicting modes', () => {
  assert.throws(() => applySettingsChanges({}, { downloadDir: 'relative' }, downloadDir, () => true), /下载目录无效/);
  assert.throws(() => applySettingsChanges({}, { downloadDir }, downloadDir, () => false), /下载目录无效/);
  assert.throws(() => applySettingsChanges({}, { contentModes: ['video', 'audio'] }, downloadDir, () => true), /下载类型冲突/);
  assert.equal(applySettingsChanges({}, { downloadDir }, downloadDir, () => true).downloadDir, downloadDir);
});

test('settings normalize thread changes and retain the legacy best-video selector', () => {
  const changes = applySettingsChanges({}, { fragmentThreads: '2.5', videoQuality: 'bv' }, downloadDir, () => true);
  assert.equal(changes.fragmentThreads, 2);
  assert.equal(changes.videoQuality, 'bv*');
  assert.equal(normalizeSettings({ videoQuality: 'bv' }, downloadDir).videoQuality, 'bv*');
});

test('retry settings accept integer boundaries and repair invalid persisted values', () => {
  for (const value of [1, '1', 10, '10']) {
    assert.equal(normalizeSettings({ retries: value }, downloadDir).retries, String(value));
    assert.equal(applySettingsChanges({}, { retries: value }, downloadDir, () => true).retries, String(value));
  }
  for (const value of [0, '0', 11, '11', -1, 1.5, '1.5', NaN, Infinity, 'NaN', 'bad', '', null, true, {}]) {
    assert.equal(normalizeSettings({ retries: value }, downloadDir).retries, '3');
    assert.throws(() => applySettingsChanges({}, { retries: value }, downloadDir, () => true), /下载及分片重试次数无效.*1–10 的整数/);
  }
});
