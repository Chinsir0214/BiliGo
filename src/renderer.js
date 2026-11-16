const $ = selector => document.querySelector(selector);
const { getMediaCapabilities, MEDIA_MODES } = globalThis.BiliGoDownloadOptions;
const downloadFormReady = import('./download/form.js');
const downloadSubmissionReady = import('./download/submit.js');
const downloadSettingFields = {
  videoQuality: 'videoQuality',
  audioQuality: 'audioQuality',
  audioFormat: 'audioFormat',
  containerFormat: 'containerFormat',
  filenameTemplate: 'filenameTemplate',
  subtitleLangs: 'subtitleLangs',
  rateLimit: 'rateLimit',
  embedThumbnail: 'embedThumbnail',
  embedMetadata: 'embedMetadata',
  embedSubs: 'embedSubs',
  embedChapters: 'embedChapters',
  retries: 'performanceRetries',
  fragmentThreads: 'fragmentThreads'
};
const settingsFields = { ...downloadSettingFields, maxConcurrentTasks: 'maxConcurrentTasks', showThumbnails: 'showThumbnails' };
const taskEmptyState = $('#taskList .empty-state');
const historyEmptyState = $('#historyList .empty-state');
const tasks = new Map();
const pendingTaskRequests = new Set();
const finishedTask = Symbol('finishedTask');
let historyRecordsDuringRead;
let parsedResource;
let subtitlePickerControl;
let downloadSubmitting = false;
let parsingResource = false;
let parsedSourceUrl = '';
const submittedSelectionIndices = new Set();
const contentModeInputs = [...document.querySelectorAll('.content-modes .content-check input')];
const labels = { 'video-audio': '视频 + 音频', video: '仅视频', audio: '仅音频', danmaku: '弹幕', subtitle: '字幕', cover: '封面' };
function modeLabel(value) { return String(value || '').split(',').map(item => labels[item] || item).join('、') || '下载任务'; }
let toastTimer;
function toast(message) {
  const element = $('#toast');
  clearTimeout(toastTimer);
  element.textContent = message;
  element.classList.add('show');
  toastTimer = setTimeout(() => element.classList.remove('show'), 2800);
}
async function saveSetting(changes) { try { await window.bili.setSettings(changes); } catch (error) { toast(`设置保存失败：${error.message}`); try { applySettings(await window.bili.getSettings()); } catch (refreshError) { toast(`重新读取设置失败：${refreshError.message}`); } } }
function text(value) { return String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function imageUrl(value) { const url = String(value || '').trim(); return url.startsWith('//') ? `https:${url}` : url.replace(/^http:\/\//i, 'https://'); }
function duration(value) { const seconds = Math.max(0, Math.round(Number(value) || 0)); const hours = Math.floor(seconds / 3600); const minutes = Math.floor((seconds % 3600) / 60); const rest = String(seconds % 60).padStart(2, '0'); return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`; }
function fileSize(value) { const bytes = Number(value) || 0; if (bytes < 1024) return `${bytes} B`; if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`; if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`; return `${(bytes / 1073741824).toFixed(2)} GB`; }

let customSelectId = 0;
function closeCustomSelects(except) {
  document.querySelectorAll('.custom-select.open').forEach(wrapper => {
    if (wrapper === except) return;
    wrapper.classList.remove('open');
    wrapper.querySelector('.custom-select-button').setAttribute('aria-expanded', 'false');
  });
}
function initCustomSelect(wrapper, { select, multiple = false, emptyLabel = '' } = {}) {
  const button = wrapper.querySelector('.custom-select-button');
  const menu = wrapper.querySelector('.custom-select-menu');
  menu.id ||= 'custom-select-menu-' + ++customSelectId;
  button.setAttribute('aria-controls', menu.id);
  if (multiple) menu.setAttribute('aria-multiselectable', 'true');
  const options = () => [...menu.querySelectorAll('.custom-select-option')];
  const selected = () => options().filter(item => item.classList.contains('selected'));
  const fieldLabel = select?.parentElement?.firstChild?.textContent?.trim() || wrapper.parentElement?.firstElementChild?.textContent || '字幕语言';
  const sync = () => {
    if (select) {
      options().forEach(item => {
        item.classList.toggle('selected', item.dataset.value === select.value);
        item.setAttribute('aria-selected', String(item.dataset.value === select.value));
      });
    }
    button.textContent = selected().map(item => item.textContent).join('、') || emptyLabel;
    button.setAttribute('aria-label', fieldLabel + '：' + button.textContent);
  };
  const setOpen = open => {
    if (open) closeCustomSelects(wrapper);
    wrapper.classList.toggle('open', open);
    button.setAttribute('aria-expanded', String(open));
  };
  const render = values => {
    menu.replaceChildren(...values.map(value => {
      const item = document.createElement('button');
      item.type = 'button';
      item.tabIndex = -1;
      item.className = 'custom-select-option';
      item.dataset.value = String(value.value);
      item.textContent = String(value.label || value.value);
      item.setAttribute('role', 'option');
      item.classList.toggle('selected', value.selected === true);
      item.setAttribute('aria-selected', String(value.selected === true));
      return item;
    }));
    sync();
  };
  menu.addEventListener('click', event => {
    const item = event.target.closest('.custom-select-option');
    if (!item) return;
    event.stopPropagation();
    if (multiple) {
      item.classList.toggle('selected');
      item.setAttribute('aria-selected', String(item.classList.contains('selected')));
    } else {
      select.value = item.dataset.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      setOpen(false);
      button.focus();
    }
    sync();
  });
  button.addEventListener('click', event => {
    event.stopPropagation();
    const open = !wrapper.classList.contains('open');
    setOpen(open);
    if (open) (selected()[0] || options()[0])?.focus();
  });
  button.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      const items = options();
      (selected()[0] || items[event.key === 'ArrowDown' ? 0 : items.length - 1])?.focus();
    } else if (event.key === 'Escape') setOpen(false);
  });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); button.focus(); return; }
    const items = options();
    const current = items.indexOf(document.activeElement);
    const next = event.key === 'ArrowDown' ? current + 1 : event.key === 'ArrowUp' ? current - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); items[Math.max(0, Math.min(items.length - 1, next))]?.focus(); }
  });
  wrapper.addEventListener('focusout', event => {
    if (!wrapper.contains(event.relatedTarget)) setOpen(false);
  });
  return { render, sync, values: () => selected().map(item => item.dataset.value), setVisible: visible => wrapper.parentElement.classList.toggle('hidden', !visible) };
}
function setupCustomSelects() {
  document.querySelectorAll('select').forEach(select => {
    const wrapper = document.createElement('div');
    wrapper.className = 'custom-select';
    wrapper.innerHTML = '<button type="button" class="custom-select-button" aria-haspopup="listbox" aria-expanded="false"></button><div class="custom-select-menu" role="listbox"></div>';
    select.parentNode.insertBefore(wrapper, select);
    select.hidden = true;
    const control = initCustomSelect(wrapper, { select });
    control.render([...select.options].map(option => ({ value: option.value, label: option.textContent, selected: option.selected })));
    select.customControl = control;
  });
  document.addEventListener('click', event => { if (!event.target.closest('.custom-select')) closeCustomSelects(); });
}
function syncCheck(input) { input.closest('.content-check')?.classList.toggle('checked', input.checked); }

function subtitlePicker() {
  const label = $('#subtitlePicker');
  const control = initCustomSelect(label.querySelector('.custom-select'), { multiple: true, emptyLabel: '未选择字幕' });
  return {
    refresh: values => control.render(values.map(value => ({ value: value.value, label: value.label || value.value, selected: true }))),
    values: control.values,
    setVisible: visible => label.classList.toggle('hidden', !visible)
  };
}
function setupContentChecks() {
  contentModeInputs.forEach(input => input.addEventListener('change', () => {
    if (input.checked && MEDIA_MODES.includes(input.value)) {
      contentModeInputs.forEach(other => {
        if (other !== input && MEDIA_MODES.includes(other.value)) other.checked = false;
      });
    }
    const contentModes = selectedContentModes();
    if (!contentModes.length) {
      input.checked = true;
      syncDerivedUi();
      return toast('至少选择一种下载内容');
    }
    const changes = { contentModes };
    if (!getMediaCapabilities(contentModes).hasVideo && $('#embedSubs').checked) {
      $('#embedSubs').checked = false;
      changes.embedSubs = false;
    }
    syncDerivedUi();
    saveSetting(changes);
  }));
}
function selectedContentModes() { return contentModeInputs.filter(input => input.checked).map(input => input.value); }
function setDownloadOptionDisabled(id, disabled) { const input = $(`#${id}`); const label = input?.closest('label'); const wrapper = input?.previousElementSibling?.classList.contains('custom-select') ? input.previousElementSibling : null; if (!input || !label) return; input.disabled = disabled; label.classList.toggle('disabled', disabled); if (wrapper) wrapper.querySelector('.custom-select-button').disabled = disabled; }
function syncDerivedUi() {
  const modes = selectedContentModes();
  const { hasVideo, hasMedia, mediaMode } = getMediaCapabilities(modes);
  document.querySelectorAll('.content-check input').forEach(syncCheck);
  setDownloadOptionDisabled('embedSubs', !hasVideo);
  setDownloadOptionDisabled('audioFormat', mediaMode !== 'audio');
  setDownloadOptionDisabled('containerFormat', mediaMode !== 'video-audio');
  ['embedThumbnail', 'embedMetadata', 'embedChapters'].forEach(id => setDownloadOptionDisabled(id, !hasMedia));
  subtitlePickerControl?.setVisible(modes.includes('subtitle') || (hasVideo && $('#embedSubs').checked));
  $('#selectionPanel').classList.toggle('show-covers', $('#showThumbnails').checked);
}

function switchView(view) { const page = { download: ['DOWNLOAD CENTER / 01', '下载中心'], history: ['DOWNLOAD LOG / 02', '任务记录'], settings: ['PREFERENCES / 03', '应用设置'] }[view]; document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === view)); document.querySelectorAll('.view').forEach(item => item.classList.remove('active-view')); $(`#${view}View`).classList.add('active-view'); $('#pageEyebrow').textContent = page[0]; $('#pageTitle').textContent = page[1]; if (view === 'history') loadHistory(); }
function drawQr(qr) { const canvas = $('#qrCanvas'); const size = 164; const scale = size / qr.size; canvas.width = size; canvas.height = size; const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, size, size); context.fillStyle = '#181818'; for (let y = 0; y < qr.size; y += 1) for (let x = 0; x < qr.size; x += 1) if (qr.data[y * qr.size + x]) context.fillRect(Math.round(x * scale), Math.round(y * scale), Math.ceil(scale), Math.ceil(scale)); }
function taskActions(task) { return `<div class="task-actions"><button class="icon-button" data-cancel-task="${text(task.id)}">取消任务</button><button class="icon-button" data-open-video="${text(task.url)}">打开视频</button><button class="icon-button" data-open-folder="${text(task.outputDir || '')}">打开文件夹</button></div>`; }
function bindActions(node) {
  node.querySelector('[data-cancel-task]')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true; button.textContent = '取消中';
    try {
      const cancelled = await window.bili.cancelDownload(button.dataset.cancelTask);
      if (!cancelled) { button.disabled = false; button.textContent = '取消任务'; return toast('任务已结束或不存在'); }
      toast('正在取消任务');
    } catch (error) {
      button.disabled = false; button.textContent = '取消任务';
      toast(`取消任务失败：${error.message}`);
    }
  });
  node.querySelector('[data-open-video]')?.addEventListener('click', event => window.bili.openVideo(event.currentTarget.dataset.openVideo));
  node.querySelector('[data-open-file]')?.addEventListener('click', async event => {
    const file = event.currentTarget.dataset.openFile;
    if (!file) return toast('没有可打开的文件');
    try { await window.bili.playLocalVideo(file); } catch (error) { toast(`打开文件失败：${error.message}`); }
  });
  node.querySelector('[data-open-folder]')?.addEventListener('click', async event => {
    try { await window.bili.openFolder(event.currentTarget.dataset.openFolder); } catch (error) { toast(`打开文件夹失败：${error.message}`); }
  });
  node.querySelector('[data-copy-link]')?.addEventListener('click', async event => { await window.bili.copyLink(event.currentTarget.dataset.copyLink); toast('链接已复制'); });
  node.querySelector('[data-retry-task]')?.addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true; button.textContent = '重试中';
    try {
      const active = await withTaskUpdates(() => window.bili.retryDownload(button.dataset.retryTask), (task, updates) => {
        if (!task?.id) throw new Error('下载队列未返回任务编号');
        return acceptTask(task, updates);
      });
      if (active) toast('已重新加入下载队列');
    }
    catch (error) { button.disabled = false; button.textContent = '重试'; toast(`重试失败：${error.message}`); }
  });
}
async function withTaskUpdates(request, applyResult) {
  // IPC events can arrive while the task ID or the restored queue is still in flight.
  const updates = new Map();
  pendingTaskRequests.add(updates);
  try { return applyResult(await request(), updates); }
  finally { pendingTaskRequests.delete(updates); }
}
function acceptTask(task, updates) {
  const update = updates.get(task.id);
  if (update === finishedTask) return false;
  if (!tasks.has(task.id)) {
    const node = renderTask(task);
    if (update) renderTaskProgress(node, update);
  }
  return true;
}
function renderTask(task) {
  const list = $('#taskList');
  list.querySelector('.empty-state')?.remove();
  const node = document.createElement('div');
  node.className = 'task';
  node.dataset.task = task.id;
  const downloading = task.status === 'downloading';
  const status = downloading ? '下载中' : '队列中';
  const progressValue = downloading ? '' : ' value="0"';
  const percentLabel = downloading ? '—' : '0%';
  node.innerHTML = `<div class="task-main"><div class="task-title">${text(task.title)}</div><div class="task-meta">${text(modeLabel(task.mode))}</div><progress class="progress-track" max="100" aria-label="下载进度：${text(task.title)}"${progressValue}></progress></div><div class="task-side"><div class="task-percent">${percentLabel}</div><div class="task-info">正在准备</div><div class="task-status">${status}</div>${taskActions(task)}</div>`;
  list.prepend(node);
  tasks.set(task.id, node);
  bindActions(node);
  return node;
}
function renderTaskProgress(node, data) {
  const percent = data.percent;
  node.querySelector('.progress-track').value = percent;
  node.querySelector('.task-percent').textContent = `${percent.toFixed(1)}%`;
  node.querySelector('.task-info').textContent = [data.speed, data.eta && `剩余 ${data.eta}`].filter(Boolean).join('  ·  ') || '正在读取视频流';
  node.querySelector('.task-status').textContent = '下载中';
}
function updateTask(data) {
  const node = tasks.get(data.id);
  if (node) return renderTaskProgress(node, data);
  for (const updates of pendingTaskRequests) {
    if (updates.get(data.id) !== finishedTask) updates.set(data.id, data);
  }
}
function historyCard(item) {
  const node = document.createElement('div');
  node.className = 'history-card';
  node.dataset.recordId = String(item.id);
  node.dataset.completedAt = item.completedAt || '';
  const localTarget = /\.(mp4|mkv|webm|mov|m4a|mp3|flac|wav|aac|ogg|opus)$/i.test(item.file || '') ? item.file : '';
  const openFile = localTarget ? `<button class="icon-button" data-open-file="${text(localTarget)}">打开文件</button>` : '';
  const openFolder = item.outputDir ? `<button class="icon-button" data-open-folder="${text(item.outputDir)}">打开文件夹</button>` : '';
  const size = item.sizeBytes ? ` · ${fileSize(item.sizeBytes)}` : '';
  const status = item.status === 'completed' ? '完成' : item.status === 'cancelled' ? '已取消' : `失败${item.error ? `：${text(item.error)}` : ''}`;
  const retry = item.status === 'failed' && item.retryTask ? `<button class="icon-button" data-retry-task="${text(item.id)}">重试</button>` : '';
  node.innerHTML = `<label class="history-check"><input type="checkbox" data-history-id="${text(item.id)}"></label><div class="history-card-main"><strong>${text(item.title)}</strong><span>${text(modeLabel(item.mode))} · ${status} · ${item.fileCount || 0} 个文件${size} · ${new Date(item.completedAt).toLocaleString()}</span></div><div class="history-actions">${retry}${openFile}<button class="icon-button" data-copy-link="${text(item.url)}">复制链接</button>${openFolder}</div>`;
  bindActions(node);
  return node;
}
function syncHistoryActions() { const hasItems = Boolean($('#historyList .history-card')); ['selectHistoryBtn', 'deleteHistoryBtn', 'clearBtn'].forEach(id => { $(`#${id}`).disabled = !hasItems; }); }
function renderEmptyHistory() {
  $('#historyList').replaceChildren(historyEmptyState);
  syncHistoryActions();
}
async function loadHistory() {
  const recentRecords = new Map();
  historyRecordsDuringRead = recentRecords;
  try {
    const list = $('#historyList');
    const items = await window.bili.history();
    if (historyRecordsDuringRead !== recentRecords) return true;
    const records = [...recentRecords.values()].reverse().concat(items.filter(item => !recentRecords.has(item.id)));
    if (!records.length) renderEmptyHistory();
    else { list.replaceChildren(...records.map(historyCard)); syncHistoryActions(); }
    return true;
  } catch (error) {
    if (historyRecordsDuringRead === recentRecords) toast(`读取任务记录失败：${error.message}`);
    return false;
  } finally {
    if (historyRecordsDuringRead === recentRecords) historyRecordsDuringRead = undefined;
  }
}
function finishTask(data) {
  const node = tasks.get(data.id);
  let alreadyFinished = false;
  for (const updates of pendingTaskRequests) {
    if (updates.get(data.id) === finishedTask) alreadyFinished = true;
    updates.set(data.id, finishedTask);
  }
  if (node) {
    node.remove();
    tasks.delete(data.id);
    if (!tasks.size) $('#taskList').replaceChildren(taskEmptyState);
  }
  if (data.record) {
    const list = $('#historyList');
    const displayed = [...list.children].find(card => card.dataset.recordId === String(data.record.id));
    historyRecordsDuringRead?.set(data.record.id, data.record);
    if (displayed?.dataset.completedAt !== (data.record.completedAt || '')) {
      displayed?.remove();
      historyEmptyState.remove();
      list.prepend(historyCard(data.record));
      syncHistoryActions();
    } else if (!node) return;
  } else if (alreadyFinished && !node) return;
  toast(data.code === 0 ? '下载完成，已移入任务记录' : data.code === 2 ? '任务已取消' : '下载失败，详情已记录');
}
let activeModal;
function openModal(dialog, trigger, initialFocus, dismiss) {
  if (activeModal) return activeModal.dialog === dialog;
  activeModal = { dialog, trigger, dismiss };
  $('.app-shell').inert = true;
  dialog.classList.remove('hidden');
  initialFocus.focus();
  return true;
}
function closeModal(dialog) {
  if (activeModal?.dialog !== dialog) return;
  const { trigger } = activeModal;
  activeModal = undefined;
  dialog.classList.add('hidden');
  $('.app-shell').inert = false;
  trigger?.focus();
}
document.addEventListener('keydown', event => {
  if (!activeModal) return;
  const { dialog, dismiss } = activeModal;
  if (event.key === 'Escape') {
    event.preventDefault();
    dismiss();
  } else if (event.key === 'Tab') {
    const buttons = [...dialog.querySelectorAll('button:not(:disabled)')];
    const index = buttons.indexOf(document.activeElement);
    if (index === -1 || index === (event.shiftKey ? 0 : buttons.length - 1)) {
      event.preventDefault();
      (buttons[event.shiftKey ? buttons.length - 1 : 0] || dialog).focus();
    }
  }
});

