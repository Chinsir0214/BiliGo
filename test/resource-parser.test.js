const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createResourceParser, subtitleLanguages } = require('../src/resource/parser');

function fakeProcess(run) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCount = 0;
  child.kill = () => {
    child.killCount += 1;
    queueMicrotask(() => child.emit('close', null));
    return true;
  };
  queueMicrotask(() => run(child));
  return child;
}

function parser(overrides = {}) {
  return createResourceParser({
    requestJson: async () => { throw new Error('unexpected API request'); },
    cookieHeader: () => 'SESSDATA=test',
    playerSubtitleLanguages: async () => [],
    assertBilibiliUrl: url => url,
    pushCookieArgs: args => args.push('--cookies', 'cookies.txt'),
    spawn: () => { throw new Error('unexpected yt-dlp call'); },
    resolveYtdlp: () => 'yt-dlp',
    ...overrides
  });
}

test('favorite parsing loads every page at once and retains resource metadata', async () => {
  const calls = [];
  const medias = Array.from({ length: 45 }, (_, index) => ({
    id: index + 1,
    bvid: `BV${index + 1}`,
    title: `第 ${index + 1} 项`,
    cover: index === 0 ? 'cover.jpg' : '',
    duration: index === 0 ? '1:20' : 0
  }));
  const resourceParser = parser({
    requestJson: async (url, options) => {
      calls.push({ url, options });
      const page = Number(new URL(url).searchParams.get('pn'));
      return {
        code: 0,
        data: {
          info: { title: page === 1 ? '我的收藏夹' : '', media_count: 45 },
          has_more: page < 3,
          medias: medias.slice((page - 1) * 20, page * 20)
        }
      };
    }
  });
  const result = await resourceParser.parseResource('https://www.bilibili.com/list/ml123?fid=456');
  assert.deepEqual(calls.map(call => Number(new URL(call.url).searchParams.get('pn'))), [1, 2, 3]);
  assert.equal(calls[0].options.headers.Cookie, 'SESSDATA=test');
  assert.deepEqual({ type: result.type, favoriteId: result.favoriteId, title: result.title, total: result.total }, {
    type: 'favorite', favoriteId: '456', title: '我的收藏夹', total: 45
  });
  assert.equal(result.items.length, 45);
  assert.deepEqual(result.items.map(item => item.id), medias.map(item => item.bvid));
  assert.equal(result.items[0].duration, 80);
  assert.equal(result.thumbnail, 'cover.jpg');
});

test('favorite page helper validates input and preserves page data', async () => {
  const calls = [];
  const resourceParser = parser({
    requestJson: async url => {
      calls.push(url);
      return { code: 0, data: { info: { media_count: 21 }, has_more: false, medias: [{ id: 2, bvid: 'BVsecond', title: '第二项' }] } };
    }
  });
  const next = await resourceParser.parseFavoritePage('456', 2);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /media_id=456&ps=20&pn=2/);
  assert.equal(next.hasMore, false);
  assert.equal(next.total, 21);
  assert.equal(next.items[0].id, 'BVsecond');
  await resourceParser.parseFavoritePage('456', 501);
  assert.match(calls[1], /media_id=456&ps=20&pn=501/);
  await assert.rejects(resourceParser.parseFavoritePage('456&pn=1', 2), /收藏夹 ID 无效/);
  await assert.rejects(resourceParser.parseFavoritePage('456', 0), /收藏夹页码无效/);
});

test('favorite availability depends on a video ID rather than title keywords', async () => {
  const titles = ['修复网络不可用的问题', '登录失效怎么办', '找回已删除文件'];
  const resourceParser = parser({ requestJson: async () => ({ code: 0, data: {
    info: { media_count: 4 }, has_more: false,
    medias: [
      ...titles.map((title, index) => ({ id: index + 1, bvid: `BV${index + 1}`, title })),
      { id: 4, title: '已失效视频' }
    ]
  } }) });

  const result = await resourceParser.parseResource('https://www.bilibili.com/list/ml123?fid=456');
  assert.deepEqual(result.items.slice(0, 3).map(item => item.title), titles);
  assert.deepEqual(result.items.slice(0, 3).map(item => item.unavailable), [false, false, false]);
  assert.deepEqual(result.items.slice(0, 3).map(item => item.url), [1, 2, 3].map(id => `https://www.bilibili.com/video/BV${id}`));
  assert.equal(result.items[3].unavailable, true);
  assert.equal(result.items[3].url, '');
});

