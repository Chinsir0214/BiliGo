const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { existsSync, readFileSync: readFile } = require('node:fs');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { extname, join, resolve, sep } = require('node:path');

test('partial queue failure leaves only unsent items for retry', async () => {
  const { enqueueSelectedItems } = await import('../src/download/submit.mjs');
  const entries = ['A', 'B', 'C'].map((title, index) => ({ index, item: { title } }));
  const submitted = new Set();
  const calls = [];
  const rendered = [];
  const enqueue = async request => {
    calls.push(request.title);
    if (request.title === 'B' && calls.filter(title => title === 'B').length === 1) {
      throw new Error('queue unavailable');
    }
    return { id: 'task-' + request.title, title: request.title };
  };
  const onQueued = (entry, result) => {
    submitted.add(entry.index);
    rendered.push(result.title);
  };
  const makeRequest = entry => ({ title: entry.item.title });

  const first = await enqueueSelectedItems(entries, makeRequest, enqueue, onQueued);
  assert.equal(first.queued, 1);
  assert.equal(first.remaining, 2);
  assert.match(first.error.message, /queue unavailable/);
  assert.deepEqual(calls, ['A', 'B']);
  assert.deepEqual([...submitted], [0]);

  const retry = await enqueueSelectedItems(entries.filter(entry => !submitted.has(entry.index)), makeRequest, enqueue, onQueued);
  assert.equal(retry.queued, 2);
  assert.equal(retry.remaining, 0);
  assert.equal(retry.error, null);
  assert.deepEqual(calls, ['A', 'B', 'B', 'C']);
  assert.deepEqual(rendered, ['A', 'B', 'C']);
});
async function runBrowserProbes() {
  const output = document.createElement('pre');
  output.id = 'renderer-probe-result';
  document.body.append(output);
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const key = (key, shiftKey = false) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
  const shell = document.querySelector('.app-shell');
  async function waitFor(predicate, message) {
    const deadline = performance.now() + 1500;
    while (!predicate()) {
      if (performance.now() >= deadline)
        throw new Error(message);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  async function customSelects() {
    const native = document.querySelector('#videoQuality');
    const wrapper = native.previousElementSibling;
    const trigger = wrapper.querySelector('.custom-select-button');
    const legacyQuality = native.value === 'bv*';
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const arrowOpened = trigger.getAttribute('aria-expanded') === 'true' && document.activeElement.classList.contains('custom-select-option');
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const escapeClosed = trigger.getAttribute('aria-expanded') === 'false' && document.activeElement === trigger;
    trigger.click();
    document.querySelector('#urlInput').focus();
    const tabClosed = trigger.getAttribute('aria-expanded') === 'false' && !wrapper.classList.contains('open');
    trigger.click();
    document.body.click();
    const outsideClosed = trigger.getAttribute('aria-expanded') === 'false' && !wrapper.classList.contains('open');
    trigger.click();
    wrapper.querySelectorAll('.custom-select-option')[1].click();
    const selectedClosed = trigger.getAttribute('aria-expanded') === 'false' && native.value === 'bv[height<=2160]';
    await settle();
    const qualitySaved = native.value === 'bv[height<=2160]' && window.savedChanges.some(change => change.videoQuality === native.value);
    const optionTabStops = [...wrapper.querySelectorAll('[role=option]')].every(option => option.tabIndex === -1);
    const controlsLinked = trigger.getAttribute('aria-controls') === wrapper.querySelector('[role=listbox]').id;
    const subtitleMenu = document.querySelector('#subtitlePicker [role=listbox]');
    const subtitleTrigger = document.querySelector('#subtitlePicker .custom-select-button');
    const multiSemantics = subtitleMenu.getAttribute('aria-multiselectable') === 'true' && subtitleTrigger.getAttribute('aria-controls') === subtitleMenu.id;
    return { arrowOpened, escapeClosed, tabClosed, outsideClosed, selectedClosed, qualitySaved, legacyQuality, optionTabStops, controlsLinked, multiSemantics };
  }
  async function navigation() {
    const historyEmpty = document.querySelector('#historyList .empty-state');
    const historyDeferred = !window.historyReads;
    const settingsMenusDeferred = !document.querySelector('#settingsView select').previousElementSibling?.classList.contains('custom-select');
    document.querySelector('[data-view=history]').click();
    await settle();
    const historyEmptyReused = historyEmpty === document.querySelector('#historyList .empty-state');
    document.querySelector('[data-view=download]').click();
    document.querySelector('input[value=cover]').click();
    document.querySelector('input[value=audio]').click();
    const format = document.querySelector('#audioFormat');
    const audioWithExtras = !format.disabled && document.querySelector('#embedSubs').disabled && document.querySelector('#containerFormat').disabled;
    return { historyDeferred, settingsMenusDeferred, historyEmptyReused, audioWithExtras };
  }
  async function loginDialog() {
    const login = document.querySelector('#loginSmall');
    login.focus();
    login.click();
    await settle();
    const dialog = document.querySelector('#loginModal');
    const loginFocused = shell.inert && document.activeElement.id === 'closeModal' && dialog.getAttribute('aria-modal') === 'true';
    const loginWrapsBack = !key('Tab', true) && document.activeElement.id === 'refreshQr';
    const loginWrapsForward = !key('Tab') && document.activeElement.id === 'closeModal';
    key('Escape');
    const loginDismissed = dialog.classList.contains('hidden') && !shell.inert && document.activeElement === login && window.loginCancellations === 1;
    return { loginFocused, loginWrapsBack, loginWrapsForward, loginDismissed };
  }
  async function settings() {
    document.querySelector('[data-view=settings]').click();
    const formatTriggerEnabled = !document.querySelector('#audioFormat').previousElementSibling.querySelector('button').disabled;
    const threads = document.querySelector('#fragmentThreads');
    const threadsRestored = threads.value === '15' && threads.options.length === 16 && threads.previousElementSibling.querySelector('button').textContent === '15 个';
    const retries = document.querySelector('#performanceRetries');
    const retriesRestored = retries.value === '7' && retries.previousElementSibling.querySelector('button').textContent === '7 次';
    retries.value = '10';
    retries.dispatchEvent(new Event('change'));
    const concurrency = document.querySelector('#maxConcurrentTasks');
    const concurrencyRestored = concurrency.value === '8' && concurrency.previousElementSibling.querySelector('button').textContent === '8 个';
    await settle();
    const retriesSaved = window.savedChanges.some(change => change.retries === '10');
    const resetTrigger = document.querySelector('#resetSettingsBtn');
    resetTrigger.focus();
    resetTrigger.click();
    const resetDialog = document.querySelector('#resetSettingsModal');
    const resetFocused = shell.inert && document.activeElement.id === 'cancelResetSettings' && document.elementFromPoint(5, 70) === resetDialog;
    key('Escape');
    const resetDismissed = resetDialog.classList.contains('hidden') && !shell.inert && document.activeElement === resetTrigger;
    resetTrigger.click();
    document.querySelector('#confirmResetSettings').click();
    key('Escape');
    const resetBusy = !resetDialog.classList.contains('hidden') && document.activeElement === resetDialog && resetDialog.getAttribute('aria-busy') === 'true';
    await waitFor(() => window.finishReset, 'reset did not start');
    window.finishReset();
    await settle();
    const resetRestored = resetDialog.classList.contains('hidden') && !shell.inert && document.activeElement === resetTrigger && threads.value === '3' && threads.previousElementSibling.querySelector('button').textContent === '3 个' && retries.value === '3';
    const directoryUpdated = document.querySelector('#downloadDirText').textContent === 'Default/BiliGo' && document.querySelector('#destination').textContent === '保存至 Default/BiliGo';
    return { formatTriggerEnabled, threadsRestored, retriesRestored, concurrencyRestored, retriesSaved, resetFocused, resetDismissed, resetBusy, resetRestored, directoryUpdated };
  }
  async function downloadFeedback() {
    const running = document.querySelector('[data-task=running]');
    const progress = running.querySelector('progress');
    const queued = document.querySelector('[data-task=queued] progress');
    const progressInitiallyUnknown = progress.position === -1 && !progress.hasAttribute('value') && running.querySelector('.task-percent').textContent === '—';
    const progressNamed = progress.getAttribute('aria-label') === '下载进度：' + running.querySelector('.task-title').textContent;
    const queuedProgressZero = queued.hasAttribute('value') && queued.position === 0;
    const frames = [];
    window.requestAnimationFrame = callback => frames.push(callback);
    window.emitBili('download:progress', { id: 'running', percent: 0 });
    const hiddenProgressDeferred = progress.position === -1;
    const downloadTab = document.querySelector('[data-view=download]');
    downloadTab.focus();
    downloadTab.click();
    frames.shift()();
    const progressReachedZero = progress.hasAttribute('value') && progress.position === 0;
    window.emitBili('download:progress', { id: 'running', percent: 37.5, speed: '1 MB/s', eta: '00:10' });
    frames.shift()();
    const progressUpdated = progress.max === 100 && progress.value === 37.5 && running.querySelector('.task-percent').textContent === '37.5%' && running.querySelector('.task-info').textContent.includes('00:10');
    const toast = document.querySelector('#toast');
    window.emitBili('download:done', { id: 'running', code: 0 });
    const completionAnnounced = !running.isConnected && toast.getAttribute('role') === 'status' && toast.textContent === '下载完成，已移入任务记录' && document.activeElement === downloadTab;
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    window.emitBili('app:error', '稍后重试');
    await delay(300);
    window.emitBili('app:error', '稍后重试');
    await delay(2600);
    const toastKeptLatest = toast.classList.contains('show') && toast.textContent === '稍后重试';
    await delay(350);
    const toastExpired = !toast.classList.contains('show');
    return { progressInitiallyUnknown, progressNamed, queuedProgressZero, hiddenProgressDeferred, progressReachedZero, progressUpdated, completionAnnounced, toastKeptLatest, toastExpired };
  }
  async function downloadSubmission() {
    const parseButton = document.querySelector('#parseBtn');
    const parseIcon = parseButton.querySelector('[aria-hidden=true]');
    document.querySelector('#urlInput').value = 'https://www.bilibili.com/video/BVtest';
    parseButton.click();
    const iconWhileLoading = Boolean(parseIcon && parseIcon.isConnected && !parseIcon.textContent.trim() && parseButton.disabled && parseButton.textContent.trim() === '正在加载全部内容…');
    await settle();
    const parseIconRestored = parseIcon?.parentElement === parseButton && parseButton.textContent.trim() === '解析内容';
    const submitButton = document.querySelector('#downloadBtn');
    submitButton.click();
    const submissionBusy = submitButton.disabled && submitButton.getAttribute('aria-busy') === 'true';
    await waitFor(() => !submitButton.hasAttribute('aria-busy'), 'download submission did not finish');
    const downloadSubmitted = window.downloadRequests.length === 1 && window.downloadRequests[0].title === '测试条目' && !!document.querySelector('[data-task=submitted]') && document.querySelector('#toast').textContent === '已将 1 个视频分别加入下载队列';
    return { iconWhileLoading, parseIconRestored, submissionBusy, downloadSubmitted };
  }
  try {
    await import('/renderer/main.mjs');
    if (document.readyState !== 'complete')
      await new Promise(resolve => window.addEventListener('load', resolve, { once: true }));
    await waitFor(() => document.querySelector('[data-task=queued]') && document.querySelector('#downloadDirText').textContent === 'Downloads/BiliGo', 'renderer did not restore settings and tasks');
    const outcome = {};
    for (const probe of [customSelects, navigation, loginDialog, settings, downloadFeedback, downloadSubmission]) {
      outcome[probe.name] = await probe();
    }
    output.textContent = JSON.stringify(outcome);
  }
  catch (error) {
    output.textContent = JSON.stringify({ error: error.message });
  }
}

const chromeCandidates = [
  process.env.CHROME_BIN,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].filter(Boolean);
const chrome = chromeCandidates.find(existsSync);

test('renderer DOM supports controls, dialogs, and download feedback', async t => {
  if (!chrome) {
    if (process.env.CI) assert.fail('Chrome or Edge is required for renderer UI tests in CI');
    return t.skip('Chrome or Edge unavailable');
  }
  const srcRoot = resolve(__dirname, '..', 'src');
  const entry = '<script type="module" src="renderer/main.mjs"></script>';
  const source = readFile(join(srcRoot, 'index.html'), 'utf8');
  assert.ok(source.includes(entry), 'renderer module entry must be present');
  const html = source.replace(entry, '<script src="/mock.js"></script>' + entry + '<script type="module" src="/probe.js"></script>');
  const mock = `
    const savedSettings = {contentModes:['video-audio'],downloadDir:'Downloads/BiliGo',fragmentThreads:15,
      maxConcurrentTasks:8,containerFormat:'mp4',videoQuality:'bv',audioQuality:'ba/b',audioFormat:'original',
      retries:'7',filenameTemplate:'%(title)s.%(ext)s',subtitleLangs:'all',rateLimit:''};
    window.savedChanges = [];
    window.downloadRequests = [];
    const callbacks = new Map();
    window.emitBili = (channel, payload) => callbacks.get(channel)(payload);
    window.bili = {
      appVersion: async () => '1.3.0',
      loginStatus: async () => ({loggedIn:false, profile:null}),
      startLogin: async () => ({qr:{size:1, data:[1]}}),
      cancelLogin: async () => { window.loginCancellations = (window.loginCancellations || 0) + 1; },
      getSettings: async () => ({...savedSettings}),
      setSettings: async changes => { window.savedChanges.push(changes); Object.assign(savedSettings, changes); return {...savedSettings}; },
      resetSettings: () => new Promise(resolve => {
        window.finishReset = () => resolve({...savedSettings, fragmentThreads:3, maxConcurrentTasks:1, retries:'3', downloadDir:'Default/BiliGo'});
      }),
      history: async () => { window.historyReads = (window.historyReads || 0) + 1; return []; },
      parseResource: async () => ({ title: '测试资源', type: 'video', items: [{title:'测试条目'}] }),
      startDownload: async request => { window.downloadRequests.push(request); return {id:'submitted',title:request.title}; },
      listQueue: async () => [
        { id:'running', title:'《下载 & "合辑"》', mode:'video', status:'downloading' },
        { id:'queued', title:'排队任务', mode:'video', status:'queued' }
      ],
      checkForUpdates: async () => ({hasUpdate:false,currentVersion:'1.3.0'}),
      on(channel, callback) { callbacks.set(channel, callback); }
    };
  `;
  const probe = `(${runBrowserProbes.toString()})();`;
  const mimeTypes = {
    '.mjs': 'text/javascript; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml'
  };
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); return; }
    if (pathname === '/mock.js' || pathname === '/probe.js') {
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      response.end(pathname === '/mock.js' ? mock : probe);
      return;
    }
    const file = resolve(srcRoot, '.' + pathname);
    if (!file.startsWith(srcRoot + sep)) { response.writeHead(404).end(); return; }
    try {
      const body = readFile(file);
      response.setHeader('Content-Type', mimeTypes[extname(file)] || 'application/octet-stream');
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  const profile = await mkdtemp(join(tmpdir(), 'biligo-select-test-'));
  try {
    await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
    const port = server.address().port;
    const { stdout } = await promisify(execFile)(chrome, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', '--window-size=1200,800',
      '--user-data-dir=' + profile, '--virtual-time-budget=5000', '--dump-dom',
      'http://127.0.0.1:' + port + '/'
    ], { maxBuffer: 2 * 1024 * 1024, timeout: 15000 });
    const match = stdout.match(/<pre id="renderer-probe-result">([^<]+)<\/pre>/);
    assert.ok(match, 'browser probe result should be present');
    const outcome = JSON.parse(match[1].replaceAll('&quot;', '"'));
    assert.ifError(outcome.error);
    assert.deepEqual(outcome.customSelects, {
      arrowOpened: true,
      escapeClosed: true,
      tabClosed: true,
      outsideClosed: true,
      selectedClosed: true,
      qualitySaved: true,
      legacyQuality: true,
      optionTabStops: true,
      controlsLinked: true,
      multiSemantics: true
    });
    assert.deepEqual(outcome.navigation, {
      historyDeferred: true,
      settingsMenusDeferred: true,
      historyEmptyReused: true,
      audioWithExtras: true
    });
    assert.deepEqual(outcome.loginDialog, {
      loginFocused: true,
      loginWrapsBack: true,
      loginWrapsForward: true,
      loginDismissed: true
    });
    assert.deepEqual(outcome.settings, {
      formatTriggerEnabled: true,
      threadsRestored: true,
      retriesRestored: true,
      concurrencyRestored: true,
      retriesSaved: true,
      resetFocused: true,
      resetDismissed: true,
      resetBusy: true,
      resetRestored: true,
      directoryUpdated: true
    });
    assert.deepEqual(outcome.downloadFeedback, {
      progressInitiallyUnknown: true,
      progressNamed: true,
      queuedProgressZero: true,
      hiddenProgressDeferred: true,
      progressReachedZero: true,
      progressUpdated: true,
      completionAnnounced: true,
      toastKeptLatest: true,
      toastExpired: true
    });
    assert.deepEqual(outcome.downloadSubmission, {
      iconWhileLoading: true,
      parseIconRestored: true,
      submissionBusy: true,
      downloadSubmitted: true
    });
  } finally {
    await new Promise(done => server.close(done));
    if (resolve(profile).startsWith(resolve(tmpdir()) + sep) && profile.split(sep).at(-1).startsWith('biligo-select-test-')) {
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    }
  }
});
