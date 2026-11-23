const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

const source = readFileSync(join(__dirname, '../src/renderer.js'), 'utf8');

// Exercise the actual IPC consumers without requiring a browser process.
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `renderer section missing: ${start}`);
  return source.slice(from, to);
}

function taskUi(api) {
  const events = new Map();
  const nodes = new Map();
  const messages = [];
  const selections = [];
  const frames = [];
  function element() {
    const descendants = new Map();
    let html = '';
    return {
      dataset: {}, children: [], handlers: {}, className: '', style: {},
      classList: { add() {}, remove() {} },
      value: '', lastChild: {}, prepended: 0,
      get innerHTML() { return html; },
      set innerHTML(value) { html = value; this.children.length = 0; descendants.clear(); },
      prepend(child) { this.prepended += 1; this.children.unshift(child); child.parent = this; },
      appendChild(child) { this.children.push(child); child.parent = this; },
      replaceChildren(...children) {
        for (const child of [...this.children]) child.remove();
        children.forEach(child => this.appendChild(child));
      },
      remove() {
        if (!this.parent) return;
        this.parent.children.splice(this.parent.children.indexOf(this), 1);
        this.parent = undefined;
      },
      querySelector(selector) {
        if (descendants.has(selector)) return descendants.get(selector);
        const child = this.children.find(node => node.className === selector.slice(1));
        if (child) return child;
        const field = /^\[data-([a-z]+)-([a-z]+)\]$/.exec(selector);
        const data = field && new RegExp(`data-${field[1]}-${field[2]}="([^"]*)"`).exec(html);
        if (field && !data) return null;
        const css = selector.slice(1);
        if (!field && !html.includes(`class="${css}"`)) return null;
        const node = element();
        if (field) node.dataset[field[1] + field[2][0].toUpperCase() + field[2].slice(1)] = data[1];
        else node.textContent = html.split(`class="${css}"`)[1].split('>')[1].split('<')[0];
        descendants.set(selector, node);
        return node;
      },
      querySelectorAll(selector) { return this.children.map(child => child.querySelector(selector)).filter(Boolean); },
      addEventListener(type, handler) { this.handlers[type] = handler; },
      setAttribute() {}, removeAttribute() {}, insertAdjacentHTML() {}
    };
  }
  const $ = selector => {
    if (!nodes.has(selector)) nodes.set(selector, element());
    return nodes.get(selector);
  };
  const history = $('#historyList');
  const taskList = $('#taskList');
  for (const id of ['#taskList', '#historyList']) {
    const emptyState = $(id + ' .empty-state');
    emptyState.className = 'empty-state';
    $(id).appendChild(emptyState);
  }
  const context = {
    $, window: { bili: { ...api, on: (name, callback) => events.set(name, callback) } },
    requestAnimationFrame: callback => frames.push(callback),
    loadDownloadModules: () => Promise.all([import('../src/download/form.js'), import('../src/download/submit.js')]),
    document: {
      createElement: element,
      querySelectorAll: selector => selector === '[data-history-id]:checked'
        ? history.querySelectorAll('[data-history-id]').filter(input => input.checked)
        : selections.filter(input => !input.disabled && (!selector.includes(':checked') || input.checked))
    },
    toast: message => messages.push(message),
    text: String, modeLabel: String,
    parsedResource: undefined, parsingResource: false, downloadSubmitting: false,
    parsedSourceUrl: 'https://www.bilibili.com/video/BV123',
    submittedSelectionIndices: new Set(),
    selectedContentModes: () => ['video'],
    subtitlePickerControl: { values: () => [] },
    isUnavailableItem: () => false, syncSelectionSubmitUi() {}
  };
  runInNewContext([
    section('const downloadSettingFields = ', 'let parsedResource;'),
    section('function taskActions(task)', 'let activeModal;'),
    section("$('#downloadBtn').addEventListener", "$('#selectionList').addEventListener"),
    section("$('#clearBtn').addEventListener", "$('#loginBtn').addEventListener"),
    section('function showDownloadDirectory', 'function applySettings('),
    section('async function restoreQueue(', 'refreshAccountStatus().catch')
  ].join('\n'), context);
  return {
    context, $, history, taskList, messages, frames,
    emit(name, data) { events.get('download:' + name)(data); },
    async select(...titles) {
      context.parsedResource = { type: 'video', items: titles.map(title => ({ title })) };
      return titles.map((_, index) => {
        const row = element();
        row.innerHTML = '<span class="selection-item-title"></span>';
        const input = Object.assign(element(), { dataset: { index: String(index) }, checked: true, closest: () => row });
        selections.push(input);
        return input;
      });
    }
  };
}