test('favorite pages keep API order with at most six concurrent requests', async () => {
  const medias = Array.from({ length: 160 }, (_, index) => ({ id: index + 1, bvid: `BV${index + 1}`, title: `视频 ${index + 1}` }));
  let active = 0;
  let maximumActive = 0;
  const resourceParser = parser({
    requestJson: async url => {
      const page = Number(new URL(url).searchParams.get('pn'));
      maximumActive = Math.max(maximumActive, ++active);
      await new Promise(resolve => setTimeout(resolve, page === 2 ? 10 : 1));
      active -= 1;
      return { code: 0, data: {
        info: { title: '并发收藏夹', media_count: medias.length },
        has_more: page < 8,
        medias: medias.slice((page - 1) * 20, page * 20)
      } };
    }
  });

  const result = await resourceParser.parseResource('https://www.bilibili.com/list/ml123?fid=456');
  assert.equal(maximumActive, 6);
  assert.deepEqual(result.items.map(item => item.id), medias.map(item => item.bvid));
});

test('favorite parsing follows has_more beyond a stale total and deduplicates overlapping pages', async () => {
  const pages = [
    { info: { title: '收藏夹', media_count: 20 }, has_more: true, medias: [{ id: 1, bvid: 'BVfirst', title: '第一项' }] },
    { info: { media_count: 20 }, has_more: true, medias: [{ id: 1, bvid: 'BVfirst', title: '重复项' }, { id: 2, bvid: 'BVsecond', title: '第二项' }] },
    { info: { media_count: 20 }, has_more: false, medias: [{ id: 3, bvid: 'BVthird', title: '第三项' }] }
  ];
  const calls = [];
  const resourceParser = parser({ requestJson: async url => {
    const page = Number(new URL(url).searchParams.get('pn'));
    calls.push(page);
    return { code: 0, data: pages[page - 1] };
  } });

  const result = await resourceParser.parseResource('https://www.bilibili.com/list/ml123?fid=456');
  assert.deepEqual(calls, [1, 2, 3]);
  assert.deepEqual(result.items.map(item => item.id), ['BVfirst', 'BVsecond', 'BVthird']);
  assert.equal(result.total, 20);
});

