const { test } = require('node:test');
const assert = require('node:assert/strict');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class Element {
  constructor(tag = 'div') {
    this.tag = tag;
    this.dataset = {};
    this.children = [];
    this.listeners = {};
    this.attributes = new Map();
    this.parts = new Map();
    this.disabled = false;
    const classes = new Set();
    this.classList = {
      add: value => classes.add(value),
      contains: value => classes.has(value),
      toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value)
    };
  }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  prepend(node) { this.insertBefore(node, this.children[0]); }
  insertBefore(node, next) {
    node.remove();
    const index = next ? this.children.indexOf(next) : this.children.length;
    this.children.splice(index, 0, node);
    node.parent = this;
  }
  replaceChildren(...nodes) {
    for (const node of [...this.children]) node.remove();
    this.append(...nodes);
  }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  all() { return this.children.flatMap(node => [node, ...node.all()]); }
  contains(node) { return this === node || this.all().includes(node); }
  closest(tag) { return this.tag === tag ? this : this.parent?.closest(tag); }
  part(selector) {
    const node = new Element();
    this.parts.set(selector, node);
    return node;
  }
  querySelectorAll(selector) {
    const matches = {
      '[data-history-id]:checked': n => n.checked && 'historyId' in n.dataset,
      '[data-history-id]': n => 'historyId' in n.dataset,
      '[data-retry-task]': n => 'retryTask' in n.dataset,
      '[data-label]': n => 'label' in n.dataset,
      'button': n => n.tag === 'button',
      'input:checked:not(:disabled)': n => n.tag === 'input' && n.checked && !n.disabled,
      'img[src]': n => n.tag === 'img' && n.src !== undefined,
      'img[data-src]:not([src]):not(.image-unavailable)': n =>
        n.tag === 'img' && n.dataset.src && n.src === undefined && !n.classList.contains('image-unavailable')
    };
    assert.ok(matches[selector], 'Unexpected selector ' + selector);
    return this.all().filter(matches[selector]);
  }
  querySelector(selector) { return this.parts.get(selector) || this.querySelectorAll(selector)[0] || null; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  fire(name, target = this) {
    return this.listeners[name]({ target, currentTarget: this, preventDefault() {} });
  }
  setAttribute(key, value) { this.attributes.set(key, value); }
  removeAttribute(key) { this.attributes.delete(key); delete this[key]; }
}

function fixture(api = {}) {
  const nodes = new Map();
  const events = new Map();
  const messages = [];
  const $ = key => {
    if (!nodes.has(key)) nodes.set(key, new Element());
    return nodes.get(key);
  };
  for (const list of ['#taskList', '#historyList']) $(list).part('.empty-state');
  let dialog;
  return {
    $, api, events, messages, state: { activeView: 'download' },
    document: {
      readyState: 'complete', createElement: tag => new Element(tag),
      createDocumentFragment: () => new Element('fragment'), querySelectorAll: () => []
    },
    window: new EventTarget(), on: (name, cb) => events.set(name, cb),
    modal: { open: node => { dialog = node; return true; }, close: () => { dialog = null; }, isOpen: node => node === dialog },
    toast: message => messages.push(message), options: { isPlayableMediaPath: () => false }
  };
}

function taskFixture(api) {
  const ctx = fixture(api);
  ctx.document.createElement = () => {
    const card = new Element();
    for (const selector of ['.progress-track', '.task-percent', '.task-info', '.task-status',
      '.task-title', '.task-meta', '[data-cancel-task]', '[data-open-video]', '[data-open-folder]']) card.part(selector);
    return card;
  };
  return ctx;
}

test('queue readiness resolves immediately after load and waits while the document is interactive', async () => {
  const { waitForWindowLoad } = await import('../src/renderer/features/tasks.mjs');
  await waitForWindowLoad({ readyState: 'complete' }, {});
  const window = new EventTarget();
  let ready = false;
  const waiting = waitForWindowLoad({ readyState: 'interactive' }, window).then(() => { ready = true; });
  await Promise.resolve();
  assert.equal(ready, false);
  window.dispatchEvent(new Event('load'));
  await waiting;
  assert.equal(ready, true);
});

test('queue restoration keeps the downloading task ahead of the queued task', async () => {
  const { createTasks } = await import('../src/renderer/features/tasks.mjs');
  const ctx = taskFixture({ listQueue: () => [
    { id: 'active', status: 'downloading' },
    { id: 'waiting', status: 'queued' }
  ] });
  const tasks = createTasks(ctx);
  const taskIds = () => ctx.$('#taskList').children.map(node => node.dataset.task);

  await tasks.restoreQueue();
  assert.deepEqual(taskIds(), ['active', 'waiting']);

  await tasks.withTaskUpdates(updates => tasks.acceptTask({ id: 'new', status: 'queued' }, updates));
  assert.deepEqual(taskIds(), ['new', 'active', 'waiting']);
});