const loginModal = $('#loginModal');
let loginRequest;
function closeLogin() {
  loginRequest = undefined;
  closeModal(loginModal);
  window.bili.cancelLogin().catch(error => toast(`取消登录失败：${error.message}`));
}
function applyProfile(profile, loggedIn = Boolean(profile)) { const avatar = $('#accountAvatar'); if (profile?.avatar) { avatar.src = imageUrl(profile.avatar); avatar.style.display = 'block'; } else { avatar.removeAttribute('src'); avatar.style.display = 'none'; } const accountName = profile?.name || (loggedIn ? '已登录' : '未登录'); $('#accountText').textContent = accountName; $('#loginSmall').disabled = false; $('#loginSmall').textContent = loggedIn ? '退出' : '登录'; $('#loginBtn').disabled = false; $('#loginBtn').classList.toggle('primary-button', !loggedIn); $('#loginBtn').classList.toggle('ghost-button', loggedIn); $('#loginBtn').classList.add('small'); $('#loginBtn').textContent = loggedIn ? '退出账号' : '扫码登录'; $('#settingLogin').textContent = loggedIn ? `已登录${profile?.name ? `：${profile.name}` : ''}` : '尚未使用扫码登录。'; }
async function beginLogin(trigger) {
  if (!openModal(loginModal, trigger, $('#closeModal'), closeLogin)) return;
  const request = loginRequest = Symbol('loginRequest');
  $('#loginHint').textContent = '二维码生成中…';
  try {
    const login = await window.bili.startLogin();
    if (loginRequest !== request) return;
    drawQr(login.qr);
    $('#loginHint').textContent = '请使用 Bilibili App 扫一扫';
  } catch (error) {
    if (loginRequest === request) $('#loginHint').textContent = error.message;
  }
}
async function refreshAccountStatus() { const status = await window.bili.loginStatus(); applyProfile(status.profile, status.loggedIn); return status; }
async function handleAccount(event) {
  const trigger = event.currentTarget;
  const status = await refreshAccountStatus();
  if (status.loggedIn) { await window.bili.logout(); applyProfile(null); toast('已退出登录'); }
  else beginLogin(trigger);
}

