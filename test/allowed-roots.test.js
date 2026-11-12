const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { collectAllowedLocalRoots } = require('../src/download/allowed-roots');
const { resolveTaskDestination } = require('../src/download/destination');
const { isAllowedLocalPath } = require('../src/security');

const safeName = value => String(value).replace(/[<>:"/\\|?*]/g, '_');
const settingsDownloadDir = path.resolve('current-downloads');
const defaultDownloadDir = path.resolve('default-downloads');
const oldDownloadDir = path.resolve('previous-custom-downloads');
const groupedDestination = path.join(oldDownloadDir, '我的合集');

function roots(history, tasks = []) {
  return collectAllowedLocalRoots({ settingsDownloadDir, defaultDownloadDir, history, tasks, safeName });
}

test('task destination groups non-video resources, keeps videos at root, and sanitizes names', () => {
  const root = path.resolve('downloads');
  const resolve = task => resolveTaskDestination({ outputDir: root, ...task }, safeName);
  assert.equal(resolve({ resourceType: 'video', title: '视频' }), root);
  assert.equal(resolve({ resourceType: 'collection', title: '合集' }), path.join(root, '合集'));
  assert.equal(resolve({ resourceType: 'video', folderName: '用户目录' }), path.join(root, '用户目录'));
  assert.equal(resolve({ folderName: 'part/one:*?' }), path.join(root, 'part_one___'));
});

test('a completed grouped task can retry from its pinned root after settings change', () => {
  const record = {
    outputDir: groupedDestination,
    retryTask: { outputDir: oldDownloadDir, folderName: '我的合集', resourceType: 'collection', title: '我的合集' }
  };
  assert.equal(isAllowedLocalPath(oldDownloadDir, roots([{ outputDir: groupedDestination }])), false);
  const allowed = roots([record]);
  assert.equal(isAllowedLocalPath(oldDownloadDir, allowed), true);
  assert.equal(isAllowedLocalPath(groupedDestination, allowed), true);
  assert.equal(isAllowedLocalPath(settingsDownloadDir, allowed), true);
});

test('video history retry authorization remains pinned to its recorded root', () => {
  const record = {
    outputDir: oldDownloadDir,
    retryTask: { outputDir: oldDownloadDir, resourceType: 'video', title: '单视频' }
  };
  const allowed = roots([record]);
  assert.equal(allowed.includes(oldDownloadDir), true);
  assert.equal(isAllowedLocalPath(oldDownloadDir, allowed), true);
});

test('unrelated, empty and relative history paths cannot widen retry root access', () => {
  const outside = path.resolve('unrelated-downloads');
  const history = [
    { outputDir: groupedDestination, retryTask: { outputDir: outside, folderName: '我的合集' } },
    { outputDir: '', retryTask: { outputDir: outside } },
    { outputDir: 'relative/path', retryTask: { outputDir: outside } }
  ];
  const allowed = roots(history, [{ outputDir: '' }, { outputDir: 'relative/path' }]);
  assert.equal(allowed.includes(outside), false);
  assert.equal(allowed.includes(''), false);
  assert.equal(isAllowedLocalPath(outside, allowed), false);
  assert.equal(isAllowedLocalPath(oldDownloadDir, allowed), false);
});

test('active task output directories remain allowed', () => {
  const activeRoot = path.resolve('active-custom-downloads');
  assert.equal(isAllowedLocalPath(activeRoot, roots([], [{ outputDir: activeRoot }])), true);
});