test('favorite parsing ignores failed prefetched pages after the first terminal page', async () => {
  const calls = [];
  const resourceParser = parser({ requestJson: async url => {
    const page = Number(new URL(url).searchParams.get('pn'));
    calls.push(page);
    if (page > 3) throw new Error(`越界页 ${page}`);
    if (page === 3) await new Promise(resolve => setTimeout(resolve, 5));
    return { code: 0, data: {
      info: { title: '收藏夹', media_count: 200 },
      has_more: page < 3,
      medias: [{ id: page, bvid: `BV${page}` }]
    } };
  } });

  const result = await resourceParser.parseResource('https://www.bilibili.com/list/ml123?fid=456');
  assert.deepEqual(calls, [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(result.items.map(item => item.id), ['BV1', 'BV2', 'BV3']);
  assert.equal(result.total, 200);
});

test('favorite parsing returns without waiting for requests beyond the terminal page', { timeout: 2000 }, async t => {
  let releaseTail;
  const tail = new Promise(resolve => { releaseTail = resolve; });
  let signalTailStarted;
  const tailStarted = new Promise(resolve => { signalTailStarted = resolve; });
  t.after(() => releaseTail());
  const resourceParser = parser({ requestJson: async url => {
    const page = Number(new URL(url).searchParams.get('pn'));
    if (page > 3) {
      signalTailStarted();
      await tail;
      throw new Error(`尾随页 ${page} 失败`);
    }
    return { code: 0, data: {
      info: { media_count: 200 },
      has_more: page < 3,
      medias: [{ id: page, bvid: `BV${page}` }]
    } };
  } });

  const parsed = resourceParser.parseResource('https://www.bilibili.com/list/ml123?fid=456');
  await tailStarted;
  const result = await Promise.race([
    parsed,
    tail.then(() => { throw new Error('解析等待了终止页之后的请求'); })
  ]);
  assert.deepEqual(result.items.map(item => item.id), ['BV1', 'BV2', 'BV3']);
  releaseTail();
  await new Promise(resolve => setImmediate(resolve));
});

test('favorite parsing still propagates failure before a prefetched terminal page', async () => {
  const resourceParser = parser({ requestJson: async url => {
    const page = Number(new URL(url).searchParams.get('pn'));
    if (page === 2) throw new Error('第 2 页读取失败');
    return { code: 0, data: {
      info: { media_count: 200 },
      has_more: page < 3,
      medias: [{ id: page, bvid: `BV${page}` }]
    } };
  } });

  await assert.rejects(resourceParser.parseResource('https://www.bilibili.com/list/ml123?fid=456'), /第 2 页读取失败/);
});

test('favorite parsing propagates a later page failure instead of returning partial items', async () => {
  const resourceParser = parser({ requestJson: async url => {
    const page = Number(new URL(url).searchParams.get('pn'));
    if (page === 3) return { code: -400, message: '第 3 页读取失败' };
    return { code: 0, data: { info: { media_count: 60 }, has_more: true, medias: [{ id: page, bvid: `BV${page}` }] } };
  } });

  await assert.rejects(resourceParser.parseResource('https://www.bilibili.com/list/ml123?fid=456'), /第 3 页读取失败/);
});

test('favorite parsing rejects an empty page that still advertises more results', async () => {
  const resourceParser = parser({ requestJson: async () => ({ code: 0, data: {
    info: { media_count: 100 }, has_more: true, medias: []
  } }) });
  await assert.rejects(resourceParser.parseResource('https://www.bilibili.com/list/ml123?fid=456'), /有更多内容但当前页为空/);
});

test('favorite parsing rejects repeated pages that cannot make progress', async () => {
  let requests = 0;
  const resourceParser = parser({ requestJson: async () => {
    requests += 1;
    return { code: 0, data: { info: { media_count: 20 }, has_more: true, medias: [{ id: 1, bvid: 'BVfirst' }] } };
  } });
  await assert.rejects(resourceParser.parseResource('https://www.bilibili.com/list/ml123?fid=456'), /没有新条目/);
  assert.equal(requests, 2);
});

test('video API keeps multiple parts and subtitle metadata', async () => {
  const queriedCids = [];
  const resourceParser = parser({
    requestJson: async () => ({ code: 0, data: {
      title: '分 P 视频', pic: 'cover', pages: [{ cid: 101, page: 1, part: '上', duration: 10 }, { cid: 102, page: 2, part: '下', duration: 11 }],
      subtitle: { list: [{ lan: 'zh-CN', lan_doc: '中文' }] }
    } }),
    playerSubtitleLanguages: async (_, cid) => {
      queriedCids.push(cid);
      return cid === 101
        ? [{ value: 'en:normal', label: 'English' }]
        : [{ value: 'ja:normal', label: '日本語' }];
    }
  });
  const result = await resourceParser.parseResource('https://www.bilibili.com/video/BV123');
  assert.equal(result.type, 'parts');
  assert.equal(result.items.length, 2);
  assert.deepEqual(queriedCids, [101, 102]);
  assert.equal(result.items[1].url, 'https://www.bilibili.com/video/BV123?p=2');
  assert.deepEqual(result.items[0].subtitleLanguages.map(item => item.value), ['zh-CN:normal', 'en:normal']);
  assert.deepEqual(result.items[1].subtitleLanguages.map(item => item.value), ['ja:normal']);
});

test('AV video metadata uses the view API and retains top-level cid subtitles', async () => {
  const requests = [];
  const subtitleCalls = [];
  const resourceParser = parser({
    requestJson: async (url, options) => {
      requests.push({ url, options });
      return { code: 0, data: { bvid: 'BV123', cid: 101, title: '单 P 视频', duration: 10, pic: 'cover' } };
    },
    playerSubtitleLanguages: async (...args) => {
      subtitleCalls.push(args);
      return [{ value: 'en:normal', label: 'English' }];
    }
  });
  const url = 'https://www.bilibili.com/video/av123';
  const result = await resourceParser.parseResource(url);
  assert.deepEqual(requests, [{
    url: 'https://api.bilibili.com/x/web-interface/view?aid=123',
    options: { headers: { Cookie: 'SESSDATA=test' } }
  }]);
  assert.deepEqual(subtitleCalls, [['BV123', 101]]);
  assert.deepEqual(result.items, [{
    id: 'BV123', title: '单 P 视频', url, thumbnail: 'cover', duration: 10,
    subtitleLanguages: [{ value: 'en:normal', label: 'English' }]
  }]);
});

test('explicit parts are validated against page numbers while listing the full video', async () => {
  let requests = 0;
  let spawned = false;
  const resourceParser = parser({
    requestJson: async () => {
      requests += 1;
      return { code: 0, data: { title: '分 P 视频', pages: [{ cid: 103, page: 3 }, { cid: 101, page: 1 }] } };
    },
    spawn: () => { spawned = true; throw new Error('unexpected fallback'); }
  });
  const url = 'https://www.bilibili.com/video/BV123';
  const result = await resourceParser.parseResource(`${url}?p=3`);
  assert.deepEqual(result.items.map(item => item.url), [`${url}?p=3`, `${url}?p=1`]);
  await assert.rejects(resourceParser.parseResource(`${url}?p=2`), /没有第 2 P/);
  await assert.rejects(resourceParser.parseResource(`${url}?p=2x`), /分 P 编号无效/);
  assert.equal(requests, 2);
  assert.equal(spawned, false);
});

test('part subtitle lookups keep page order with at most four concurrent requests', async () => {
  const pages = Array.from({ length: 9 }, (_, index) => ({ cid: 101 + index, page: index + 1, part: `P${index + 1}` }));
  const queriedCids = [];
  let active = 0;
  let maximumActive = 0;
  const resourceParser = parser({
    requestJson: async () => ({ code: 0, data: { title: '多 P 视频', pages } }),
    playerSubtitleLanguages: async (_, cid) => {
      queriedCids.push(cid);
      maximumActive = Math.max(maximumActive, ++active);
      await new Promise(resolve => setTimeout(resolve, cid % 4 === 0 ? 1 : 5));
      active -= 1;
      return [{ value: `lang-${cid}:normal`, label: `Language ${cid}` }];
    }
  });

  const result = await resourceParser.parseResource('https://www.bilibili.com/video/BV123');
  assert.deepEqual(queriedCids, pages.map(page => page.cid));
  assert.equal(maximumActive, 4);
  assert.deepEqual(result.items.map(item => item.subtitleLanguages[0].value), pages.map(page => `lang-${page.cid}:normal`));
});

test('shared subtitle normalization keeps API language labels', () => {
  assert.deepEqual(subtitleLanguages([{ lan: 'zh-CN', lan_doc: '中文' }]), [{ value: 'zh-CN:normal', label: '中文字幕' }]);
});

test('yt-dlp fallback resolves API failures', async () => {
  let seenArgs;
  const resourceParser = parser({
    requestJson: async () => { throw new Error('API unavailable'); },
    spawn: (_, args) => {
      seenArgs = args;
      return fakeProcess(child => {
        child.stdout.emit('data', Buffer.from(JSON.stringify({ id: 'BV123', title: '备用解析', duration: 40 })));
        child.emit('close', 0);
      });
    }
  });
  const result = await resourceParser.parseResource('https://www.bilibili.com/video/BV123');
  assert.equal(result.type, 'video');
  assert.equal(result.title, '备用解析');
  assert.ok(seenArgs.includes('--dump-single-json'));
  assert.ok(seenArgs.includes('--cookies'));
});

test('yt-dlp fallback creates a single part parameter per generated URL', async () => {
  const resourceParser = parser({
    requestJson: async () => ({ code: -1, message: 'API unavailable' }),
    spawn: () => fakeProcess(child => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ title: '备用解析', entries: [{ id: 'P1' }, { id: 'P2' }] })));
      child.emit('close', 0);
    })
  });
  const url = 'https://www.bilibili.com/video/BV123';
  const result = await resourceParser.parseResource(`${url}?P=2#details`);
  assert.deepEqual(result.items.map(item => item.url), [`${url}?p=1#details`, `${url}?p=2#details`]);
});

