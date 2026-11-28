const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');
const { createDanmakuDownloader } = require('../src/download/danmaku');
const { createDanmakuWorkerPool } = require('../src/download/danmaku-pool');

function createHarness({ body, chunks, encoding, status = 200, maxBytes = 1024 * 1024, responseError, data = { pages: [{ cid: 60521536 }] } }) {
  const requests = [];
  const viewRequests = [];
  const writes = [];
  const https = {
    get(url, options, onResponse) {
      requests.push({ url, options });
      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.destroy = error => { if (error) queueMicrotask(() => req.emit('error', error)); };
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = status;
        response.headers = encoding ? { 'content-encoding': encoding } : {};
        response.destroy = () => {};
        onResponse(response);
        // Split the body to exercise chunk boundaries, including UTF-8 characters.
        if (chunks) for (const chunk of chunks) response.emit('data', chunk);
        else for (let i = 0; i < body.length; i += 3) response.emit('data', body.subarray(i, i + 3));
        if (responseError) response.emit('error', responseError);
        response.emit('end');
      });
      return req;
    }
  };
  const dependencies = {
    httpsClient: https, maxTextBytes: maxBytes,
    requestJson: async (url, headers, options) => {
      viewRequests.push({ url, headers, options });
      return { code: 0, data };
    },
    cookieHeader: () => 'test-cookie',
    fs: { promises: { writeFile: async (file, bytes) => writes.push([file, Buffer.from(bytes).toString('utf8')]) } },
    path, safeName: value => value
  };
  return { ...createDanmakuDownloader(dependencies), requests, viewRequests, writes };
}

const xml = '<?xml version="1.0" encoding="UTF-8"?><i><chatid>60521536</chatid><d p="1,1,25">你好 &amp; 世界</d></i>';
const videoUrl = 'https://www.bilibili.com/video/av34547179';

test('downloads the requested part by page number and defaults to P1', async () => {
  const harness = createHarness({ body: Buffer.from(xml), data: {
    cid: 90,
    pages: [{ page: 2, cid: 102 }, { page: 1, cid: 101 }, { page: 3, cid: 103 }]
  } });
  const url = 'https://www.bilibili.com/video/BV123';
  await harness.downloadDanmaku(`${url}?p=3`, '第三 P', 'stage');
  await harness.downloadDanmaku(url, '第一 P', 'stage');
  assert.deepEqual(harness.requests.map(({ url }) => new URL(url).searchParams.get('oid')), ['103', '101']);
  assert.deepEqual(harness.viewRequests[0], {
    url: 'https://api.bilibili.com/x/web-interface/view?bvid=BV123',
    headers: { Referer: 'https://www.bilibili.com/', Cookie: 'test-cookie' },
    options: { signal: harness.requests[0].options.signal }
  });
});

test('uses the top-level cid for single videos and a listed P1 without a cid', async () => {
  for (const data of [{ cid: 60521536 }, { cid: 60521536, pages: [{ page: 1 }] }]) {
    const harness = createHarness({ body: Buffer.from(xml), data });
    await harness.downloadDanmaku(`${videoUrl}?p=1`, '测试弹幕', 'stage');
    assert.equal(harness.requests[0].url, 'https://api.bilibili.com/x/v1/dm/list.so?oid=60521536');
    assert.equal(harness.viewRequests[0].url, 'https://api.bilibili.com/x/web-interface/view?aid=34547179');
  }
});

test('rejects malformed and ambiguous part numbers before requesting metadata', async () => {
  const harness = createHarness({ body: Buffer.from(xml) });
  for (const query of ['p=', 'p=0', 'p=-1', 'p=2x', 'p=1.5', 'p=9007199254740992', 'p=1&P=2']) {
    await assert.rejects(harness.downloadDanmaku(`${videoUrl}?${query}`, '测试弹幕', 'stage'), /分 P 编号无效/);
  }
  assert.equal(harness.viewRequests.length, 0);
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.writes.length, 0);
});

test('rejects missing parts and missing cids without downloading P1', async () => {
  for (const [data, page, error] of [
    [{ cid: 101 }, 2, /没有第 2 P/],
    [{ pages: [{ page: 1, cid: 101 }, { page: 3, cid: 103 }] }, 2, /没有第 2 P/],
    [{ cid: 101, pages: [{ page: 1, cid: 101 }, { page: 2 }] }, 2, /无法获取视频第 2 P 弹幕/]
  ]) {
    const harness = createHarness({ body: Buffer.from(xml), data });
    await assert.rejects(harness.downloadDanmaku(`${videoUrl}?p=${page}`, '测试弹幕', 'stage'), error);
    assert.equal(harness.requests.length, 0);
    assert.equal(harness.writes.length, 0);
  }
});

for (const [label, encoding, encode] of [
  ['uncompressed', undefined, value => value],
  ['gzip', 'gzip', zlib.gzipSync],
  ['zlib deflate', 'deflate', zlib.deflateSync],
  ['raw deflate', 'deflate', zlib.deflateRawSync]
]) {
  test(`downloads valid ${label} danmaku XML`, async () => {
    const harness = createHarness({ body: encode(Buffer.from(xml)), encoding });
    const file = await harness.downloadDanmaku(videoUrl, '测试弹幕', 'stage');
    assert.equal(file, path.join('stage', '测试弹幕 [av34547179].xml'));
    assert.deepEqual(harness.writes[0], [file, xml]);
    assert.equal(harness.requests[0].options.headers['Accept-Encoding'], 'gzip, deflate');
  });
}

