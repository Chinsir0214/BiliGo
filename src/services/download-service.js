const fs = require('node:fs');
const path = require('node:path');
const { DOWNLOAD_DEFAULTS } = require('../download/constants');
const { buildDownloadSteps } = require('../download/formats');
const { validateDownloadData } = require('../download/request');
const { createDownloadTask, serializeTaskForQueue } = require('../download/task');
const { createDownloadQueue } = require('../download/queue');
const { createQueueStore } = require('../download/queue-store');
const { collectAllowedLocalRoots } = require('../download/allowed-roots');
const { resolveTaskDestination, safeName } = require('../download/destination');
const { getMediaCapabilities, normalizeContentModes, isPlayableMediaPath } = require('../download/options');
const { createTaskWorkspace, cleanupOrphanedWorkspaces } = require('../download/file-workspace');
const { assertBilibiliUrl, isAllowedLocalPath: pathAllowedInRoots } = require('../security');
const { createLocalDataReader } = require('../local-data');
const { defaults, normalizeSettings, applySettingsChanges } = require('../settings');

function safeTemplate(value) { const template = String(value || DOWNLOAD_DEFAULTS.filenameTemplate).replace(/[\\/]/g, '_').replace(/\.\./g, '_').trim(); return template && !path.isAbsolute(template) ? template : DOWNLOAD_DEFAULTS.filenameTemplate; }
function fileStats(files) { return files.reduce((total, file) => { try { return total + fs.statSync(file).size; } catch (_) { return total; } }, 0); }

function downloadRecord(task, destination, modes, status, startedAt, files, error = '') {
  const record = { id: task.id, title: task.title, url: task.url, outputDir: destination, file: files.find(isPlayableMediaPath) || files[0] || '', files, fileCount: files.length, sizeBytes: fileStats(files), mode: modes.join(','), status, startedAt: new Date(startedAt).toISOString(), completedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, retryTask: serializeTaskForQueue(task) };
  if (error) record.error = error;
  return record;
}

function restoreDownloadRequest(request) {
  // Older tasks could inherit embedSubs from settings even for non-video modes.
  if (request.embedSubs !== true) return request;
  const modes = normalizeContentModes(request.contentModes, request.mode ? [request.mode] : []);
  return getMediaCapabilities(modes).hasVideo ? request : { ...request, embedSubs: false };
}

