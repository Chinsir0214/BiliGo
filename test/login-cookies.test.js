const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveLoginCookies, parseSetCookie } = require('../src/auth/login-cookies');

test('old QR response can provide cookies in its URL', async () => {
  const cookies = await resolveLoginCookies('https://passport.bilibili.com/login?SESSDATA=from-url&bili_jct=csrf', () => { throw new Error('unexpected request'); });
  assert.equal(cookies.length, 2);
  assert.match(cookies[0], /^SESSDATA=from-url;/);
});

test('cross-domain ticket follows a safe redirect and captures Bilibili cookies', async () => {
  const seen = [];
  const cookies = await resolveLoginCookies('https://passport.biligame.com/crossDomain?ticket=secret', async url => {
    seen.push(url.hostname);
    return seen.length === 1
      ? { statusCode: 302, headers: { location: 'https://passport.bilibili.com/finish', 'set-cookie': ['other=value; Path=/'] } }
      : { statusCode: 200, headers: { 'set-cookie': ['SESSDATA=valid; Path=/', 'bili_jct=csrf; Domain=.bilibili.com; Path=/'] } };
  });
  assert.deepEqual(seen, ['passport.biligame.com', 'passport.bilibili.com']);
  assert.deepEqual(cookies, [
    { raw: 'SESSDATA=valid; Path=/', host: 'passport.bilibili.com' },
    'bili_jct=csrf; Domain=.bilibili.com; Path=/'
  ]);
});

test('cross-domain redirect cannot leave Bilibili owned hosts', async () => {
  await assert.rejects(resolveLoginCookies('https://passport.biligame.com/crossDomain?ticket=secret', async () => ({ statusCode: 302, headers: { location: 'https://evil.example/capture' } })), /不安全/);
});

test('an explicit epoch expiry expires the cookie while a session cookie keeps zero', () => {
  assert.equal(parseSetCookie('SESSDATA=value; Expires=Thu, 01 Jan 1970 00:00:00 GMT'), null);
  assert.equal(parseSetCookie('SESSDATA=value').expiry, 0);
});