test('video metadata processing errors propagate instead of starting the fallback', async () => {
  let spawned = false;
  const resourceParser = parser({
    requestJson: async () => ({ code: 0, data: { title: '视频', pages: [null] } }),
    spawn: () => { spawned = true; throw new Error('unexpected fallback'); }
  });

  await assert.rejects(resourceParser.parseResource('https://www.bilibili.com/video/BV123'), TypeError);
  assert.equal(spawned, false);
});

test('series collection API parses titles and durations without spawning yt-dlp', async () => {
  const calls = [];
  const resourceParser = parser({
    requestJson: async url => {
      calls.push(url);
      if (url.includes('/x/series/series')) return { code: 0, data: { meta: { name: '系列标题' } } };
      return url.includes('oid=101')
        ? { code: 0, data: { media_list: [
          { id: 101, bv_id: 'BVfirst', title: '第一集标题', duration: 11, cover: 'first.jpg' },
          { id: 102, bv_id: 'BVsecond', title: '第二集标题', duration: 22, cover: 'second.jpg' }
        ], has_more: false } }
        : { code: 0, data: { media_list: [{ id: 101, bv_id: 'BVfirst', title: '第一集标题', duration: 11, cover: 'first.jpg' }], has_more: true } };
    }
  });
  const result = await resourceParser.parseResource('https://www.bilibili.com/medialist/play/123?business=space_series&business_id=456');
  assert.equal(result.type, 'collection');
  assert.equal(result.title, '系列标题');
  assert.deepEqual(result.items.map(item => item.title), ['第一集标题', '第二集标题']);
  assert.equal(result.items[0].duration, 11);
  assert.equal(result.items[0].url, 'https://www.bilibili.com/video/BVfirst');
  assert.match(calls[1], /type=5&biz_id=456&ps=100/);
  assert.match(calls[2], /oid=101/);
});

