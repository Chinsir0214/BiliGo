const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { createHttpClient } = require('../src/infra/http-client');

const url = 'https://example.invalid/video';

function mockTransport(t) {
  const request = new EventEmitter();
  request.destroy = t.mock.fn(error => {
    queueMicrotask(() => request.emit('error', error));
  });
  const httpsGet = t.mock.fn((_url, _options, onResponse) => {
    request.once('response', onResponse);
    return request;
  });
  const client = createHttpClient({ httpsGet });
  function sendHeaders(statusCode, response = new PassThrough()) {
    response.statusCode = statusCode;
    response.headers = {};
    response.complete = false;
    request.emit('response', response);
    return response;
  }
  return { client, httpsGet, request, sendHeaders };
}

test('decodes a UTF-8 JSON character split across response chunks', async t => {
  const { client, sendHeaders } = mockTransport(t);
  const result = client.requestJson(url);
  const response = sendHeaders(200);
  const json = { title: '中文视频' };
  const bytes = Buffer.from(JSON.stringify(json));
  const split = bytes.indexOf('中') + 1;
  response.write(bytes.subarray(0, split));
  response.complete = true;
  response.end(bytes.subarray(split));
  assert.deepEqual(await result, json);
});

test('rejects a non-2xx status at headers and resumes the response without waiting for a body', async t => {
  const { client, sendHeaders } = mockTransport(t);
  const result = client.requestBuffer(url);
  const response = new PassThrough();
  const resume = t.mock.method(response, 'resume');
  sendHeaders(503, response);
  assert.equal(resume.mock.callCount(), 1);
  await assert.rejects(result, { statusCode: 503 });
});

test('rejects when a response closes with an incomplete body', async t => {
  const { client, sendHeaders } = mockTransport(t);
  const result = client.requestBuffer(url);
  const response = sendHeaders(200);
  response.write(Buffer.from('partial'));
  response.destroy();
  await assert.rejects(result, { code: 'ECONNRESET' });
});

test('times out an unfinished request and destroys it with the timeout error', async t => {
  const { client, request } = mockTransport(t);
  const result = client.requestBuffer(url, {}, { timeoutMs: 5 });
  await assert.rejects(result, { code: 'ETIMEDOUT' });
  assert.equal(request.destroy.mock.callCount(), 1);
  assert.equal(request.destroy.mock.calls[0].arguments[0].code, 'ETIMEDOUT');
});

test('settles and cleans up once when response and request both report failure', async t => {
  const { client, request, sendHeaders } = mockTransport(t);
  const controller = new AbortController();
  const removeListener = t.mock.method(controller.signal, 'removeEventListener');
  const result = client.requestBuffer(url, {}, { signal: controller.signal });
  const response = sendHeaders(200);
  const firstError = new Error('response failed');
  response.emit('error', firstError);
  response.emit('close');
  request.emit('error', new Error('request failed'));
  await assert.rejects(result, error => error === firstError);
  assert.equal(removeListener.mock.callCount(), 1);
  assert.equal(removeListener.mock.calls[0].arguments[0], 'abort');
  controller.abort();
  assert.equal(request.destroy.mock.callCount(), 0);
});

test('aborting in flight forwards the signal and destroys the request with its reason', async t => {
  const { client, httpsGet, request } = mockTransport(t);
  const controller = new AbortController();
  const reason = new Error('cancelled');
  const result = client.requestBuffer(url, {}, { signal: controller.signal });
  assert.equal(httpsGet.mock.calls[0].arguments[1].signal, controller.signal);
  controller.abort(reason);
  await assert.rejects(result, error => error === reason);
  assert.equal(request.destroy.mock.callCount(), 1);
  assert.equal(request.destroy.mock.calls[0].arguments[0], reason);
});

test('an already aborted signal rejects before starting a request', async t => {
  const { client, httpsGet } = mockTransport(t);
  const reason = new Error('already cancelled');
  const result = client.requestBuffer(url, {}, { signal: AbortSignal.abort(reason) });
  await assert.rejects(result, error => error === reason);
  assert.equal(httpsGet.mock.callCount(), 0);
});