test('queue restoration replays latest progress by ID and terminal events win over stale snapshots', async () => {
  const { createTasks } = await import('../src/renderer/features/tasks.mjs');
  const snapshot = deferred();
  const ctx = taskFixture({ listQueue: () => snapshot.promise });
  const tasks = createTasks(ctx);
  tasks.bind();
  const restoring = tasks.restoreQueue();
  await Promise.resolve();
  const progress = ctx.events.get('download:progress');
  progress({ id: 'unknown', percent: Infinity });
  progress({ id: 'running', percent: 17 });
  progress({ id: 'done', percent: 89 });
  ctx.events.get('download:done')({ id: 'done', code: 0 });
  progress({ id: 'done', percent: 100 });
  progress({ id: 'running', percent: 73 });
  snapshot.resolve(['unknown', 'done', 'running'].map(id => ({ id })));
  await restoring;
  const cards = Object.fromEntries(ctx.$('#taskList').children.map(node => [node.dataset.task, node]));
  assert.deepEqual(Object.keys(cards).sort(), ['running', 'unknown']);
  assert.equal(cards.unknown.querySelector('.task-percent').textContent, '—');
  assert.equal(cards.running.querySelector('.progress-track').value, 73);
  assert.deepEqual(ctx.messages, ['下载完成，已移入任务记录']);
});

test('history file counts are coerced and untrusted titles remain text', async () => {
  const { historyCard } = await import('../src/renderer/features/history.mjs');
  const { document } = fixture();
  const payload = '<img src=x onerror=alert(1)>';
  for (const [fileCount, expected] of [[payload, 0], ['13', 13]]) {
    const card = historyCard(document, { id: 'a', title: payload, fileCount }, () => false);
    const [title, metadata] = card.children[1].children;
    assert.equal(title.textContent, payload);
    assert.equal(title.children.length, 0);
    assert.ok(metadata.textContent.includes(expected + ' 个文件'));
    assert.ok(!metadata.textContent.includes(payload));
  }
});

test('retry clicks restore the action on success and rejection', async () => {
  const { createHistory } = await import('../src/renderer/features/history.mjs');
  const record = { id: 'old', status: 'failed', retryTask: {} };
  let attempt;
  const calls = [];
  const accepted = [];
  const ctx = fixture({ retryDownload: id => { calls.push(id); return attempt.promise; } });
  ctx.tasks = { withTaskUpdates: run => run(new Map()), acceptTask: task => { accepted.push(task.id); return true; } };
  const history = createHistory(ctx);
  history.bind();
  history.upsertRecord(record);
  const list = ctx.$('#historyList');
  const button = list.querySelector('[data-retry-task]');
  for (const success of [true, false]) {
    attempt = deferred();
    const click = list.fire('click', button);
    assert.equal(button.disabled, true);
    await list.fire('click', button);
    if (success) attempt.resolve({ id: 'new' });
    else attempt.reject(new Error('offline'));
    await click;
    assert.equal(button.disabled, false);
    assert.equal(button.querySelector('[data-label]').textContent, '重试');
  }
  assert.deepEqual(calls, ['old', 'old']);
  assert.deepEqual(accepted, ['new']);
  assert.deepEqual(ctx.messages, ['已重新加入下载队列', '重试失败：offline']);
});

test('delete and confirmed clear serialize mutations and cancellation preserves records', async () => {
  const { createHistory } = await import('../src/renderer/features/history.mjs');
  const remove = deferred(), clear = deferred();
  const calls = [];
  let records = [{ id: 'one' }, { id: 'two' }];
  const ctx = fixture({
    history: async () => records,
    removeHistory: ids => { calls.push(ids); return remove.promise; },
    clearHistory: () => { calls.push('clear'); return clear.promise; }
  });
  const { $, modal } = ctx;
  const dialog = $('#confirmClearHistoryModal');
  for (const id of ['#confirmClearHistory', '#cancelClearHistory', '#closeClearHistory']) {
    $(id).tag = 'button';
    dialog.append($(id));
  }
  const history = createHistory(ctx);
  history.bind();
  await history.loadHistory();
  $('#historyList').querySelector('[data-history-id]').checked = true;
  const deleting = $('#deleteHistoryBtn').fire('click');
  await $('#deleteHistoryBtn').fire('click');
  await $('#clearBtn').fire('click');
  assert.equal(modal.isOpen(dialog), false);
  assert.deepEqual(calls, [['one']]);
  records = records.slice(1);
  remove.resolve();
  await deleting;
  assert.equal($('#deleteHistoryBtn').disabled, false);
  $('#clearBtn').fire('click');
  assert.equal(modal.isOpen(dialog), true);
  $('#cancelClearHistory').fire('click');
  assert.equal(modal.isOpen(dialog), false);
  assert.deepEqual(calls, [['one']]);
  assert.deepEqual($('#historyList').children.map(card => card.dataset.recordId), ['two']);
  $('#clearBtn').fire('click');
  const clearing = $('#confirmClearHistory').fire('click');
  await $('#confirmClearHistory').fire('click');
  $('#cancelClearHistory').fire('click');
  assert.equal(modal.isOpen(dialog), true);
  assert.equal($('#confirmClearHistory').disabled, true);
  assert.deepEqual(calls, [['one'], 'clear']);
  records = [];
  clear.resolve();
  await clearing;
  assert.equal(modal.isOpen(dialog), false);
  assert.equal($('#confirmClearHistory').disabled, false);
  assert.equal($('#historyList').querySelectorAll('[data-history-id]').length, 0);
});