test('rejects non-XML and malformed XML before writing a file', async () => {
  for (const content of [
    '{"code":-1}', '<i><d>broken</i>', '<i><d>bad &amp</d></i>',
    '<i x="bad &bogus;"></i>', '<i>foo]]>bar</i>',
    '<i x="one" x="two"/>', '<i><!-- bad -- comment --></i>',
    '<i>&#0;</i>'
  ]) {
    const harness = createHarness({ body: zlib.deflateRawSync(Buffer.from(content)), encoding: 'deflate' });
    await assert.rejects(harness.downloadDanmaku(videoUrl, '测试弹幕', 'stage'), /弹幕响应不是有效 XML/);
    assert.equal(harness.writes.length, 0);
  }
});

test('accepts valid escaped text, CDATA and comments', async () => {
  const content = '<i x="a &amp; b"><!-- okay --><d><![CDATA[<raw> &]]></d></i>';
  const harness = createHarness({ body: Buffer.from(content) });
  await harness.downloadDanmaku(videoUrl, '测试弹幕', 'stage');
  assert.equal(harness.writes[0][1], content);
});

test('preserves UTF-8 bytes and the original handling of leading byte order marks', async () => {
  for (let count = 0; count <= 3; count += 1) {
    const body = Buffer.from('\uFEFF'.repeat(count) + '<i>🌙</i>');
    const harness = createHarness({ body });
    await harness.downloadDanmaku(videoUrl, '测试弹幕', 'stage');
    assert.equal(harness.writes[0][1], '\uFEFF'.repeat(Math.max(0, count - 2)) + '<i>🌙</i>');
  }
});

test('rejects malformed compression, unsupported encoding and invalid UTF-8', async () => {
  for (const [body, encoding, message] of [
    [Buffer.from('garbage'), 'deflate', /弹幕响应解码失败/],
    [Buffer.from(xml), 'br', /不支持的弹幕响应压缩格式/],
    [Buffer.from([0xff]), undefined, /弹幕响应解码失败/]
  ]) {
    const harness = createHarness({ body, encoding });
    await assert.rejects(harness.downloadDanmaku(videoUrl, '测试弹幕', 'stage'), message);
    assert.equal(harness.writes.length, 0);
  }
});

test('limits inflated response size before writing a file', async () => {
  const harness = createHarness({ body: zlib.deflateRawSync(Buffer.from(xml.repeat(20))), encoding: 'deflate', maxBytes: 200 });
  await assert.rejects(harness.downloadDanmaku(videoUrl, '测试弹幕', 'stage'), /弹幕响应解压后过大/);
  assert.equal(harness.writes.length, 0);
});

test('rejects oversized compressed body before a following end can resolve a valid prefix', async () => {
  const validPrefix = Buffer.from(xml);
  const harness = createHarness({
    body: validPrefix,
    chunks: [validPrefix, Buffer.from('x')],
    maxBytes: validPrefix.length
  });
  await assert.rejects(harness.downloadDanmaku(videoUrl, '测试弹幕', 'stage'), /响应体过大/);
  assert.equal(harness.writes.length, 0);
});

test('rejects a response stream error even if end follows', async () => {
  const harness = createHarness({ body: Buffer.from(xml), responseError: new Error('socket broken') });
  await assert.rejects(harness.downloadDanmaku(videoUrl, '测试弹幕', 'stage'), /socket broken/);
  assert.equal(harness.writes.length, 0);
});

test('rejects an HTTP error even when its body resembles valid XML', async () => {
  const harness = createHarness({ body: Buffer.from(xml), status: 412 });
  await assert.rejects(harness.downloadDanmaku(videoUrl, '测试弹幕', 'stage'), /HTTP 412/);
  assert.equal(harness.writes.length, 0);
});

test('cancelling validation stops the worker before the download settles', async t => {
  const controller = new AbortController();
  const harness = createHarness({ body: Buffer.from(xml) });
  let exited = false;
  const onWorker = worker => {
    worker.once('exit', () => { exited = true; });
    controller.abort(new Error('下载已取消'));
  };
  process.once('worker', onWorker);
  t.after(() => process.removeListener('worker', onWorker));
  await assert.rejects(harness.downloadDanmaku(videoUrl, '测试弹幕', 'stage', controller.signal), /下载已取消/);
  assert.equal(exited, true);
  for (const request of [harness.requests[0], harness.viewRequests[0]]) {
    assert.equal(request.options.signal.aborted, true);
    assert.equal(request.options.signal.reason, controller.signal.reason);
  }
  assert.equal(harness.writes.length, 0);
});

test('bounded workers handle queued cancellation, reuse, failure recovery and idle release', async t => {
  const workers = [];
  const track = worker => workers.push(worker);
  process.on('worker', track);
  t.after(() => process.removeListener('worker', track));
  const pool = createDanmakuWorkerPool({ limit: 1, idleMs: 50 });
  const decode = (source, signal) => pool.decode(new TextEncoder().encode(source).buffer, 'identity', 1024, signal);
  const first = decode('<i>one</i>');
  const controller = new AbortController();
  const cancelled = decode('<i>two</i>', controller.signal);
  const third = decode('<i>three</i>');
  controller.abort(new Error('下载已取消'));
  await assert.rejects(cancelled, /下载已取消/);
  assert.equal(new TextDecoder().decode(await first), '<i>one</i>');
  assert.equal(new TextDecoder().decode(await third), '<i>three</i>');
  assert.equal(workers.length, 1);

  const failed = decode('<i>');
  const recovered = decode('<i/>');
  await assert.rejects(failed, /弹幕响应不是有效 XML/);
  assert.equal(new TextDecoder().decode(await recovered), '<i/>');
  // Invalid XML rejects the job, leaving the same worker available for the next one.
  assert.equal(workers.length, 1);
  workers[0].ref();
  await once(workers[0], 'exit');
});
