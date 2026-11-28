const assert = require('node:assert/strict');
const test = require('node:test');
const { identifyVideo, requestedVideoPage, fetchVideoInfo } = require('../src/resource/video-info');

const site = 'https://www.bilibili.com';
const bvid = 'BV1xx411c7mD';

test('identifies BV and av paths and bvid and aid query parameters', () => {
  assert.deepEqual(identifyVideo(`${site}/video/${bvid}`), { bvid });
  assert.deepEqual(identifyVideo(`${site}/video/av123`), { aid: '123' });
  assert.deepEqual(identifyVideo(`${site}/?bvid=${bvid}`), { bvid });
  assert.deepEqual(identifyVideo(`${site}/?aid=123`), { aid: '123' });
  assert.equal(identifyVideo(`${site}/video/av0`), null);
  assert.equal(identifyVideo(`${site}/?aid=0`), null);
});

test('reads the requested page and distinguishes invalid links from invalid page numbers', () => {
  const url = `${site}/video/${bvid}`;
  assert.equal(requestedVideoPage(url), null);
  assert.equal(requestedVideoPage(url + '?P=2'), 2);
  for (const query of ['?p=0', '?p=two', '?p=1&p=2']) {
    assert.throws(() => requestedVideoPage(url + query), { name: 'Error', message: '视频分 P 编号无效' });
  }
  for (const invalid of ['invalid URL', 'https://example.org/', null]) {
    assert.throws(() => requestedVideoPage(invalid), { name: 'Error', message: '视频链接无效' });
  }
});

test('fetches video data with the Bilibili referer, cookie and caller signal', async () => {
  const url = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
  const { signal } = new AbortController();
  const data = { bvid, title: 'Example video' };
  const result = await fetchVideoInfo({ bvid }, {
    cookieHeader(cookieUrl) {
      assert.equal(cookieUrl, url);
      return 'SESSDATA=test';
    },
    async requestJson(requestUrl, headers, options) {
      assert.equal(requestUrl, url);
      assert.equal(headers.Referer, site + '/');
      assert.equal(headers.Cookie, 'SESSDATA=test');
      assert.equal(options.signal, signal);
      return { code: 0, data };
    },
    signal
  });
  assert.deepEqual(result, data);
});

test('omits the Cookie header for an anonymous request', async () => {
  const data = { aid: 123 };
  const result = await fetchVideoInfo({ aid: '123' }, {
    cookieHeader: () => '',
    async requestJson(url, headers) {
      assert.equal(Object.hasOwn(headers, 'Cookie'), false);
      return { code: 0, data };
    }
  });
  assert.deepEqual(result, data);
});

test('preserves the API error code and message on rejection', async () => {
  await assert.rejects(fetchVideoInfo({ bvid }, {
    cookieHeader: () => '',
    requestJson: async () => ({ code: -404, message: '视频不存在' })
  }), { name: 'Error', apiCode: -404, message: '视频不存在' });
});
