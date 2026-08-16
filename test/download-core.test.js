const assert = require('node:assert/strict');
const test = require('node:test');
const { DOWNLOAD_DEFAULTS } = require('../src/download/constants');
const { normalizeContentModes, limitRateArg } = require('../src/download/formats');
const { validateDownloadData } = require('../src/download/request');
const { createDownloadTask } = require('../src/download/task');
const { createDownloadQueue } = require('../src/download/queue');

test('normalizes download modes and rate limits', () => {
  assert.deepEqual(normalizeContentModes('video+audio, subtitle'), ['video-audio', 'subtitle']);
  assert.equal(limitRateArg('5M'), '625000B');
  assert.equal(limitRateArg('invalid'), '');
});

test('validates download requests at the service boundary', () => {
  const result = validateDownloadData({ url: 'https://www.bilibili.com/video/BV1', contentModes: ['video-audio', 'cover'] }, {
    assertBilibiliUrl: value => value,
    isAllowedLocalPath: () => true
  });
  assert.deepEqual(result.contentModes, ['video-audio', 'cover']);
  assert.throws(() => validateDownloadData(null, {}), /下载参数无效/);
  assert.throws(() => validateDownloadData({ url: 'https://www.bilibili.com/video/BV1', contentModes: ['video', 'audio'] }, { assertBilibiliUrl: value => value, isAllowedLocalPath: () => true }), /下载类型冲突/);
  assert.throws(() => validateDownloadData({ url: 'https://www.bilibili.com/video/BV1', contentModes: ['audio'], embedSubs: true }, { assertBilibiliUrl: value => value, isAllowedLocalPath: () => true }), /嵌入字幕仅支持视频模式/);
  assert.throws(() => validateDownloadData({ url: 'https://www.bilibili.com/video/BV1', contentModes: ['video'], videoQuality: 'invalid' }, { assertBilibiliUrl: value => value, isAllowedLocalPath: () => true }), /视频画质无效/);
});

test('creates a task from request data and settings', () => {
  const task = createDownloadTask({ url: 'https://www.bilibili.com/video/BV1', urls: [], contentModes: ['video'], filenameTemplate: '' }, { title: '示例', thumbnail: '' }, {});
  assert.equal(task.title, '示例');
  assert.equal(task.videoQuality, DOWNLOAD_DEFAULTS.videoQuality);
  assert.equal(task.filenameTemplate, DOWNLOAD_DEFAULTS.filenameTemplate);
});

test('queue respects concurrency and completes queued work', async () => {
  const running = new Set(); let peak = 0; const completed = [];
  const queue = createDownloadQueue({
    read: () => [], write: () => {}, serialize: task => task,
    maxConcurrency: () => 2,
    processTask: async task => { running.add(task.id); peak = Math.max(peak, running.size); await new Promise(resolve => setTimeout(resolve, 5)); running.delete(task.id); completed.push(task.id); }
  });
  queue.enqueue({ id: 'a', url: 'a', contentModes: ['video'] });
  queue.enqueue({ id: 'b', url: 'b', contentModes: ['video'] });
  queue.enqueue({ id: 'c', url: 'c', contentModes: ['video'] });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(peak, 2);
  assert.deepEqual(completed.sort(), ['a', 'b', 'c']);
});

test('queue can cancel a queued task', () => {
  const queue = createDownloadQueue({ read: () => [], write: () => {}, serialize: task => task, processTask: () => new Promise(() => {}), maxConcurrency: () => 1 });
  queue.enqueue({ id: 'active', url: 'a', contentModes: ['video'] });
  queue.enqueue({ id: 'queued', url: 'b', contentModes: ['video'] });
  assert.equal(queue.cancelQueued('queued').id, 'queued');
  assert.equal(queue.cancelQueued('missing'), null);
});