const task = (id, status) => ({ id, title: id, url: 'https://www.bilibili.com/video/BV123', mode: 'video', status });
const record = (id, status = 'failed') => ({ ...task(id, status), retryTask: {}, completedAt: '2026-01-01' });
const historyIds = ui => ui.history.querySelectorAll('[data-history-id]').map(input => input.dataset.historyId);

function updateSchedule(supportsPaint) {
  const checks = [];
  let click, paint, idle, fallback;
  class Observer {
    static supportedEntryTypes = ['paint'];
    constructor(callback) { this.callback = callback; }
    observe({ type, buffered }) {
      assert.equal(type, 'paint');
      assert.equal(buffered, true);
      paint = name => this.callback({ getEntriesByName: wanted => name === wanted ? [{}] : [] });
    }
    disconnect() { paint = undefined; }
  }
  const button = { dataset: {}, addEventListener(event, callback) { click = () => callback({ currentTarget: button }); } };
  runInNewContext(section('let updateCheckRequested', 'Object.entries(settingsFields)'), {
    $: () => button, PerformanceObserver: supportsPaint ? Observer : undefined,
    requestIdleCallback: callback => { idle = callback; },
    setTimeout(callback, delay) { assert.ok(delay >= 5000); fallback = callback; return 1; },
    clearTimeout() { fallback = undefined; },
    checkUpdates: manual => checks.push(manual)
  });
  return { checks, get paint() { return paint; }, get idle() { return idle; }, get fallback() { return fallback; }, click };
}

test('the automatic update check waits for contentful paint and subsequent idle time', () => {
  const schedule = updateSchedule(true);
  assert.deepEqual(schedule.checks, []);
  schedule.paint('first-paint');
  assert.equal(schedule.idle, undefined);
  schedule.paint('first-contentful-paint');
  assert.equal(schedule.fallback, undefined);
  assert.deepEqual(schedule.checks, []);
  schedule.idle();
  assert.deepEqual(schedule.checks, [false]);
});

test('no paint or unsupported paint timing still permits updates, and a manual check takes precedence', () => {
  for (const supportsPaint of [true, false]) {
    const schedule = updateSchedule(supportsPaint);
    schedule.fallback();
    assert.deepEqual(schedule.checks, [false]);
    assert.equal(schedule.paint, undefined);
  }
  const manual = updateSchedule(true);
  manual.click();
  manual.paint('first-contentful-paint');
  manual.idle();
  assert.deepEqual(manual.checks, [true]);
});

test('history read and mutation failures preserve displayed records and report failure', async () => {
  let readable = true;
  let removed;
  const ui = taskUi({
    async history() {
      if (!readable) throw new Error('EACCES');
      return [record('selected')];
    },
    clearHistory: async () => { throw new Error('EIO'); },
    removeHistory: async ids => { removed = Array.from(ids); }
  });
  await ui.context.loadHistory();
  ui.history.querySelectorAll('[data-history-id]')[0].checked = true;
  readable = false;
  assert.equal(await ui.context.loadHistory(), false);
  assert.deepEqual(historyIds(ui), ['selected']);
  await ui.$('#clearBtn').handlers.click();
  assert.deepEqual(historyIds(ui), ['selected']);
  await ui.$('#deleteHistoryBtn').handlers.click();
  assert.deepEqual(removed, ['selected']);
  assert.deepEqual(historyIds(ui), ['selected']);
  assert.deepEqual(ui.messages, ['读取任务记录失败：EACCES', '清空任务记录失败：EIO', '读取任务记录失败：EACCES']);
});

test('folder IPC failures are consumed without changing the displayed directory', async () => {
  const ui = taskUi({
    openFolder: async () => { throw new Error('settings unreadable'); },
    chooseDownloadDir: async () => { throw new Error('EACCES'); }
  });
  ui.context.showDownloadDirectory('existing directory');
  await ui.$('#openFolderBtn').handlers.click();
  await ui.$('#chooseFolderBtn').handlers.click();
  assert.equal(ui.$('#downloadDirText').textContent, 'existing directory');
  assert.equal(ui.$('#destination').textContent, '保存至 existing directory');
  assert.deepEqual(ui.messages, ['打开文件夹失败：settings unreadable', '选择下载目录失败：EACCES']);
});