test('a late loginStatus cannot overwrite a successful login', async () => {
  const { createAuth } = await import('../src/renderer/features/auth.mjs');
  const status = deferred();
  const ctx = fixture({ loginStatus: () => status.promise });
  for (const id of ['#loginBtn', '#loginSmall']) ctx.$(id).part('[data-label]');
  const auth = createAuth(ctx);
  auth.bind();
  const loading = auth.init();
  ctx.events.get('login:success')({ profile: { name: '已认证用户' } });
  status.resolve({ loggedIn: false });
  await loading;
  assert.equal(ctx.$('#accountText').textContent, '已认证用户');
  assert.equal(ctx.$('#loginBtn').querySelector('[data-label]').textContent, '退出账号');
});

test('saveSetting serializes writes and applies normalized values from the last response', async () => {
  const { createSettings } = await import('../src/renderer/features/settings.mjs');
  const writes = [];
  const first = deferred(), second = deferred();
  const ctx = fixture({ setSettings: patch => {
    writes.push(patch);
    return writes.length === 1 ? first.promise : second.promise;
  } });
  ctx.download = { syncDerivedUi() {} };
  const settings = createSettings(ctx);
  const one = settings.saveSetting({ retries: '21' });
  const two = settings.saveSetting({ maxConcurrentTasks: '100' });
  await Promise.resolve();
  assert.deepEqual(writes, [{ retries: '21' }]);
  first.resolve({ retries: 10, contentModes: [] });
  await one;
  await Promise.resolve();
  assert.deepEqual(writes, [{ retries: '21' }, { maxConcurrentTasks: '100' }]);
  second.resolve({ retries: 10, maxConcurrentTasks: 4, contentModes: [] });
  await two;
  assert.equal(ctx.$('#performanceRetries').value, '10');
  assert.equal(ctx.$('#maxConcurrentTasks').value, '4');
});

test('thumbnails acquire src only after thumbnails are enabled', async () => {
  const { createDownload } = await import('../src/renderer/features/download.mjs');
  const { createSettings } = await import('../src/renderer/features/settings.mjs');
  const thumbnail = 'https://example.com/cover.jpg';
  const itemThumbnail = 'https://example.com/item.jpg';
  const ctx = fixture({
    parseResource: async () => ({ title: 'Video', thumbnail, items: [{ title: 'Part', thumbnail: itemThumbnail }] }),
    setSettings: async patch => ({ contentModes: [], ...patch })
  });
  const { $ } = ctx;
  ctx.options.getMediaCapabilities = () => ({});
  ctx.options.isAllowedBilibiliInputUrl = () => true;
  ctx.selects = { subtitlePicker: { refresh() {}, setVisible() {} } };
  const cover = $('#selectionCover');
  cover.tag = 'img';
  $('#selectionPanel').append(cover, $('#selectionList'));
  for (const id of ['#embedSubs', '#audioFormat', '#containerFormat', '#embedThumbnail', '#embedMetadata', '#embedChapters']) {
    new Element('label').append($(id));
  }
  for (const id of ['#downloadBtn', '#parseBtn']) $(id).part('[data-label]');
  $('#showThumbnails').type = 'checkbox';
  $('#showThumbnails').checked = false;
  $('#urlInput').value = 'https://www.bilibili.com/video/BV1';
  ctx.download = createDownload(ctx);
  ctx.settings = createSettings(ctx);
  ctx.download.bind();
  await $('#parseForm').fire('submit');
  const images = $('#selectionPanel').all().filter(node => node.tag === 'img');
  assert.deepEqual(images.map(node => node.dataset.src), [thumbnail, itemThumbnail]);
  assert.deepEqual(images.map(node => node.src), [undefined, undefined]);
  await ctx.settings.saveSetting({ showThumbnails: true });
  assert.deepEqual(images.map(node => node.src), [thumbnail, itemThumbnail]);
  assert.equal(cover.hidden, false);
  await ctx.settings.saveSetting({ showThumbnails: false });
  assert.deepEqual(images.map(node => node.src), [undefined, undefined]);
});
