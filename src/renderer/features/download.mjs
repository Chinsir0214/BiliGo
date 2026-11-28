import { duration, errorMessage, imageUrl } from '../format.mjs';

export const downloadSettingFields = {
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

export function createDownload(ctx) {
  const { $, api, document, options, selects, toast } = ctx;
  const modeInputs = [...document.querySelectorAll('.content-modes .content-check input')];
  const controls = Object.fromEntries(Object.entries(downloadSettingFields).map(([key, id]) => [key, $(`#${id}`)]));
  const panel = $('#selectionPanel');
  const list = $('#selectionList');
  const cover = $('#selectionCover');
  const notice = $('#selectionNotice');
  const parseButton = $('#parseBtn');
  const submitButton = $('#downloadBtn');
  const selectAllButton = $('#selectAllBtn');
  const thumbnails = $('#showThumbnails');
  let resource;
  let sourceUrl;
  let parsing = false;
  let submitting = false;
  const submitted = new Set();

  function selectedContentModes() {
    return modeInputs.filter(input => input.checked).map(input => input.value);
  }

  function setDisabled(input, disabled) {
    input.disabled = disabled;
    input.customControl?.setDisabled(disabled);
    input.closest('label').classList.toggle('is-disabled', disabled);
  }

  function syncDerivedUi() {
    const modes = selectedContentModes();
    const { hasVideo, hasMedia, mediaMode } = options.getMediaCapabilities(modes);
    setDisabled(controls.embedSubs, !hasVideo);
    setDisabled(controls.audioFormat, mediaMode !== 'audio');
    setDisabled(controls.containerFormat, mediaMode !== 'video-audio');
    for (const input of [controls.embedThumbnail, controls.embedMetadata, controls.embedChapters]) {
      setDisabled(input, !hasMedia);
    }
    for (const input of document.querySelectorAll('.content-check input')) {
      input.closest('label').classList.toggle('is-checked', input.checked);
    }
    selects.subtitlePicker.setVisible(modes.includes('subtitle') || (hasVideo && controls.embedSubs.checked));
    panel.classList.toggle('show-covers', thumbnails.checked);
    if (!thumbnails.checked) {
      cover.hidden = true;
      for (const image of panel.querySelectorAll('img[src]')) image.removeAttribute('src');
    }
  }

  function changeMode(event) {
    const input = event.currentTarget;
    if (input.checked && options.MEDIA_MODES.includes(input.value)) {
      for (const other of modeInputs) {
        if (input !== other && options.MEDIA_MODES.includes(other.value)) other.checked = false;
      }
    }
    const contentModes = selectedContentModes();
    if (!contentModes.length) {
      input.checked = true;
      syncDerivedUi();
      return toast('至少选择一种下载内容');
    }
    const changes = { contentModes };
    if (!options.getMediaCapabilities(contentModes).hasVideo && controls.embedSubs.checked) {
      controls.embedSubs.checked = false;
      changes.embedSubs = false;
    }
    syncDerivedUi();
    ctx.settings.saveSetting(changes);
  }

  function prepareThumbnail(image, source) {
    const url = imageUrl(source);
    image.removeAttribute('src');
    if (url) image.dataset.src = url;
    else delete image.dataset.src;
    image.classList.toggle('image-unavailable', !url);
    image.loading = 'lazy';
    image.decoding = 'async';
  }

  function hydrateThumbnails() {
    if (!thumbnails.checked) return;
    cover.hidden = !cover.dataset.src || cover.classList.contains('image-unavailable');
    for (const image of panel.querySelectorAll('img[data-src]:not([src]):not(.image-unavailable)')) {
      image.src = image.dataset.src;
    }
  }

  function isUnavailable(item) {
    return item.unavailable === true || (resource.type === 'favorite' && !item.url);
  }

  function selectionRow(item, index) {
    const row = document.createElement('label');
    row.className = 'selection-item';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.index = String(index);
    input.disabled = isUnavailable(item);
    input.checked = !input.disabled;
    const image = document.createElement('img');
    image.className = 'selection-item-cover';
    image.alt = '';
    prepareThumbnail(image, item.thumbnail || resource.thumbnail);
    const title = document.createElement('span');
    title.className = 'selection-item-title';
    title.textContent = item.title || '';
    if (input.disabled) {
      row.classList.add('unavailable');
      const status = document.createElement('em');
      status.textContent = '已失效';
      title.append(' ', status);
    }
    const time = document.createElement('span');
    time.className = 'selection-item-duration';
    time.textContent = duration(item.duration);
    row.append(input, image, title, time);
    return row;
  }

  function setSelectionVisible(visible) {
    panel.classList.toggle('hidden', !visible);
    $('.main-content').classList.toggle('has-selection', visible);
  }

  function syncSubmit() {
    if (submitting) return;
    submitButton.disabled = parsing || !resource || !list.querySelector('input:checked:not(:disabled)');
    submitButton.querySelector('[data-label]').textContent = submitted.size ? '继续下载已选内容' : '下载已选内容';
  }

  function renderSelection(parsed, url) {
    resource = parsed;
    sourceUrl = url;
    submitted.clear();
    notice.textContent = '';
    notice.classList.add('hidden');
    const subtitles = new Map();
    const rows = document.createDocumentFragment();
    let unavailable = 0;
    for (const [index, item] of resource.items.entries()) {
      for (const language of item.subtitleLanguages || []) subtitles.set(language.value, language);
      if (isUnavailable(item)) unavailable++;
      rows.append(selectionRow(item, index));
    }
    selects.subtitlePicker.refresh([...subtitles.values()]);
    const loaded = resource.items.length;
    const total = Number(resource.total);
    const count = Number.isFinite(total) && total > 0 && total !== loaded
      ? `已加载 ${loaded} 项（平台标称 ${total} 项）` : `共 ${loaded} 项`;
    $('#selectionTitle').textContent = resource.title;
    $('#selectionSummary').textContent = `${count} · 可用 ${loaded - unavailable} 项 · 已失效 ${unavailable} 项`;
    list.replaceChildren(rows);
    prepareThumbnail(cover, resource.thumbnail);
    cover.hidden = true;
    setSelectionVisible(true);
    hydrateThumbnails();
  }

  async function parse(event) {
    event.preventDefault();
    if (parsing || submitting) return;
    const url = $('#urlInput').value.trim();
    if (!url) return toast('请先粘贴 Bilibili 链接');
    if (!options.isAllowedBilibiliInputUrl(url)) return toast('请输入有效的视频链接');
    parsing = true;
    parseButton.disabled = submitButton.disabled = true;
    const label = parseButton.querySelector('[data-label]');
    label.textContent = '正在加载全部内容…';
    try {
      renderSelection(await api.parseResource(url), url);
      toast('解析完成，请选择要下载的内容');
    } catch (error) {
      toast(errorMessage(error));
    } finally {
      parsing = false;
      parseButton.disabled = false;
      label.textContent = '解析内容';
      syncSubmit();
    }
  }

  async function enqueue(entries) {
    const [form, { enqueueBatchItems, enqueueSelectedItems }] = await Promise.all([
      import('../../download/form.mjs'), import('../../download/submit.mjs')
    ]);
    const values = form.readDownloadForm({
      sourceUrl, selectedItems: entries.map(entry => entry.item), resource,
      modes: selectedContentModes(), controls, subtitleValues: selects.subtitlePicker.values()
    });
    values.videoQuality = options.normalizeVideoQuality(values.videoQuality);
    const invalid = form.validateDownloadForm(values);
    if (invalid) {
      toast(invalid);
      return;
    }
    const makeRequest = entry => form.buildDownloadRequest(values, entry.item);
    // Keep early progress and completion events until their task IDs arrive.
    return ctx.tasks.withTaskUpdates(updates => {
      function onQueued(entry, task) {
        submitted.add(entry.index);
        entry.input.checked = false;
        const row = entry.input.closest('.selection-item');
        row.classList.add('queued');
        const status = document.createElement('em');
        status.textContent = '已入队';
        row.querySelector('.selection-item-title').append(' ', status);
        ctx.tasks.acceptTask({
          ...task, title: task.title || entry.item.title, url: task.url || entry.item.url || sourceUrl,
          mode: task.mode || values.modes.join(',')
        }, updates);
      }
      if (typeof api.startDownloads === 'function') {
        return enqueueBatchItems(entries, makeRequest, requests => api.startDownloads(requests), onQueued);
      }
      return enqueueSelectedItems(entries, makeRequest, request => api.startDownload(request), onQueued);
    });
  }

  async function submit() {
    if (submitting) return;
    if (parsing) return toast('请等待解析完成');
    if (!resource) return toast('请先解析链接');
    const inputs = [...list.querySelectorAll('input:not(:disabled)')];
    const entries = inputs.filter(input => input.checked).map(input => {
      const index = Number(input.dataset.index);
      return { input, index, item: resource.items[index] };
    }).filter(entry => entry.item && !isUnavailable(entry.item) && !submitted.has(entry.index));

    submitting = true;
    submitButton.disabled = parseButton.disabled = selectAllButton.disabled = true;
    submitButton.setAttribute('aria-busy', 'true');
    submitButton.querySelector('[data-label]').textContent = '正在加入队列…';
    for (const input of inputs) input.disabled = true;
    try {
      const outcome = await enqueue(entries);
      if (!outcome) return;
      if (outcome.remaining) {
        const message = `已入队 ${outcome.queued} 项；剩余 ${outcome.remaining} 项未提交。${errorMessage(outcome.error)}。可继续下载已选内容`;
        notice.textContent = message;
        notice.classList.remove('hidden');
        toast(message);
        return;
      }
      toast(`已将 ${outcome.queued} 个视频分别加入下载队列`);
      setSelectionVisible(false);
      resource = null;
      $('#urlInput').value = '';
    } catch (error) {
      toast('加入队列失败：' + errorMessage(error));
    } finally {
      for (const input of inputs) input.disabled = submitted.has(Number(input.dataset.index));
      submitting = false;
      parseButton.disabled = selectAllButton.disabled = false;
      submitButton.removeAttribute('aria-busy');
      syncSubmit();
    }
  }

  function bind() {
    for (const input of modeInputs) input.addEventListener('change', changeMode);
    $('#parseForm').addEventListener('submit', parse);
    submitButton.addEventListener('click', submit);
    selectAllButton.addEventListener('click', () => {
      const inputs = [...list.querySelectorAll('input:not(:disabled)')];
      const allChecked = inputs.every(input => input.checked);
      for (const input of inputs) input.checked = !allChecked;
      syncSubmit();
    });
    list.addEventListener('change', syncSubmit);
    list.addEventListener('error', event => {
      if (event.target.matches('img.selection-item-cover[src]')) event.target.classList.add('image-unavailable');
    }, true);
    cover.addEventListener('error', () => {
      if (!cover.hasAttribute('src')) return;
      cover.classList.add('image-unavailable');
      cover.hidden = true;
    });
    syncDerivedUi();
    syncSubmit();
  }

  return { bind, hydrateThumbnails, syncDerivedUi, selectedContentModes };
}