test('a rejected cancel request restores the button for retry', async () => {
  const ui = taskUi({
    listQueue: async () => [task('task-1', 'queued')],
    cancelDownload: async () => { throw new Error('queue unavailable'); }
  });
  await ui.context.restoreQueue();
  const button = ui.taskList.children[0].querySelector('[data-cancel-task]');
  await button.handlers.click({ currentTarget: button });
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, '取消任务');
  assert.deepEqual(ui.messages, ['取消任务失败：queue unavailable']);
});

test('a terminal event before submission acknowledgement never creates a card and the remaining selection can be retried', async () => {
  const calls = [];
  const ui = taskUi({
    async startDownload(request) {
      assert.equal(request.retries, '7');
      assert.equal(request.fragmentThreads, 15);
      const id = request.title;
      calls.push(id);
      if (id === 'first') {
        ui.emit('done', { id, code: 1, record: record(id) });
        ui.emit('progress', { id, percent: 80 });
      } else if (calls.length === 2) throw new Error('queue unavailable');
      return task(id);
    }
  });
  ui.$('#performanceRetries').value = '7';
  ui.$('#fragmentThreads').value = '15';
  const [first, second] = await ui.select('first', 'second');
  const submit = ui.$('#downloadBtn').handlers.click;
  await submit();
  assert.equal(ui.taskList.prepended, 0);
  assert.deepEqual(historyIds(ui), ['first']);
  assert.equal(first.checked, false);
  assert.equal(first.disabled, true);
  assert.equal(second.checked, true);
  assert.equal(second.disabled, false);
  assert.match(ui.$('#selectionNotice').textContent, /已入队 1 项；剩余 1 项未提交/);
  await submit();
  assert.deepEqual(calls, ['first', 'second', 'second']);
  const [card] = ui.taskList.children;
  assert.equal(card.dataset.task, 'second');
  assert.equal(card.querySelector('.task-status').textContent, '队列中');
  ui.emit('progress', { id: 'second', percent: 25, speed: '1 MB/s', eta: '00:01' });
  ui.frames.shift()();
  assert.equal(card.querySelector('.task-status').textContent, '下载中');
  assert.equal(card.querySelector('.task-percent').textContent, '25.0%');
  const done = { id: 'second', code: 0, record: record('second', 'completed') };
  ui.emit('done', done);
  ui.emit('done', done);
  ui.emit('progress', { id: 'second', percent: 99 });
  assert.deepEqual(ui.taskList.children, [ui.$('#taskList .empty-state')]);
  assert.deepEqual(historyIds(ui), ['second', 'first']);
  assert.equal(ui.messages.filter(message => message === '下载完成，已移入任务记录').length, 1);
});

test('burst progress renders only the latest value per frame and drops completed tasks', async () => {
  const ui = taskUi({ listQueue: async () => [task('a', 'queued'), task('b', 'queued')] });
  await ui.context.restoreQueue();
  const [b, a] = ui.taskList.children;
  for (let percent = 1; percent <= 100; percent++) {
    ui.emit('progress', { id: 'a', percent });
    ui.emit('progress', { id: 'b', percent });
  }
  assert.equal(ui.frames.length, 1);
  assert.equal(a.querySelector('.task-percent').textContent, '0%');
  ui.emit('done', { id: 'b', code: 2 });
  ui.frames.shift()();
  assert.equal(a.querySelector('.task-percent').textContent, '100.0%');
  assert.equal(b.querySelector('.task-percent').textContent, '0%');
  assert.deepEqual(ui.taskList.children, [a]);
});

test('retry remembers an immediate terminal event for the new task ID', async () => {
  const ui = taskUi({
    history: async () => [record('original')],
    async retryDownload(id) {
      assert.equal(id, 'original');
      const done = { id: 'retry', code: 1, record: record('retry') };
      ui.emit('done', done);
      ui.emit('done', done);
      return task('retry');
    }
  });
  await ui.context.loadHistory();
  const button = ui.history.children[0].querySelector('[data-retry-task]');
  await button.handlers.click({ currentTarget: button });
  assert.equal(ui.taskList.prepended, 0);
  assert.deepEqual(historyIds(ui), ['retry', 'original']);
  assert.deepEqual(ui.messages, ['下载失败，详情已记录']);
});