for (const [name, pages, message] of [
  ['empty page advertising more entries', [{ media_list: [], has_more: true }], /当前页为空/],
  ['missing cursor', [{ media_list: [{ bv_id: 'BVfirst' }], has_more: true }], /缺少下一页游标/],
  ['cursor cycle', [101, 102, 101].map(id => ({ media_list: [{ id, bv_id: `BV${id}` }], has_more: true })), /游标重复/],
  ['page limit', Array.from({ length: 100 }, (_, index) => ({ media_list: [{ id: index + 1, bv_id: `BV${index + 1}` }], has_more: true })), /页数超出限制/]
]) {
  test(`series collection rejects ${name} without a fallback`, async () => {
    let listCalls = 0;
    let spawned = false;
    const resourceParser = parser({
      requestJson: async url => url.includes('/x/series/series')
        ? { code: 0, data: { meta: { name: '系列标题' } } }
        : { code: 0, data: pages[listCalls++] },
      spawn: () => { spawned = true; throw new Error('unexpected fallback'); }
    });

    await assert.rejects(resourceParser.parseResource('https://www.bilibili.com/list/123?sid=456'), message);
    assert.equal(listCalls, pages.length);
    assert.equal(spawned, false);
  });
}

test('series collection accepts an empty terminal page and a missing optional title', async () => {
  let listCalls = 0;
  const resourceParser = parser({ requestJson: async url => {
    if (url.includes('/x/series/series')) throw new Error('title unavailable');
    listCalls += 1;
    return { code: 0, data: listCalls === 1
      ? { media_list: [{ id: 101, bv_id: 'BVfirst' }], has_more: true }
      : { media_list: [], has_more: false } };
  } });

  const result = await resourceParser.parseResource('https://www.bilibili.com/list/123?sid=456');
  assert.equal(result.title, '合集');
  assert.deepEqual(result.items.map(item => item.id), ['BVfirst']);
  assert.equal(listCalls, 2);
});

test('series collection accepts a terminal page at the pagination limit', async () => {
  let listCalls = 0;
  const resourceParser = parser({ requestJson: async url => {
    if (url.includes('/x/series/series')) return { code: 0, data: { meta: { name: '系列标题' } } };
    listCalls += 1;
    return { code: 0, data: { media_list: [{ id: listCalls, bv_id: `BV${listCalls}` }], has_more: listCalls < 100 } };
  } });

  const result = await resourceParser.parseResource('https://www.bilibili.com/list/123?sid=456');
  assert.equal(result.items.length, 100);
  assert.equal(listCalls, 100);
});

