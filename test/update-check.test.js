const assert = require('node:assert/strict');
const test = require('node:test');
const { createUpdateChecker } = require('../src/update');

test('uses the published updater version when available', async () => {
  const calls = [];
  const check = createUpdateChecker({
    getCurrentVersion: () => '1.3.0',
    checkForUpdates: async () => ({ updateInfo: { version: '1.4.0' } }),
    requestJson: async url => { calls.push(url); throw new Error('unexpected API request'); }
  });
  assert.deepEqual(await check(), {
    currentVersion: '1.3.0',
    latestVersion: '1.4.0',
    hasUpdate: true,
    pageUrl: 'https://github.com/Chinsir0214/BiliGo/releases/latest'
  });
  assert.deepEqual(calls, []);
});

test('falls back to the latest published GitHub release', async () => {
  const calls = [];
  const check = createUpdateChecker({
    getCurrentVersion: () => '1.3.0',
    checkForUpdates: async () => { throw new Error('feed unavailable'); },
    requestJson: async url => {
      calls.push(url);
      return { tag_name: 'v1.3.0', html_url: 'https://github.com/Chinsir0214/BiliGo/releases/tag/v1.3.0' };
    }
  });
  assert.deepEqual(await check(), {
    currentVersion: '1.3.0',
    latestVersion: '1.3.0',
    hasUpdate: false,
    pageUrl: 'https://github.com/Chinsir0214/BiliGo/releases/tag/v1.3.0'
  });
  assert.deepEqual(calls, ['https://api.github.com/repos/Chinsir0214/BiliGo/releases/latest']);
});

test('reports failure when both published release sources are unavailable', async () => {
  const calls = [];
  const check = createUpdateChecker({
    getCurrentVersion: () => '1.3.0',
    checkForUpdates: async () => { throw new Error('feed unavailable'); },
    requestJson: async url => { calls.push(url); throw new Error('API unavailable'); }
  });
  await assert.rejects(check(), /更新检查失败：API unavailable/);
  assert.deepEqual(calls, ['https://api.github.com/repos/Chinsir0214/BiliGo/releases/latest']);
});

test('rejects a release without a version rather than claiming the app is current', async () => {
  const check = createUpdateChecker({
    getCurrentVersion: () => '1.3.0',
    checkForUpdates: async () => ({ updateInfo: {} }),
    requestJson: async () => ({ name: 'Latest build' })
  });
  await assert.rejects(check(), /更新检查失败：发布版本缺少版本号/);
});
