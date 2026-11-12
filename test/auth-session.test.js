const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAuthSession } = require('../src/auth/session');

function harness(t, requestJson, resolveLoginCookies = async () => []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'biligo-auth-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cookieFile = path.join(directory, 'cookies.txt');
  const profileFile = path.join(directory, 'profile.json');
  const events = [];
  const ticks = new Set();
  const auth = createAuthSession({
    cookieFile,
    profileFile,
    requestJson,
    resolveLoginCookies,
    send: (channel, payload) => events.push({ channel, payload }),
    log: () => {},
    QRCode: { create: () => ({ modules: { size: 2, data: Uint8Array.from([1, 0, 0, 1]) } }) },
    setIntervalFn: callback => { ticks.add(callback); return callback; },
    clearIntervalFn: callback => ticks.delete(callback)
  });
  return { auth, cookieFile, profileFile, events, ticks };
}

function generated(key = 'one') {
  return { code: 0, data: { url: `https://passport.bilibili.com/qr/${key}`, qrcode_key: key } };
}

function successfulPoll(cookie = 'session') {
  return { json: { data: { code: 0, message: 'success' } }, headers: { 'set-cookie': [`SESSDATA=${cookie}; Domain=.bilibili.com; Path=/`] } };
}

test('QR login returns existing shape, polls once at a time, stores cookies and profile', async t => {
  const pendingPoll = Promise.withResolvers();
  let pollCalls = 0;
  let navFails = false;
  const { auth, cookieFile, profileFile, events, ticks } = harness(t, url => {
    if (url.includes('/generate')) return generated();
    if (url.includes('/poll')) { pollCalls += 1; return pendingPoll.promise; }
    if (url.includes('/nav')) {
      if (navFails) throw new Error('offline');
      return { code: 0, data: { uname: '测试用户', face: 'avatar.jpg' } };
    }
    throw new Error(`unexpected URL: ${url}`);
  });
  const qr = await auth.createLogin();
  assert.deepEqual(qr, { url: 'https://passport.bilibili.com/qr/one', key: 'one', qr: { size: 2, data: [1, 0, 0, 1] } });
  const tick = [...ticks][0];
  const pending = tick();
  await tick();
  assert.equal(pollCalls, 1);
  pendingPoll.resolve(successfulPoll());
  await pending;
  assert.equal(ticks.size, 0);
  assert.equal(auth.hasCookieFile(), true);
  assert.equal(auth.cookieHeader(), 'SESSDATA=session');
  assert.deepEqual(auth.pushCookieArgs(['--flag']), ['--flag', '--cookies', cookieFile]);
  assert.equal(fs.existsSync(profileFile), true);
  assert.deepEqual(events.map(event => event.channel), ['login:success']);
  assert.deepEqual(events[0].payload.profile, { name: '测试用户', avatar: 'avatar.jpg' });
  navFails = true;
  assert.deepEqual(await auth.getProfile(), { name: '测试用户', avatar: 'avatar.jpg' });
});

