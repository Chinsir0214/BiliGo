import { errorMessage, modeLabel } from '../format.mjs';

export function renderTaskProgress(parts, data) {
  if (Number.isFinite(data.percent)) {
    const percent = Math.min(100, Math.max(0, data.percent));
    parts.track.value = percent;
    parts.percent.textContent = `${percent.toFixed(1)}%`;
  } else {
    parts.track.removeAttribute('value');
    parts.percent.textContent = '—';
  }
  parts.info.textContent = [data.speed, data.eta && `剩余 ${data.eta}`].filter(Boolean).join('  ·  ') || '正在读取视频流';
  parts.status.textContent = '下载中';
}

export function waitForWindowLoad(document, window) {
  if (document.readyState === 'complete') return Promise.resolve();
  return new Promise(resolve => window.addEventListener('load', () => resolve(undefined), { once: true }));
}

export function createTasks(ctx) {
  const { $, api, document, window, state, toast } = ctx;
  const list = $('#taskList');
  const empty = list.querySelector('.empty-state');
  const tasks = new Map();
  const pendingProgress = new Map();
  const requests = new Set();
  const finished = Symbol('finished');
  let progressFrame;

  // IPC can deliver progress and terminal events before a snapshot or a new task ID arrives.
  async function withTaskUpdates(request) {
    const updates = new Map();
    requests.add(updates);
    try { return await request(updates); }
    finally { requests.delete(updates); }
  }

  function acceptTask(task, updates, { prepend = true } = {}) {
    if (!task?.id) throw new Error('下载队列未返回任务编号');
    const update = updates.get(task.id);
    if (update === finished) return false;
    if (tasks.has(task.id)) return true;

    const node = document.createElement('div');
    node.className = 'task';
    node.dataset.task = task.id;
    const downloading = task.status === 'downloading';
    node.innerHTML = `<div class="task-main">
      <div class="task-title"></div>
      <div class="task-meta"></div>
      <progress class="progress-track" max="100"${downloading ? '' : ' value="0"'}></progress>
    </div>
    <div class="task-side">
      <div class="task-percent">${downloading ? '—' : '0%'}</div>
      <div class="task-info">正在准备</div>
      <div class="task-status">${downloading ? '下载中' : '队列中'}</div>
      <div class="task-actions">
        <button type="button" class="icon-button" data-cancel-task><span data-label>取消任务</span></button>
        <button type="button" class="icon-button" data-open-video>打开视频</button>
        <button type="button" class="icon-button" data-open-folder>打开文件夹</button>
      </div>
    </div>`;
    const parts = {
      node, track: node.querySelector('.progress-track'), percent: node.querySelector('.task-percent'),
      info: node.querySelector('.task-info'), status: node.querySelector('.task-status')
    };
    const title = task.title || '';
    node.querySelector('.task-title').textContent = title;
    node.querySelector('.task-meta').textContent = modeLabel(task.mode);
    parts.track.setAttribute('aria-label', `下载进度：${title}`);
    node.querySelector('[data-cancel-task]').dataset.cancelTask = task.id;
    node.querySelector('[data-open-video]').dataset.openVideo = task.url || '';
    node.querySelector('[data-open-folder]').dataset.openFolder = task.outputDir || '';
    empty.remove();
    if (prepend) list.prepend(node);
    else list.append(node);
    tasks.set(task.id, parts);
    if (update) renderTaskProgress(parts, update);
    return true;
  }

  function scheduleProgress() {
    if (state.activeView !== 'download' || progressFrame !== undefined || !pendingProgress.size) return;
    progressFrame = window.requestAnimationFrame(() => {
      progressFrame = undefined;
      if (state.activeView !== 'download') return;
      for (const [id, data] of pendingProgress) renderTaskProgress(tasks.get(id), data);
      pendingProgress.clear();
    });
  }

  function updateTask(data) {
    if (tasks.has(data.id)) {
      pendingProgress.set(data.id, data);
      scheduleProgress();
    } else {
      for (const updates of requests) {
        if (updates.get(data.id) !== finished) updates.set(data.id, data);
      }
    }
  }

  function finishTask(data) {
    let duplicate = false;
    for (const updates of requests) {
      if (updates.get(data.id) === finished) duplicate = true;
      updates.set(data.id, finished);
    }
    const parts = tasks.get(data.id);
    if (parts) {
      pendingProgress.delete(data.id);
      tasks.delete(data.id);
      parts.node.remove();
      if (!tasks.size) list.replaceChildren(empty);
    }
    if (data.record) duplicate = !ctx.history.upsertRecord(data.record);
    if (duplicate && !parts) return;
    toast(data.code === 0 ? '下载完成，已移入任务记录' : data.code === 2 ? '任务已取消' : '下载失败，详情已记录');
  }

  async function restoreQueue(readQueue = () => api.listQueue()) {
    try {
      await withTaskUpdates(async updates => {
        await waitForWindowLoad(document, window);
        const queued = await readQueue();
        for (const task of queued) acceptTask(task, updates, { prepend: false });
      });
    } catch (error) {
      toast(`恢复下载队列失败：${errorMessage(error)}`);
    }
  }

  async function onClick(event) {
    const button = event.target.closest('button');
    if (!button || button.disabled || !list.contains(button)) return;
    const { cancelTask, openVideo, openFolder } = button.dataset;
    if (cancelTask !== undefined) {
      const label = button.querySelector('[data-label]');
      button.disabled = true;
      label.textContent = '取消中';
      try {
        if (await api.cancelDownload(cancelTask)) {
          toast('正在取消任务');
          return;
        }
        toast('任务已结束或不存在');
      } catch (error) {
        toast(`取消任务失败：${errorMessage(error)}`);
      }
      button.disabled = false;
      label.textContent = '取消任务';
    } else if (openVideo !== undefined) {
      try { await api.openVideo(openVideo); }
      catch (error) { toast(`打开视频失败：${errorMessage(error)}`); }
    } else if (openFolder !== undefined) {
      try { await api.openFolder(openFolder); }
      catch (error) { toast(`打开文件夹失败：${errorMessage(error)}`); }
    }
  }

  function bind() {
    list.addEventListener('click', onClick);
    ctx.on('download:progress', updateTask);
    ctx.on('download:done', finishTask);
  }

  return { bind, restoreQueue, scheduleProgress, withTaskUpdates, acceptTask, updateTask, finishTask };
}
