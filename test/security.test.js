const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir } = require('./helpers/test-env');
const { assertBilibiliUrl, assertExternalUrl, isAllowedLocalPath } = require('../src/security');

test('external links are limited to Bilibili and this app release page', () => {
  assert.equal(assertBilibiliUrl('https://www.bilibili.com/video/BV1'), 'https://www.bilibili.com/video/BV1');
  assert.equal(assertExternalUrl('https://github.com/Chinsir0214/BiliGo/releases'), 'https://github.com/Chinsir0214/BiliGo/releases');
  assert.throws(() => assertExternalUrl('https://github.com/someone/other'), /不允许打开/);
  assert.throws(() => assertExternalUrl('https://bilibili.com.evil.example/video'), /不允许打开/);
  assert.throws(() => assertExternalUrl('http://www.bilibili.com/video/BV1'), /不允许打开/);
  assert.throws(() => assertExternalUrl('https://user:pass@www.bilibili.com/video/BV1'), /不允许打开/);
});

test('local path checks reject non-string targets', () => {
  for (const target of [{}, 123, null]) {
    assert.equal(isAllowedLocalPath(target, [__dirname]), false);
  }
});

test('local path checks allow new files under a root and reject siblings', t => {
  const base = createTempDir(t, 'biligo-security-');
  const root = path.join(base, 'downloads');
  const outside = path.join(base, 'downloads-other');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  assert.equal(isAllowedLocalPath(path.join(root, 'new-file.mp4'), [root]), true);
  assert.equal(isAllowedLocalPath(path.join(outside, 'file.mp4'), [root]), false);
});

test('local path checks reject linked escapes', t => {
  const base = createTempDir(t, 'biligo-symlink-');
  const root = path.join(base, 'downloads');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  const link = path.join(root, 'linked');
  try {
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      return t.skip(`Cannot create a directory link on this filesystem (${error.code})`);
    }
    throw error;
  }
  assert.equal(isAllowedLocalPath(path.join(link, 'file.mp4'), [root]), false);
});