subtitlePickerControl = subtitlePicker();
const refreshLoginButton = $('#refreshLoginBtn');
refreshLoginButton.addEventListener('click', async () => { refreshLoginButton.disabled = true; try { const status = await window.bili.loginStatus(); applyProfile(status.profile, status.loggedIn); toast(status.profile ? '账号状态正常：' + status.profile.name : status.loggedIn ? '登录凭据存在，但账号资料暂时不可用' : '当前未登录'); } catch (error) { toast('刷新失败：' + error.message); } finally { refreshLoginButton.disabled = false; } });
document.querySelectorAll('.nav-item').forEach(item => item.addEventListener('click', () => switchView(item.dataset.view)));
setupCustomSelects(); setupContentChecks(); syncDerivedUi();
window.bili.appVersion().then(version => { $('#appVersion').firstChild.textContent = `BiliGo ${version} `; }).catch(() => {});

async function checkUpdates(showToast = true) { const button = $('#checkUpdateBtn'); const status = $('#updateStatus'); button.disabled = true; button.textContent = '检查中'; delete button.dataset.updateUrl; try { const result = await window.bili.checkForUpdates(); if (result.hasUpdate) { status.textContent = `发现新版本 ${result.latestVersion}（当前 ${result.currentVersion}）`; button.textContent = '查看更新'; button.dataset.updateUrl = result.pageUrl; if (showToast) toast(`发现新版本 ${result.latestVersion}`); return; } status.textContent = `当前已是最新版本 ${result.currentVersion}`; button.textContent = '重新检查'; if (showToast) toast('当前已是最新版本'); } catch (error) { status.textContent = '更新检查失败，请稍后重试。'; button.textContent = '重新检查'; if (showToast) toast(`更新检查失败：${error.message}`); } finally { button.disabled = false; } }
$('#checkUpdateBtn').addEventListener('click', event => { const url = event.currentTarget.dataset.updateUrl; if (url) return window.bili.openVideo(url); checkUpdates(true); }); checkUpdates(false);
Object.entries(settingsFields).forEach(([key, id]) => {
  const input = $(`#${id}`);
  input.addEventListener('change', () => {
    syncDerivedUi();
    saveSetting({ [key]: input.type === 'checkbox' ? input.checked : input.value });
  });
});

