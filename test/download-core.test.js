const assert = require('node:assert/strict');
const test = require('node:test');
const { DOWNLOAD_DEFAULTS } = require('../src/download/constants');
const { limitRateArg, ytdlpDownloadArgs, audioFormatArgs } = require('../src/download/formats');
const { getMediaCapabilities, parseRetryCount } = require('../src/download/options');
const { validateDownloadData } = require('../src/download/request');
const { createDownloadTask, serializeTaskForQueue } = require('../src/download/task');
const { createDownloadQueue } = require('../src/download/queue');
const { normalizeSettings } = require('../src/settings');

const url = 'https://www.bilibili.com/video/BV1';
const requestValidation = { assertBilibiliUrl: value => value, isAllowedLocalPath: () => true };

test('converts valid rate limits and ignores invalid ones', () => {
  assert.equal(limitRateArg('5M'), '625000B');
  assert.equal(limitRateArg('invalid'), '');
});

test('normalizes valid content modes and rejects invalid download requests', () => {
  const validate = options => validateDownloadData({ url, ...options }, requestValidation);
  assert.deepEqual(validate({ contentModes: 'video+audio, cover, cover, subtitle' }).contentModes, ['video-audio', 'cover', 'subtitle']);
  assert.deepEqual(validate({ mode: 'video', embedSubs: true }).contentModes, ['video']);
  assert.throws(() => validate({ contentModes: ['video'], itemTitles: '标题' }), TypeError);
  assert.deepEqual(validate({ contentModes: ['video'], itemTitles: ['标题', 2] }).itemTitles, ['标题', '2']);
  assert.throws(() => validateDownloadData(null, requestValidation), /下载参数无效/);
  assert.throws(() => validate({ contentModes: [] }), /下载内容类型无效/);
  assert.throws(() => validate({ contentModes: ['unknown'] }), /下载内容类型无效/);
  assert.throws(() => validate({ contentModes: ['video', 'audio'] }), /下载类型冲突/);
  assert.throws(() => validate({ contentModes: ['audio'], embedSubs: true }), /嵌入字幕仅支持视频模式/);
  assert.throws(() => validate({ contentModes: ['video'], videoQuality: 'invalid' }), /视频画质无效/);
});

test('accepts only integer retry counts from 1 through 10 at request and command boundaries', () => {
  const validate = retries => validateDownloadData({ url, contentModes: ['video'], retries }, requestValidation);
  for (const value of [1, '1', 3, '3', 10, '10']) {
    assert.equal(parseRetryCount(value), Number(value));
    assert.equal(validate(value).retries, Number(value));
    const args = ytdlpDownloadArgs({ retries: value }, ['video'], () => 'ffmpeg');
    assert.equal(args[args.indexOf('--retries') + 1], String(value));
    assert.equal(args[args.indexOf('--fragment-retries') + 1], String(value));
  }
  for (const value of [0, '0', 11, '11', -1, 1.5, '1.5', NaN, Infinity, 'NaN', 'bad', '', null, true, {}]) {
    assert.equal(parseRetryCount(value), null);
    assert.throws(() => validate(value), /下载及分片重试次数无效.*1–10 的整数/);
    assert.throws(() => ytdlpDownloadArgs({ retries: value }, ['video'], () => 'ffmpeg'), /下载及分片重试次数无效.*1–10 的整数/);
  }
});

test('yt-dlp download arguments abort unavailable fragments and back off HTTP and fragment retries', () => {
  const args = ytdlpDownloadArgs({}, ['video-audio'], () => 'ffmpeg');
  assert.deepEqual(args.slice(0, 17), [
    '--newline', '--no-warnings', '--progress', '--no-playlist', '--ffmpeg-location', 'ffmpeg',
    '--retries', '3', '--fragment-retries', '3', '--abort-on-unavailable-fragments',
    '--retry-sleep', 'http:exp=1:10', '--retry-sleep', 'fragment:exp=1:10', '-N', '4'
  ]);
  assert.deepEqual(args.slice(17), ['--http-chunk-size', '10M']);
});