test('series API unavailability still allows the yt-dlp fallback', async () => {
  const resourceParser = parser({
    requestJson: async () => { throw new Error('API unavailable'); },
    spawn: () => fakeProcess(child => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ title: '备用合集', entries: [{ id: 'BVfirst' }] })));
      child.emit('close', 0);
    })
  });

  const result = await resourceParser.parseResource('https://www.bilibili.com/list/123?sid=456');
  assert.equal(result.title, '备用合集');
  assert.deepEqual(result.items.map(item => item.id), ['BVfirst']);
});

test('optional collection enrichment can degrade after a pagination error', async () => {
  const messages = [];
  const resourceParser = parser({
    requestJson: async () => ({ code: 0, data: { media_list: [], has_more: true } }),
    log: (_, message) => messages.push(message),
    spawn: () => fakeProcess(child => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ title: '已解析合集', entries: [{ id: 'BVfirst', title: '保留标题' }] })));
      child.emit('close', 0);
    })
  });

  const result = await resourceParser.parseResource('https://www.bilibili.com/medialist/play/123?business=space_collection&business_id=456');
  assert.equal(result.title, '已解析合集');
  assert.equal(result.items[0].title, '保留标题');
  assert.equal(messages.length, 1);
  assert.match(messages[0], /合集条目补全失败.*当前页为空/);
});
test('other collection API fills titles, duration and cover missing from flat yt-dlp entries', async () => {
  const calls = [];
  const resourceParser = parser({
    requestJson: async url => {
      calls.push(url);
      const second = url.includes('oid=101');
      return { code: 0, data: {
        media_list: [second
          ? { id: 102, bv_id: 'BVsecond', title: '第二集标题', duration: 22, cover: 'second.jpg' }
          : { id: 101, bv_id: 'BVfirst', title: '第一集标题', duration: 11, cover: 'first.jpg' }],
        has_more: !second
      } };
    },
    spawn: () => fakeProcess(child => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ title: '测试合集', entries: [
        { id: 'BVfirst', webpage_url: 'https://www.bilibili.com/video/BVfirst' },
        { id: 'BVsecond', webpage_url: 'https://www.bilibili.com/video/BVsecond' }
      ] })));
      child.emit('close', 0);
    })
  });
  const result = await resourceParser.parseResource('https://www.bilibili.com/medialist/play/123?business=space_collection&business_id=456');
  assert.equal(result.type, 'collection');
  assert.deepEqual(result.items.map(item => item.title), ['第一集标题', '第二集标题']);
  assert.deepEqual(result.items.map(item => item.duration), [11, 22]);
  assert.equal(result.thumbnail, 'first.jpg');
  assert.match(calls[0], /type=8&biz_id=456&ps=100/);
  assert.match(calls[1], /oid=101/);
});

test('yt-dlp output decodes UTF-8 characters split across chunks', async () => {
  const resourceParser = parser({
    spawn: () => fakeProcess(child => {
      const output = Buffer.from(JSON.stringify({ id: 'BV123', title: '中文标题' }));
      const split = output.indexOf(Buffer.from('中')[0]) + 1;
      child.stdout.emit('data', output.subarray(0, split));
      child.stdout.emit('data', output.subarray(split));
      child.emit('close', 0);
    })
  });
  const result = await resourceParser.parseResource('https://www.bilibili.com/list/collection');
  assert.equal(result.title, '中文标题');
});

test('yt-dlp output limit kills the process and rejects once', async () => {
  let child;
  const resourceParser = parser({
    maxOutputBytes: 32,
    spawn: () => {
      child = fakeProcess(process => {
        process.stderr.emit('data', Buffer.alloc(33, 97));
        process.emit('error', new Error('late error'));
        process.emit('close', 1);
      });
      return child;
    }
  });
  await assert.rejects(resourceParser.parseResource('https://www.bilibili.com/list/collection'), /输出过大/);
  assert.equal(child.killCount, 1);
});

test('yt-dlp timeout kills the process and ignores later close', async () => {
  let child;
  const resourceParser = parser({
    timeoutMs: 5,
    spawn: () => {
      child = fakeProcess(() => {});
      return child;
    }
  });
  await assert.rejects(resourceParser.parseResource('https://www.bilibili.com/list/collection'), /解析超时/);
  assert.equal(child.killCount, 1);
});