const resetSettingsModal = $('#resetSettingsModal');
const closeResetSettings = () => {
  if (!resetSettingsModal.hasAttribute('aria-busy')) closeModal(resetSettingsModal);
};
$('#resetSettingsBtn').addEventListener('click', event => openModal(resetSettingsModal, event.currentTarget, $('#cancelResetSettings'), closeResetSettings));
$('#closeResetSettings').addEventListener('click', closeResetSettings);
$('#cancelResetSettings').addEventListener('click', closeResetSettings);
$('#confirmResetSettings').addEventListener('click', async event => {
  const button = event.currentTarget;
  const actions = resetSettingsModal.querySelectorAll('button');
  resetSettingsModal.setAttribute('aria-busy', 'true');
  actions.forEach(action => { action.disabled = true; });
  resetSettingsModal.focus();
  try {
    applySettings(await window.bili.resetSettings());
    toast('已恢复默认设置');
    closeModal(resetSettingsModal);
  } catch (error) {
    toast('恢复设置失败：' + error.message);
  } finally {
    resetSettingsModal.removeAttribute('aria-busy');
    actions.forEach(action => { action.disabled = false; });
    if (activeModal?.dialog === resetSettingsModal) button.focus();
  }
});
function isUnavailableItem(item) { return item.unavailable === true || (parsedResource?.type === 'favorite' && !item.url); }
function appendSelectionItems(items, offset = 0) { $('#selectionList').insertAdjacentHTML('beforeend', items.map((item, index) => { const unavailable = isUnavailableItem(item); return `<label class="selection-item${unavailable ? ' unavailable' : ''}"><input type="checkbox" data-index="${offset + index}"${unavailable ? ' disabled' : ' checked'}><img class="selection-item-cover" src="${text(imageUrl(item.thumbnail || parsedResource.thumbnail || ''))}" alt=""><span class="selection-item-title">${text(item.title)}${unavailable ? ' <em>已失效</em>' : ''}</span><span class="selection-item-duration">${duration(item.duration)}</span></label>`; }).join('')); $('#selectionList').querySelectorAll('img:not([data-bound])').forEach(image => { image.dataset.bound = 'true'; image.addEventListener('error', () => { image.style.visibility = 'hidden'; }); }); }
function updateSelectionTitle() { if (!parsedResource) return; const loaded = parsedResource.items.length; const unavailable = parsedResource.items.filter(isUnavailableItem).length; const available = loaded - unavailable; const total = Number(parsedResource.total); const count = Number.isFinite(total) && total > 0 && loaded !== total ? `已加载 ${loaded} 项（平台标称 ${total} 项）` : `共 ${loaded} 项`; $('#selectionTitle').textContent = parsedResource.title; $('#selectionSummary').textContent = `${count} · 可用 ${available} 项 · 已失效 ${unavailable} 项`; }