test('auxiliary content preserves the selected media capabilities', async () => {
  const { validateDownloadForm } = await import('../src/download/form.mjs');
  const extras = ['cover', 'subtitle', 'danmaku'];
  const form = { selectedItems: [{}], subtitleValues: ['zh-Hans:normal'], embedSubs: true };

  for (const [mediaMode, hasVideo, hasAudio] of [
    ['audio', false, true], ['video', true, false], ['video-audio', true, true], [undefined, false, false]
  ]) {
    const modes = mediaMode ? [...extras, mediaMode] : extras;
    assert.deepEqual(getMediaCapabilities(modes), { mediaMode, hasVideo, hasAudio, hasMedia: mediaMode !== undefined });
    assert.equal(validateDownloadForm({ ...form, modes }), hasVideo ? '' : '嵌入字幕仅支持视频模式');
    assert.equal(ytdlpDownloadArgs({}, modes, () => 'ffmpeg').includes('--http-chunk-size'), hasAudio);
  }

  const data = validateDownloadData({ url, contentModes: ['audio', ...extras], audioFormat: 'mp3' }, requestValidation);
  const task = createDownloadTask(data, { title: '示例' }, { contentModes: ['video'], embedSubs: true });
  const args = [];
  audioFormatArgs(task, args);
  assert.deepEqual(args, ['-f', 'ba/b', '--extract-audio', '--audio-format', 'mp3']);
  assert.equal(task.embedSubs, false);
});

test('uses one fragment thread value in settings, form requests, tasks and command arguments', async () => {
  const { buildDownloadRequest } = await import('../src/download/form.mjs');
  for (const [value, expected] of [
    [1, 1], ['2.5', 2], [16, 16], ['100', 16], [0, 4], [-1, 4],
    ['', 4], [null, 4], [true, 4], ['bad', 4], [Infinity, 4]
  ]) {
    const settings = normalizeSettings({ fragmentThreads: value });
    const request = buildDownloadRequest({ sourceUrl: url, modes: ['video'], fragmentThreads: value }, { title: '示例' });
    const data = validateDownloadData({ ...request, fragmentThreads: value }, requestValidation);
    const task = createDownloadTask({ ...data, fragmentThreads: value }, { title: '示例' }, settings);
    const args = ytdlpDownloadArgs({ ...task, fragmentThreads: value }, ['video'], () => 'ffmpeg');
    assert.equal(settings.fragmentThreads, expected);
    assert.equal(request.fragmentThreads, expected);
    assert.equal(data.fragmentThreads, expected);
    assert.equal(task.fragmentThreads, expected);
    assert.equal(args[args.indexOf('-N') + 1], String(expected));
  }

  const data = validateDownloadData({ url, contentModes: ['video'] }, requestValidation);
  assert.equal(createDownloadTask(data, { title: '示例' }, { fragmentThreads: '8' }).fragmentThreads, 8);
});

test('restores legacy best-video quality in persisted download requests', () => {
  const data = validateDownloadData({ url, contentModes: ['video'], videoQuality: 'bv' }, requestValidation);
  const task = createDownloadTask(data, { title: '示例' }, {});
  assert.equal(task.videoQuality, DOWNLOAD_DEFAULTS.videoQuality);
});

test('creates a task from request data and settings', () => {
  const task = createDownloadTask({ url: 'https://www.bilibili.com/video/BV1', urls: [], contentModes: ['video'], filenameTemplate: '' }, { title: '示例', thumbnail: '' }, {});
  assert.equal(task.title, '示例');
  assert.equal(task.videoQuality, DOWNLOAD_DEFAULTS.videoQuality);
  assert.equal(task.filenameTemplate, DOWNLOAD_DEFAULTS.filenameTemplate);
});

test('download form builds a request without UI-only state', async () => {
  const { buildDownloadRequest } = await import('../src/download/form.mjs');
  const request = buildDownloadRequest({
    sourceUrl: 'https://www.bilibili.com/video/BV1',
    selectedItems: [{ title: '示例' }],
    subtitleValues: ['zh-Hans:normal'],
    modes: ['video-audio', 'subtitle'],
    folderName: '合集',
    audioFormat: 'm4a',
    embedSubs: true,
    fragmentThreads: '8'
  }, { title: '示例', url: 'https://www.bilibili.com/video/BV2' });
  assert.deepEqual(request, {
    url: 'https://www.bilibili.com/video/BV2',
    urls: ['https://www.bilibili.com/video/BV2'],
    itemTitles: ['示例'],
    title: '示例',
    folderName: '合集',
    resourceType: 'video',
    contentModes: ['video-audio', 'subtitle'],
    audioFormat: 'm4a',
    embedSubs: true,
    fragmentThreads: 8
  });
});