function createDownloadService({
  dataDir, defaultDownloadDir, log, send, reportAppError, parseResource, downloadDanmaku,
  downloadExecutor, resolveFfmpeg, localData = createLocalDataReader(),
  queueStore = createQueueStore(path.join(dataDir, 'queue.json')), makeWorkspace = createTaskWorkspace
}) {
  let queueLoaded = false;
  let quitting = false;
  let settings;
  let history;
  const publishingTasks = new Set();
  const runningTasks = new Set();
  const historyFile = path.join(dataDir, 'history.json');
  const settingsFile = path.join(dataDir, 'settings.json');

  function getSettings() {
    if (!settings) settings = normalizeSettings(localData.readSettings(settingsFile), defaultDownloadDir);
    return settings;
  }

  function persistSettings(next) {
    localData.writeSettings(settingsFile, next);
    settings = next;
    downloadManager.notifyConcurrencyChange();
    return next;
  }

  function setSettings(changes) {
    return persistSettings(applySettingsChanges(getSettings(), changes, defaultDownloadDir, directory => {
      try { return fs.statSync(directory).isDirectory(); }
      catch { return false; }
    }));
  }

  function readHistory() {
    if (!history) history = localData.readHistory(historyFile);
    return history;
  }

  function writeHistory(items) {
    const next = items.slice(0, 100);
    localData.writeHistory(historyFile, next);
    history = next;
  }

  function saveDownloadRecord(record) {
    try { writeHistory([record, ...readHistory().filter(item => item.id !== record.id)]); }
    catch (error) { log('error', `保存任务记录失败 ${record.id}: ${error.message}`); reportAppError(`任务记录保存失败：${error.message}`); }
  }

  function allowedLocalRoots() {
    let records;
    try { records = readHistory(); }
    catch (error) { log('error', '读取历史下载目录失败', error); records = []; }
    return collectAllowedLocalRoots({
      settingsDownloadDir: getSettings().downloadDir, defaultDownloadDir,
      history: records, tasks: [...downloadManager.activeTasks.values(), ...downloadManager.downloadQueue], safeName
    });
  }

  function isAllowedLocalPath(target) {
    return pathAllowedInRoots(target, allowedLocalRoots());
  }

  function readRestoredTasks() {
    const settings = getSettings();
    const defaultDir = settings.downloadDir || defaultDownloadDir;
    return queueStore.read(item => {
      if (typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(item.id)) throw new Error('任务 ID 无效');
      const data = validateDownloadData(restoreDownloadRequest({ ...item, outputDir: item.outputDir || defaultDir }), {
        assertBilibiliUrl,
        // These paths were selected when the task was queued; the active setting may have changed since then.
        isAllowedLocalPath: target => path.isAbsolute(target)
      });
      const restored = { ...data, filenameTemplate: safeTemplate(data.filenameTemplate) };
      for (const key of ['embedThumbnail', 'embedMetadata', 'embedChapters', 'embedSubs']) restored[key] = data[key] === true;
      const task = createDownloadTask(restored, { title: String(item.title || '未命名资源'), thumbnail: String(item.thumbnail || '') }, settings, item.id);
      task.queuedAt = item.queuedAt || task.queuedAt;
      return task;
    });
  }
  const downloadManager = createDownloadQueue({
    read: readRestoredTasks,
    write: queueStore.write,
    serialize: serializeTaskForQueue,
    processTask(task) {
      const running = runDownloadTask(task);
      runningTasks.add(running);
      return running.finally(() => runningTasks.delete(running));
    },
    maxConcurrency: () => getSettings().maxConcurrentTasks,
    onTaskError: (task, error) => {
      log('error', `任务处理异常 ${task.id}: ${error.message}`);
      reportAppError(`任务处理异常：${task.title || task.id}`);
    },
    onPersistenceError: error => {
      const message = `保存下载队列失败，应用将重试：${error.message}`;
      log('error', message);
      reportAppError(message);
    }
  });
  function ensureQueueLoaded() {
    if (queueLoaded) return;
    downloadManager.load();
    queueLoaded = true;
  }

  async function downloadBatch(items) {
    if (quitting) throw new Error('应用正在退出');
    if (!Array.isArray(items) || !items.length) throw new TypeError('下载任务列表无效');
    ensureQueueLoaded();
    const requests = items.map(item => validateDownloadData(item, { assertBilibiliUrl, isAllowedLocalPath }));
    const settings = getSettings();
    const tasks = [];
    for (const data of requests) {
      const info = data.title ? { title: data.title, thumbnail: data.thumbnail } : await parseResource(data.url);
      if (quitting) throw new Error('应用正在退出');
      tasks.push(createDownloadTask({
        ...data, outputDir: data.outputDir || settings.downloadDir,
        filenameTemplate: safeTemplate(data.filenameTemplate || settings.filenameTemplate)
      }, info, settings));
    }
    const firstPosition = downloadManager.activeTasks.size + downloadManager.downloadQueue.length + 1;
    downloadManager.enqueueMany(tasks);
    return { tasks: tasks.map((task, index) => ({
      ...serializeTaskForQueue(task), mode: task.contentModes.join(','), queued: true, position: firstPosition + index
    })) };
  }

  async function download(request) { return (await downloadBatch([request])).tasks[0]; }

  function throwIfCancelled(task) {
    if (task.cancelled) throw new Error('下载已取消');
  }


  async function runDownloadTask(task) {
    const startedAt = Date.now();
    const destinationRoot = task.outputDir || getSettings().downloadDir;
    const destination = resolveTaskDestination({ ...task, outputDir: destinationRoot }, safeName);
    const downloadUrls = task.urls?.length ? task.urls : [task.url];
    const modes = task.contentModes;
    let workspace;
    log('info', `下载任务开始 ${task.id}: ${task.title}`);
    try {
      workspace = makeWorkspace({ destinationRoot, taskId: task.id, onWarning: error => log('warn', error) });
      const runYtdlp = args => downloadExecutor.run(task, args, downloadUrls);
      const output = path.join(workspace.stageDir, safeTemplate(task.filenameTemplate));

      if (modes.includes('danmaku')) {
        task.danmakuController = new AbortController();
        for (let index = 0; index < downloadUrls.length; index += 1) {
          throwIfCancelled(task);
          await downloadDanmaku(downloadUrls[index], task.itemTitles?.[index] || task.title, workspace.stageDir, task.danmakuController.signal);
        }
      }
      throwIfCancelled(task);
      for (const args of buildDownloadSteps(task, output, resolveFfmpeg)) {
        throwIfCancelled(task);
        await runYtdlp(args);
      }
      throwIfCancelled(task);

      publishingTasks.add(task);
      const files = await workspace.commit(destination);
      task.finalized = true;
      try { downloadManager.save(); } catch (error) { log('error', `保存队列状态失败 ${task.id}: ${error.message}`); }
      const record = downloadRecord(task, destination, modes, 'completed', startedAt, files);
      saveDownloadRecord(record);
      log('info', `下载任务完成 ${task.id}: ${task.title}`);
      send('download:done', { id: task.id, code: 0, record });
    } catch (error) {
      try { workspace?.cleanup(); } catch (cleanupError) { log('error', `清理任务临时目录失败 ${task.id}: ${cleanupError.message}`); }
      if (task.interrupted) return;
      const status = task.cancelled ? 'cancelled' : 'failed';
      const record = downloadRecord(task, destination, modes, status, startedAt, error.committedFiles || [], error.message);
      if (publishingTasks.has(task)) task.finalized = true;
      saveDownloadRecord(record);
      log('error', `下载任务${task.cancelled ? '取消' : '失败'} ${task.id}: ${task.title} - ${error.message}`);
      send('download:done', { id: task.id, code: task.cancelled ? 2 : 1, record });
    } finally {
      task.process = null;
      delete task.danmakuController;
      publishingTasks.delete(task);
    }
  }

  function listQueue() {
    ensureQueueLoaded();
    return [...downloadManager.activeTasks.values(), ...downloadManager.downloadQueue].map(task => ({
      id: task.id, title: task.title, url: task.url, mode: task.contentModes.join(','),
      outputDir: task.outputDir, queuedAt: task.queuedAt,
      status: downloadManager.activeTasks.has(task.id) ? 'downloading' : 'queued'
    }));
  }

  function retry(id) {
    const item = readHistory().find(record => record.id === id);
    if (!item?.retryTask) throw new Error('这条记录没有可重试的下载配置');
    return download(restoreDownloadRequest(item.retryTask));
  }

  async function cancel(id) {
    if (quitting) return false;
    ensureQueueLoaded();
    const task = downloadManager.cancelQueued(id);
    if (task) {
      const destination = resolveTaskDestination(task, safeName);
      const record = downloadRecord(task, destination, task.contentModes, 'cancelled', Date.now(), []);
      saveDownloadRecord(record);
      send('download:done', { id, code: 2, record });
      return true;
    }
    const active = downloadManager.activeTasks.get(id);
    if (!active || active.finalized || publishingTasks.has(active)) return false;
    active.cancelled = true;
    try { downloadManager.save(); } catch (error) { active.cancelled = false; throw error; }
    await downloadExecutor.stop(active);
    return true;
  }

  function resume() {
    if (quitting) return;
    ensureQueueLoaded();
    const roots = new Set([getSettings().downloadDir, ...downloadManager.downloadQueue.map(task => task.outputDir)]);
    for (const root of roots) {
      try { cleanupOrphanedWorkspaces(root, { onWarning: error => log('warn', error) }); }
      catch (error) { log('warn', '清理下载临时目录失败', error); }
    }
    downloadManager.pump();
  }

  async function shutdown() {
    quitting = true;
    if (!queueLoaded) return;
    try {
      await downloadManager.requeueActive(task => {
        task.interrupted = true;
        return downloadExecutor.stop(task);
      }, task => publishingTasks.has(task));
    } finally {
      await Promise.allSettled([...runningTasks]);
      downloadManager.save();
    }
  }

  return { getSettings, setSettings, resetSettings: () => persistSettings(defaults(defaultDownloadDir)),
    readHistory, writeHistory, isAllowedLocalPath, download, downloadBatch, retry, cancel, listQueue, resume, shutdown };
}

module.exports = { createDownloadService, restoreDownloadRequest, downloadRecord };
