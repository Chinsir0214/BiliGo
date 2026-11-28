import { errorMessage, fileSize, modeLabel } from '../format.mjs';

const visibleFields = ['id', 'completedAt', 'status', 'title', 'mode', 'file', 'outputDir', 'sizeBytes', 'fileCount', 'error', 'url'];

export function sameHistoryRecord(a, b) {
  return visibleFields.every(key => a[key] === b[key]) && Boolean(a.retryTask) === Boolean(b.retryTask);
}

export function mergeHistoryRecords(snapshot, recent) {
  return [...recent.values()].reverse().concat(snapshot.filter(record => !recent.has(String(record.id))));
}

export function historyCard(document, item, isPlayableMediaPath) {
  function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }
  function action(key, value, label) {
    const button = element('button', 'icon-button');
    button.type = 'button';
    button.dataset[key] = value || '';
    const span = element('span', '', label);
    span.dataset.label = '';
    button.append(span);
    return button;
  }

  const node = element('div', 'history-card');
  node.dataset.recordId = String(item.id);
  node.dataset.completedAt = item.completedAt || '';
  const label = element('label', 'history-check');
  const input = element('input');
  input.type = 'checkbox';
  input.dataset.historyId = String(item.id);
  input.setAttribute('aria-label', `选择任务：${item.title || item.id}`);
  label.append(input);

  const main = element('div', 'history-card-main');
  const size = item.sizeBytes ? ` · ${fileSize(item.sizeBytes)}` : '';
  const count = Math.max(0, Number(item.fileCount) || 0);
  const status = item.status === 'completed' ? '完成' : item.status === 'cancelled' ? '已取消' : `失败${item.error ? `：${item.error}` : ''}`;
  main.append(element('strong', '', item.title || ''), element('span', '',
    `${modeLabel(item.mode)} · ${status} · ${count} 个文件${size} · ${new Date(item.completedAt).toLocaleString()}`));

  const actions = element('div', 'history-actions');
  if (item.status === 'failed' && item.retryTask) actions.append(action('retryTask', item.id, '重试'));
  if (isPlayableMediaPath(item.file)) actions.append(action('openFile', item.file, '打开文件'));
  actions.append(action('copyLink', item.url, '复制链接'));
  if (item.outputDir) actions.append(action('openFolder', item.outputDir, '打开文件夹'));
  node.append(label, main, actions);
  return node;
}