function syncSelectionSubmitUi() {
  const button = $('#downloadBtn');
  if (downloadSubmitting) return;
  const remaining = document.querySelectorAll('#selectionList input:checked:not(:disabled)').length;
  button.disabled = parsingResource || !parsedResource || !remaining;
  button.lastChild.textContent = submittedSelectionIndices.size ? '继续下载已选内容' : '下载已选内容';
}
function renderSelection(resource, sourceUrl) {
  parsedSourceUrl = sourceUrl;
  parsedResource = { ...resource, items: [...resource.items] };
  submittedSelectionIndices.clear();
  const notice = $('#selectionNotice');
  notice.textContent = '';
  notice.classList.add('hidden');
  const subtitleOptions = [...new Map(resource.items.flatMap(item => item.subtitleLanguages || []).map(item => [item.value, item])).values()];
  subtitlePickerControl.refresh(subtitleOptions);
  updateSelectionTitle();
  const cover = $('#selectionCover');
  const coverUrl = imageUrl(resource.thumbnail);
  if (coverUrl) { cover.src = coverUrl; cover.style.display = 'block'; cover.onerror = () => { cover.style.display = 'none'; }; }
  else { cover.removeAttribute('src'); cover.style.display = 'none'; }
  $('#selectionList').innerHTML = '';
  appendSelectionItems(parsedResource.items);
  $('#selectionPanel').classList.remove('hidden');
  syncSelectionSubmitUi();
}
$('#parseBtn').addEventListener('click', async () => {
  if (parsingResource || downloadSubmitting) return;
  const url = $('#urlInput').value.trim();
  if (!url) return toast('请先粘贴 Bilibili 链接');
  if (!/^https?:\/\//.test(url)) return toast('请输入有效的视频链接');
  parsingResource = true;
  $('#parseBtn').disabled = true;
  $('#downloadBtn').disabled = true;
  $('#parseBtn').lastChild.textContent = '正在加载全部内容…';
  try {
    renderSelection(await window.bili.parseResource(url), url);
    toast('解析完成，请选择要下载的内容');
  } catch (error) {
    toast(error.message);
  } finally {
    parsingResource = false;
    $('#parseBtn').disabled = false;
    $('#parseBtn').lastChild.textContent = '解析内容';
    syncSelectionSubmitUi();
  }
});

$('#downloadBtn').addEventListener('click', async () => {
  if (downloadSubmitting) return;
  if (parsingResource) return toast('请等待解析完成');
  if (!parsedResource) return toast('请先解析链接');
  const entries = [...document.querySelectorAll('#selectionList input:checked:not(:disabled)')]
    .map(input => ({ input, index: Number(input.dataset.index), item: parsedResource.items[Number(input.dataset.index)] }))
    .filter(entry => entry.item && !isUnavailableItem(entry.item) && !submittedSelectionIndices.has(entry.index));
  downloadSubmitting = true;
  const button = $('#downloadBtn');
  const parseButton = $('#parseBtn');
  const selectAllButton = $('#selectAllBtn');
  const selectableInputs = [...document.querySelectorAll('#selectionList input:not(:disabled)')];
  button.disabled = parseButton.disabled = selectAllButton.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.lastChild.textContent = '正在加入队列…';
  selectableInputs.forEach(input => { input.disabled = true; });
  try {
    const form = await downloadFormReady;
    const values = form.readDownloadForm({
      sourceUrl: parsedSourceUrl,
      selectedItems: entries.map(entry => entry.item),
      resource: parsedResource,
      modes: selectedContentModes(),
      controls: Object.fromEntries(Object.entries(downloadSettingFields).map(([key, id]) => [key, $(`#${id}`)])),
      subtitleValues: subtitlePickerControl.values()
    });
    const validationError = form.validateDownloadForm(values);
    if (validationError) return toast(validationError);
    const { enqueueSelectedItems } = await downloadSubmissionReady;
    const outcome = await enqueueSelectedItems(
      entries,
      entry => form.buildDownloadRequest(values, entry.item),
      request => withTaskUpdates(() => window.bili.startDownload(request), (result, updates) => {
        if (result?.id) acceptTask({
          ...result,
          url: result.url || request.url,
          title: result.title || request.title,
          mode: result.mode || request.contentModes.join(',')
        }, updates);
        return result;
      }),
      entry => {
        submittedSelectionIndices.add(entry.index);
        entry.input.checked = false;
        entry.input.closest('.selection-item').classList.add('queued');
        entry.input.closest('.selection-item').querySelector('.selection-item-title').insertAdjacentHTML('beforeend', ' <em>已入队</em>');
      }
    );
    if (outcome.error) {
      const message = '已入队 ' + outcome.queued + ' 项；剩余 ' + outcome.remaining + ' 项未提交。' + (outcome.error.message || String(outcome.error)) + '。可继续下载已选内容';
      const notice = $('#selectionNotice');
      notice.textContent = message;
      notice.classList.remove('hidden');
      toast(message);
      return;
    }
    toast('已将 ' + outcome.queued + ' 个视频分别加入下载队列');
    $('#selectionPanel').classList.add('hidden');
    parsedResource = null;
    $('#urlInput').value = '';
  } catch (error) {
    toast('加入队列失败：' + (error.message || String(error)));
  } finally {
    selectableInputs.forEach(input => { if (!submittedSelectionIndices.has(Number(input.dataset.index))) input.disabled = false; });
    downloadSubmitting = false;
    parseButton.disabled = selectAllButton.disabled = false;
    button.removeAttribute('aria-busy');
    syncSelectionSubmitUi();
  }
});
$('#selectionList').addEventListener('change', syncSelectionSubmitUi);
$('#selectAllBtn').addEventListener('click', () => { const boxes = [...document.querySelectorAll('#selectionList input:not(:disabled)')]; const checked = boxes.length > 0 && boxes.every(box => box.checked); boxes.forEach(box => { box.checked = !checked; }); syncSelectionSubmitUi(); });
$('#clearBtn').addEventListener('click', async () => {
  try {
    await window.bili.clearHistory();
    renderEmptyHistory();
    toast('任务记录已清空');
    await loadHistory();
  }
  catch (error) { toast(`清空任务记录失败：${error.message}`); }
});
$('#selectHistoryBtn').addEventListener('click', () => { const boxes = document.querySelectorAll('[data-history-id]'); const checked = boxes.length && [...boxes].every(box => box.checked); boxes.forEach(box => { box.checked = !checked; }); });
$('#deleteHistoryBtn').addEventListener('click', async () => {
  const ids = [...document.querySelectorAll('[data-history-id]:checked')].map(box => box.dataset.historyId);
  if (!ids.length) return toast('请先选择任务');
  try { await window.bili.removeHistory(ids); if (await loadHistory()) toast('已删除选中的任务'); }
  catch (error) { toast(`删除任务记录失败：${error.message}`); }
});
$('#loginBtn').addEventListener('click', handleAccount);
$('#loginSmall').addEventListener('click', handleAccount);
$('#refreshQr').addEventListener('click', () => beginLogin());
$('#closeModal').addEventListener('click', closeLogin);
function showDownloadDirectory(dir) {
  $('#downloadDirText').textContent = dir;
  $('#destination').textContent = `保存至 ${dir}`;
}
$('#openFolderBtn').addEventListener('click', async () => {
  try { await window.bili.openFolder(); }
  catch (error) { toast(`打开文件夹失败：${error.message}`); }
});
$('#chooseFolderBtn').addEventListener('click', async () => {
  try {
    const dir = await window.bili.chooseDownloadDir();
    if (dir) {
      showDownloadDirectory(dir);
      toast('下载目录已更新');
    }
  } catch (error) { toast(`选择下载目录失败：${error.message}`); }
});
window.bili.on('download:progress', updateTask);
window.bili.on('download:done', finishTask);
window.bili.on('app:error', toast);
window.bili.on('login:success', data => {
  loginRequest = undefined;
  closeModal(loginModal);
  applyProfile(data.profile, data.loggedIn !== false);
  toast('登录成功');
});
window.bili.on('login:scanned', () => { $('#loginHint').textContent = '已扫码，请在手机上确认'; });
window.bili.on('login:expired', () => { $('#loginHint').textContent = '二维码已过期，请刷新后重试'; });
window.bili.on('login:error', data => { $('#loginHint').textContent = data.message || '登录失败，请刷新二维码重试'; });

function applySettings(settings) {
  showDownloadDirectory(settings.downloadDir);
  Object.entries(settingsFields).forEach(([key, id]) => {
    const input = $(`#${id}`);
    const value = settings[key];
    if (input.type === 'checkbox') input.checked = value === true;
    else if (value !== undefined) {
      input.value = key === 'videoQuality' && value === 'bv' ? 'bv*' : String(value);
      input.customControl?.sync();
    }
  });
  contentModeInputs.forEach(input => { input.checked = settings.contentModes.includes(input.value); });
  syncDerivedUi();
}
async function restoreQueue() {
  try {
    await withTaskUpdates(() => window.bili.listQueue(), (queued, updates) => {
      queued.forEach(task => acceptTask(task, updates));
    });
  } catch (error) { toast(`恢复下载队列失败：${error.message}`); }
}
refreshAccountStatus().catch(error => { applyProfile(null); toast(`账号状态刷新失败：${error.message}`); }); window.bili.getSettings().then(applySettings).catch(error => toast(`读取设置失败：${error.message}`)); loadHistory(); restoreQueue();