test('batch submission sends one request list and reports each matching task', async () => {
  const { enqueueBatchItems } = await import('../src/download/submit.mjs');
  const entries = ['A', 'B'];
  const tasks = [{ id: 'first' }, { id: 'second' }];
  const submissions = [];
  const queued = [];
  const submit = items => enqueueBatchItems(items, title => ({ title }), async requests => {
    submissions.push(requests);
    return { tasks };
  }, (entry, task) => queued.push([entry, task]));

  assert.deepEqual(await submit([]), { queued: 0, remaining: 0, error: null });
  assert.deepEqual(await submit(entries), { queued: 2, remaining: 0, error: null });
  assert.deepEqual(submissions, [[{ title: 'A' }, { title: 'B' }]]);
  assert.deepEqual(queued, [['A', tasks[0]], ['B', tasks[1]]]);
});

test('batch submission keeps all entries pending when the queue rejects or returns incomplete tasks', async () => {
  const { enqueueBatchItems } = await import('../src/download/submit.mjs');
  const entries = ['A', 'B'];
  const failure = new Error('queue unavailable');
  const submit = startDownloads => enqueueBatchItems(entries, entry => entry, startDownloads,
    () => assert.fail('Unconfirmed task reported as queued'));

  assert.deepEqual(await submit(async () => { throw failure; }), { queued: 0, remaining: 2, error: failure });
  const incomplete = await submit(async () => ({ tasks: [{ id: 'first' }, {}] }));
  assert.equal(incomplete.queued, 0);
  assert.equal(incomplete.remaining, 2);
  assert.match(incomplete.error.message, /任务编号/);
});

test('queue serialization preserves task options without runtime state', () => {
  const task = createDownloadTask({
    url: 'https://www.bilibili.com/video/BV1',
    contentModes: ['video-audio'],
    embedMetadata: true,
    subtitleLangs: 'zh-Hans',
    audioFormat: 'm4a'
  }, { title: '示例', thumbnail: '' }, {}, 'task-1');
  task.process = { pid: 123 };
  task.cancelled = true;
  task.finalized = true;
  task.interrupted = true;
  task.queueStatus = 'running';
  task.privateToken = 'secret';
  task.context = task;
  const saved = serializeTaskForQueue(task);
  assert.equal(saved.id, 'task-1');
  assert.equal(saved.embedMetadata, true);
  assert.equal(saved.subtitleLangs, 'zh-Hans');
  assert.equal(saved.audioFormat, 'm4a');
  for (const key of ['process', 'cancelled', 'finalized', 'interrupted', 'queueStatus', 'privateToken', 'context']) {
    assert.equal(Object.hasOwn(saved, key), false);
  }
  assert.match(saved.queuedAt, /^\d{4}-\d\d-\d\dT/);
});

test('queue respects concurrency and completes queued work', async () => {
  const releaseFirst = Promise.withResolvers();
  const releaseSecond = Promise.withResolvers();
  const thirdStarted = Promise.withResolvers();
  const drained = Promise.withResolvers();
  const started = [];
  const completed = [];
  const queue = createDownloadQueue({
    read: () => [], serialize: task => task,
    write: entries => { if (entries.length === 0) drained.resolve(); },
    maxConcurrency: () => 2,
    processTask: async ({ id }) => {
      started.push(id);
      if (id === 'a') await releaseFirst.promise;
      if (id === 'b') await releaseSecond.promise;
      if (id === 'c') thirdStarted.resolve();
      completed.push(id);
    }
  });
  for (const id of ['a', 'b', 'c']) {
    queue.enqueue({ id, url: id, contentModes: ['video'] });
  }
  assert.deepEqual(started, ['a', 'b']);
  releaseFirst.resolve();
  await thirdStarted.promise;
  assert.deepEqual(completed, ['a', 'c']);
  releaseSecond.resolve();
  await drained.promise;
  assert.deepEqual(completed, ['a', 'c', 'b']);
  assert.equal(queue.activeTasks.size, 0);
});

test('queue can cancel a queued task', () => {
  const queue = createDownloadQueue({ read: () => [], write: () => {}, serialize: task => task, processTask: () => new Promise(() => {}), maxConcurrency: () => 1 });
  queue.enqueue({ id: 'active', url: 'a', contentModes: ['video'] });
  queue.enqueue({ id: 'queued', url: 'b', contentModes: ['video'] });
  assert.equal(queue.cancelQueued('queued').id, 'queued');
  assert.equal(queue.cancelQueued('missing'), null);
});