test('an unauthenticated profile response clears the cache before offline fallback', async t => {
  let response;
  const { auth, cookieFile, profileFile } = harness(t, async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  fs.writeFileSync(cookieFile, '# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tFALSE\t0\tSESSDATA\told');
  for (const invalidNav of [{ code: -101, message: '账号未登录' }, { code: 0, data: { isLogin: false } }]) {
    response = { code: 0, data: { uname: '旧用户', face: 'old.jpg' } };
    assert.deepEqual(await auth.getProfile(), { name: '旧用户', avatar: 'old.jpg' });
    assert.equal(fs.existsSync(profileFile), true);

    response = invalidNav;
    assert.equal(await auth.getProfile(), null, JSON.stringify(invalidNav));
    assert.equal(fs.existsSync(profileFile), false, JSON.stringify(invalidNav));

    response = new Error('offline');
    assert.equal(await auth.getProfile(), null, JSON.stringify(invalidNav));
  }
});

test('late response from old poll cannot affect a newer QR session', async t => {
  const oldPoll = Promise.withResolvers();
  let generationCount = 0;
  const { auth, events, ticks } = harness(t, url => {
    if (url.includes('/generate')) return generated(++generationCount === 1 ? 'old' : 'new');
    if (url.includes('qrcode_key=old')) return oldPoll.promise;
    if (url.includes('qrcode_key=new')) return successfulPoll('new-session');
    if (url.includes('/nav')) return { code: 0, data: { uname: '新用户' } };
    throw new Error(`unexpected URL: ${url}`);
  });
  await auth.createLogin();
  const oldTick = [...ticks][0];
  const pending = oldTick();
  await auth.createLogin();
  oldPoll.resolve(successfulPoll('old-session'));
  await pending;
  assert.equal(auth.cookieHeader(), '');
  assert.equal(events.length, 0);
  const newTick = [...ticks][0];
  await newTick();
  assert.equal(auth.cookieHeader(), 'SESSDATA=new-session');
  assert.deepEqual(events.map(event => event.channel), ['login:success']);
});

test('scan waits for phone confirmation; expiry stops polling', async t => {
  let pollCalls = 0;
  let pollCode = 86090;
  const { auth, events, ticks } = harness(t, url => {
    if (url.includes('/generate')) return generated();
    if (url.includes('/poll')) { pollCalls += 1; return { json: { data: { code: pollCode } }, headers: {} }; }
    throw new Error(`unexpected URL: ${url}`);
  });
  await auth.createLogin();
  const expiredTick = [...ticks][0];
  await expiredTick();
  await expiredTick();
  assert.equal(pollCalls, 2);
  assert.deepEqual(events.map(event => event.channel), ['login:scanned']);
  assert.equal(ticks.size, 1);
  pollCode = 86038;
  await expiredTick();
  assert.equal(pollCalls, 3);
  assert.deepEqual(events.map(event => event.channel), ['login:scanned', 'login:expired']);
  await auth.createLogin();
  const cancelledTick = [...ticks][0];
  assert.equal(auth.cancelLogin(), true);
  await cancelledTick();
  assert.equal(pollCalls, 3);
  assert.equal(ticks.size, 0);
});

test('successful poll resolves cross-domain ticket cookies before checking profile', async t => {
  const ticketUrl = 'https://passport.biligame.com/x/passport-login/web/crossDomain?ticket=redacted';
  let resolvedUrl;
  const { auth, events, ticks } = harness(t, url => {
    if (url.includes('/generate')) return generated();
    if (url.includes('/poll')) return { json: { data: { code: 0, url: ticketUrl } }, headers: {} };
    if (url.includes('/nav')) return { code: 0, data: { uname: '测试用户' } };
    throw new Error(`unexpected URL: ${url}`);
  }, async url => {
    resolvedUrl = url;
    return ['SESSDATA=ticket-session; Domain=.bilibili.com; Path=/'];
  });
  await auth.createLogin();
  await [...ticks][0]();
  assert.equal(resolvedUrl, ticketUrl);
  assert.equal(auth.cookieHeader(), 'SESSDATA=ticket-session');
  assert.deepEqual(events.map(event => event.channel), ['login:success']);
});

test('logout, cancel and a newer QR session invalidate a pending cross-domain ticket', async t => {
  for (const action of ['logout', 'cancelLogin', 'createLogin']) {
    const ticket = Promise.withResolvers();
    const exchanging = Promise.withResolvers();
    let generationCount = 0;
    const { auth, cookieFile, profileFile, events, ticks } = harness(t, url => {
      if (url.includes('/generate')) return generated(++generationCount === 1 ? 'old' : 'new');
      if (url.includes('qrcode_key=old')) return { json: { data: { code: 0, url: 'https://passport.biligame.com/crossDomain?ticket=old' } }, headers: {} };
      if (url.includes('qrcode_key=new')) return successfulPoll('new-session');
      if (url.includes('/nav')) return { code: 0, data: { uname: '新用户' } };
      throw new Error(`unexpected URL: ${url}`);
    }, () => { exchanging.resolve(); return ticket.promise; });
    await auth.createLogin();
    const pending = [...ticks][0]();
    assert.equal(await Promise.race([exchanging.promise.then(() => true), pending.then(() => false)]), true, action);
    if (action === 'createLogin') await auth.createLogin();
    else assert.equal(auth[action](), true, action);
    ticket.resolve(['SESSDATA=old-session; Domain=.bilibili.com; Path=/']);
    await pending;
    assert.equal(auth.cookieHeader(), '', action);
    assert.equal(fs.existsSync(cookieFile), false, action);
    assert.equal(fs.existsSync(profileFile), false, action);
    assert.deepEqual(events, [], action);

    if (action === 'createLogin') {
      await [...ticks][0]();
      assert.equal(auth.cookieHeader(), 'SESSDATA=new-session');
      assert.deepEqual(events.map(event => event.channel), ['login:success']);
      assert.equal(JSON.parse(fs.readFileSync(profileFile, 'utf8')).profile.name, '新用户');
      assert.equal(fs.existsSync(cookieFile), true);
    }
  }
});

test('successful poll without session cookie reports failure instead of login success', async t => {
  const { auth, events, ticks } = harness(t, url => {
    if (url.includes('/generate')) return generated();
    if (url.includes('/poll')) return { json: { data: { code: 0, url: 'https://passport.biligame.com/crossDomain?ticket=redacted' } }, headers: {} };
    throw new Error(`unexpected URL: ${url}`);
  });
  await auth.createLogin();
  await [...ticks][0]();
  assert.equal(auth.cookieHeader(), '');
  assert.deepEqual(events.map(event => event.channel), ['login:error']);
});

test('logout during profile request prevents stale success and cache resurrection', async t => {
  const nav = Promise.withResolvers();
  const { auth, cookieFile, profileFile, events, ticks } = harness(t, url => {
    if (url.includes('/generate')) return generated();
    if (url.includes('/poll')) return successfulPoll();
    if (url.includes('/nav')) return nav.promise;
    throw new Error(`unexpected URL: ${url}`);
  });
  await auth.createLogin();
  const pending = [...ticks][0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fs.existsSync(cookieFile), true);
  assert.equal(auth.logout(), true);
  nav.resolve({ code: 0, data: { uname: '旧用户' } });
  await pending;
  assert.equal(fs.existsSync(cookieFile), false);
  assert.equal(fs.existsSync(profileFile), false);
  assert.equal(await auth.getProfile(), null);
  assert.deepEqual(events.map(event => event.channel), []);
});

test('cancelled QR generation cannot start a stale poller', async t => {
  const generation = Promise.withResolvers();
  const { auth, ticks } = harness(t, url => {
    if (url.includes('/generate')) return generation.promise;
    throw new Error(`unexpected URL: ${url}`);
  });
  const pending = auth.createLogin();
  auth.shutdown();
  generation.resolve(generated());
  await assert.rejects(pending, /登录已取消/);
  assert.equal(ticks.size, 0);
});