test('restoration skips terminal tasks, keeps the latest completion, and applies progress by ID', async () => {
  const queue = Promise.withResolvers();
  const older = record('recovered');
  const ui = taskUi({
    history: async () => [older],
    listQueue: () => queue.promise,
    async cancelDownload(id) {
      assert.equal(id, 'queued');
      ui.emit('done', { id, code: 2, record: record(id, 'cancelled') });
      return true;
    }
  });
  await ui.context.loadHistory();
  assert.ok(ui.history.children[0].querySelector('[data-retry-task]'));
  const restoring = ui.context.restoreQueue();
  ui.emit('done', { id: older.id, code: 1, record: older });
  const updated = { ...record(older.id, 'completed'), completedAt: '2026-01-02' };
  const done = { id: older.id, code: 0, record: updated };
  ui.emit('done', done);
  ui.emit('done', done);
  ui.emit('done', { id: 'finished', code: 1, record: record('finished') });
  ui.emit('progress', { id: 'finished', percent: 100 });
  ui.emit('progress', { id: 'running', percent: 32 });
  queue.resolve([
    task(older.id, 'downloading'), task('finished', 'downloading'),
    task('running', 'downloading'), task('queued', 'queued'), task('running', 'queued')
  ]);
  await restoring;
  assert.equal(ui.taskList.prepended, 2);
  assert.deepEqual(ui.taskList.children.map(card => card.dataset.task), ['queued', 'running']);
  assert.deepEqual(historyIds(ui), ['finished', older.id]);
  const recovered = ui.history.children[1];
  assert.equal(recovered.dataset.completedAt, updated.completedAt);
  assert.equal(recovered.querySelector('[data-retry-task]'), null);
  assert.deepEqual(ui.messages, ['下载完成，已移入任务记录', '下载失败，详情已记录']);
  const [queued, running] = ui.taskList.children;
  assert.equal(queued.querySelector('.task-status').textContent, '队列中');
  assert.equal(running.querySelector('.task-status').textContent, '下载中');
  assert.equal(running.querySelector('.progress-track').value, 32);
  assert.equal(running.querySelector('.task-percent').textContent, '32.0%');
  const button = queued.querySelector('[data-cancel-task]');
  await button.handlers.click({ currentTarget: button });
  assert.deepEqual(ui.taskList.children.map(card => card.dataset.task), ['running']);
  assert.deepEqual(historyIds(ui), ['queued', 'finished', older.id]);
});

test('history reads merge terminal records and a successful clear supersedes an older snapshot', async () => {
  const initialHistory = Promise.withResolvers();
  const staleHistory = Promise.withResolvers();
  const clear = Promise.withResolvers();
  const snapshots = [initialHistory.promise, staleHistory.promise, [record('after-clear')]];
  const ui = taskUi({
    history: async () => snapshots.shift(),
    clearHistory: () => clear.promise
  });
  const initial = ui.context.loadHistory();
  ui.emit('done', { id: 'early', code: 1, record: record('early') });
  ui.emit('done', { id: 'already-listed', code: 1, record: record('already-listed') });
  initialHistory.resolve([record('already-listed'), record('older')]);
  await initial;
  assert.deepEqual(historyIds(ui), ['already-listed', 'early', 'older']);

  const stale = ui.context.loadHistory();
  const clearing = ui.$('#clearBtn').handlers.click();
  ui.emit('done', { id: 'after-clear', code: 1, record: record('after-clear') });
  clear.resolve(true);
  await clearing;
  staleHistory.resolve([record('older')]);
  await stale;
  assert.deepEqual(historyIds(ui), ['after-clear']);
});

test('a history snapshot that returns after a successful delete cannot restore the deleted record', async () => {
  const staleHistory = Promise.withResolvers();
  const snapshots = [[record('deleted'), record('kept')], staleHistory.promise, [record('kept')]];
  const ui = taskUi({
    history: async () => snapshots.shift(),
    async removeHistory(ids) { assert.deepEqual(Array.from(ids), ['deleted']); }
  });
  await ui.context.loadHistory();
  ui.history.querySelectorAll('[data-history-id]')[0].checked = true;
  const stale = ui.context.loadHistory();
  await ui.$('#deleteHistoryBtn').handlers.click();
  staleHistory.resolve([record('deleted'), record('kept')]);
  await stale;
  assert.deepEqual(historyIds(ui), ['kept']);
});