export function createHistory(ctx) {
  const { $, api, document, modal, options, toast } = ctx;
  const list = $('#historyList');
  const empty = list.querySelector('.empty-state');
  const dialog = $('#confirmClearHistoryModal');
  const cards = new Map();
  const retrying = new Set();
  let recentRead;
  let mutating = false;

  function syncHistoryActions() {
    const disabled = mutating || !cards.size;
    for (const id of ['selectHistoryBtn', 'deleteHistoryBtn', 'clearBtn']) $(`#${id}`).disabled = disabled;
    $('#historyView').classList.toggle('is-empty', !cards.size);
  }

  function selectCard(card, selected) {
    card.querySelector('[data-history-id]').checked = selected;
    card.classList.toggle('is-selected', selected);
  }

  function showRetryState(button, busy) {
    if (!button) return;
    button.disabled = busy;
    button.querySelector('[data-label]').textContent = busy ? '重试中' : '重试';
  }

  function getCard(record) {
    const id = String(record.id);
    const existing = cards.get(id);
    if (existing && sameHistoryRecord(existing.record, record)) return existing.node;
    const node = historyCard(document, record, options.isPlayableMediaPath);
    if (existing) {
      selectCard(node, existing.node.querySelector('[data-history-id]').checked);
      existing.node.replaceWith(node);
    }
    if (retrying.has(id)) showRetryState(node.querySelector('[data-retry-task]'), true);
    cards.set(id, { node, record });
    return node;
  }

  function displayRecords(records) {
    const ids = new Set(records.map(record => String(record.id)));
    for (const [id, card] of cards) {
      if (!ids.has(id)) {
        card.node.remove();
        cards.delete(id);
      }
    }
    if (!records.length) {
      if (!list.contains(empty)) list.replaceChildren(empty);
    } else {
      empty.remove();
      records.forEach((record, index) => {
        const card = getCard(record);
        const current = list.children[index];
        if (card !== current) list.insertBefore(card, current || null);
      });
    }
    syncHistoryActions();
  }

  function upsertRecord(record) {
    const id = String(record.id);
    recentRead?.set(id, record);
    const previous = cards.get(id)?.node;
    const card = getCard(record);
    if (card === previous) return false;
    empty.remove();
    list.prepend(card);
    syncHistoryActions();
    return true;
  }

  async function loadHistory() {
    const recent = new Map();
    recentRead = recent;
    try {
      const items = await api.history();
      if (recentRead === recent) displayRecords(mergeHistoryRecords(items, recent));
      return true;
    } catch (error) {
      if (recentRead === recent) toast(`读取任务记录失败：${errorMessage(error)}`);
      return false;
    } finally {
      if (recentRead === recent) recentRead = undefined;
    }
  }

  function selectAll() {
    const boxes = [...list.querySelectorAll('[data-history-id]')];
    const selected = !boxes.every(box => box.checked);
    for (const box of boxes) selectCard(box.closest('.history-card'), selected);
  }

  async function retry(button, id) {
    if (retrying.has(id)) return;
    retrying.add(id);
    showRetryState(button, true);
    try {
      const active = await ctx.tasks.withTaskUpdates(async updates => {
        const task = await api.retryDownload(id);
        return ctx.tasks.acceptTask(task, updates);
      });
      if (active) toast('已重新加入下载队列');
    } catch (error) {
      toast(`重试失败：${errorMessage(error)}`);
    } finally {
      retrying.delete(id);
      showRetryState(button, false);
      const current = cards.get(id)?.node.querySelector('[data-retry-task]');
      if (current !== button) showRetryState(current, false);
    }
  }

  async function onClick(event) {
    const button = event.target.closest('button');
    if (!button || button.disabled || !list.contains(button)) return;
    const { retryTask, openFile, openFolder, copyLink } = button.dataset;
    if (retryTask !== undefined) return retry(button, retryTask);
    if (openFile !== undefined) {
      if (!openFile) return toast('没有可打开的文件');
      try { await api.playLocalVideo(openFile); }
      catch (error) { toast(`打开文件失败：${errorMessage(error)}`); }
    } else if (openFolder !== undefined) {
      try { await api.openFolder(openFolder); }
      catch (error) { toast(`打开文件夹失败：${errorMessage(error)}`); }
    } else if (copyLink !== undefined) {
      try { await api.copyLink(copyLink); toast('链接已复制'); }
      catch (error) { toast(`复制链接失败：${errorMessage(error)}`); }
    }
  }

  function closeClearDialog() {
    if (!mutating) modal.close(dialog);
  }

  async function clearHistory() {
    if (mutating) return;
    mutating = true;
    const buttons = dialog.querySelectorAll('button');
    buttons.forEach(button => { button.disabled = true; });
    syncHistoryActions();
    try {
      await api.clearHistory();
      displayRecords([]);
      modal.close(dialog);
      toast('任务记录已清空');
      await loadHistory();
    } catch (error) {
      toast(`清空任务记录失败：${errorMessage(error)}`);
    } finally {
      mutating = false;
      buttons.forEach(button => { button.disabled = false; });
      syncHistoryActions();
      if (modal.isOpen(dialog)) $('#confirmClearHistory').focus();
    }
  }

  async function deleteSelected() {
    if (mutating) return;
    const ids = [...list.querySelectorAll('[data-history-id]:checked')].map(box => box.dataset.historyId);
    if (!ids.length) return toast('请先选择任务');
    mutating = true;
    syncHistoryActions();
    try {
      await api.removeHistory(ids);
      if (await loadHistory()) toast('已删除选中的任务');
    } catch (error) {
      toast(`删除任务记录失败：${errorMessage(error)}`);
    } finally {
      mutating = false;
      syncHistoryActions();
    }
  }

  function bind() {
    list.addEventListener('click', onClick);
    list.addEventListener('change', event => {
      const box = event.target;
      if (box.matches('[data-history-id]')) box.closest('.history-card').classList.toggle('is-selected', box.checked);
    });
    $('#selectHistoryBtn').addEventListener('click', selectAll);
    $('#deleteHistoryBtn').addEventListener('click', deleteSelected);
    $('#clearBtn').addEventListener('click', event => {
      if (!mutating && !modal.isOpen(dialog)) modal.open(dialog, event.currentTarget, $('#cancelClearHistory'), closeClearDialog);
    });
    $('#cancelClearHistory').addEventListener('click', closeClearDialog);
    $('#closeClearHistory').addEventListener('click', closeClearDialog);
    $('#confirmClearHistory').addEventListener('click', clearHistory);
    syncHistoryActions();
  }

  return { bind, loadHistory, syncHistoryActions, upsertRecord, clearHistory, deleteSelected };
}
