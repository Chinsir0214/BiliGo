const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertBilibiliUrl, assertExternalUrl, isAllowedLocalPath } = require('../src/security');

test('external links are limited to Bilibili and this app release page', () => {
  assert.equal(assertBilibiliUrl('https://www.bilibili.com/video/BV1'), 'https://www.bilibili.com/video/BV1');
  assert.equal(assertExternalUrl('https://github.com/Chinsir0214/BiliGo/releases'), 'https://github.com/Chinsir0214/BiliGo/releases');
  assert.throws(() => assertExternalUrl('https://github.com/someone/other'), /不允许打开/);
  assert.throws(() => assertExternalUrl('https://bilibili.com.evil.example/video'), /不允许打开/);
  assert.throws(() => assertExternalUrl('http://www.bilibili.com/video/BV1'), /不允许打开/);
  assert.throws(() => assertExternalUrl('https://user:pass@www.bilibili.com/video/BV1'), /不允许打开/);
});

test('local path checks reject siblings and linked escapes', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'biligo-security-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'downloads');
  const outside = path.join(base, 'downloads-other');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  assert.equal(isAllowedLocalPath(path.join(root, 'new-file.mp4'), [root]), true);
  assert.equal(isAllowedLocalPath(path.join(outside, 'file.mp4'), [root]), false);

  const link = path.join(root, 'linked');
  try { fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return; throw error; }
  assert.equal(isAllowedLocalPath(path.join(link, 'file.mp4'), [root]), false);
});
