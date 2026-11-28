import { errorMessage } from '../format.mjs';
import { downloadSettingFields } from './download.mjs';

const settingsFields = { ...downloadSettingFields, maxConcurrentTasks: 'maxConcurrentTasks', showThumbnails: 'showThumbnails' };

export function createSettings(ctx) {
  const { $, api, document, modal, options, toast } = ctx;
  const dialog = $('#resetSettingsModal');
  const modes = [...document.querySelectorAll('.content-modes .content-check input')];
  const fields = Object.entries(settingsFields).map(([key, id]) => [key, $(`#${id}`)]);
  const thumbnails = $('#showThumbnails');
  const editing = new Set();
  let queue = Promise.resolve();
  let editVersion = 0;
  let resetting = false;

  function enqueue(operation) {
    const result = queue.then(operation);
    queue = result.then(() => {}, () => {});
    return result;
  }

  function showDownloadDirectory(dir) {
    $('#downloadDirText').textContent = dir;
    const destination = $('#destination');
    destination.textContent = `保存至 ${dir}`;
    destination.title = destination.textContent;
  }

  function applySettings(settings) {
    const coversWereVisible = thumbnails.checked;
    showDownloadDirectory(settings.downloadDir);
    for (const [key, input] of fields) {
      const value = settings[key];
      if (input.type === 'checkbox') input.checked = value === true;
      else if (value !== undefined && !editing.has(input)) {
        input.value = String(key === 'videoQuality' ? options.normalizeVideoQuality(value) : value);
        input.customControl?.sync();
      }
    }
    for (const input of modes) input.checked = settings.contentModes.includes(input.value);
    ctx.download.syncDerivedUi();
    if (thumbnails.checked && !coversWereVisible) ctx.download.hydrateThumbnails?.();
  }

  function saveSetting(changes) {
    const version = ++editVersion;
    return enqueue(async () => {
      try {
        const settings = await api.setSettings(changes);
        // A later edit is already visible. Its response will include both writes.
        if (version === editVersion) applySettings(settings);
      } catch (error) {
        toast(`设置保存失败：${errorMessage(error)}`);
        if (version !== editVersion) return;
        try {
          const settings = await api.getSettings();
          if (version === editVersion) applySettings(settings);
        } catch (refreshError) {
          toast(`重新读取设置失败：${errorMessage(refreshError)}`);
        }
      }
    });
  }

  function closeResetSettings() {
    if (!resetting) modal.close(dialog);
  }

  async function resetSettings(event) {
    if (resetting || !modal.isOpen(dialog)) return;
    resetting = true;
    const button = event.currentTarget;
    const actions = dialog.querySelectorAll('button');
    dialog.setAttribute('aria-busy', 'true');
    actions.forEach(action => { action.disabled = true; });
    dialog.focus();
    try {
      await enqueue(async () => applySettings(await api.resetSettings()));
      toast('已恢复默认设置');
      modal.close(dialog);
    } catch (error) {
      toast(`恢复设置失败：${errorMessage(error)}`);
    } finally {
      resetting = false;
      dialog.removeAttribute('aria-busy');
      actions.forEach(action => { action.disabled = false; });
      if (modal.isOpen(dialog)) button.focus();
    }
  }

  async function chooseFolder(event) {
    const button = event.currentTarget;
    if (button.disabled) return;
    button.disabled = true;
    try {
      await enqueue(async () => {
        const dir = await api.chooseDownloadDir();
        if (dir) {
          showDownloadDirectory(dir);
          toast('下载目录已更新');
        }
      });
    } catch (error) {
      toast(`选择下载目录失败：${errorMessage(error)}`);
    } finally {
      button.disabled = false;
    }
  }

  function bind() {
    for (const [key, input] of fields) {
      // A response for another field must preserve an unfinished text edit.
      if (input.type === 'text') {
        input.addEventListener('input', () => editing.add(input));
        input.addEventListener('blur', () => editing.delete(input));
      }
      input.addEventListener('change', () => {
        editing.delete(input);
        ctx.download.syncDerivedUi();
        if (input === thumbnails && thumbnails.checked) ctx.download.hydrateThumbnails?.();
        saveSetting({ [key]: input.type === 'checkbox' ? input.checked : input.value });
      });
    }
    $('#resetSettingsBtn').addEventListener('click', event => {
      if (!resetting && !modal.isOpen(dialog)) modal.open(dialog, event.currentTarget, $('#cancelResetSettings'), closeResetSettings);
    });
    $('#cancelResetSettings').addEventListener('click', closeResetSettings);
    $('#closeResetSettings').addEventListener('click', closeResetSettings);
    $('#confirmResetSettings').addEventListener('click', resetSettings);
    $('#chooseFolderBtn').addEventListener('click', chooseFolder);
    $('#openFolderBtn').addEventListener('click', async () => {
      try { await api.openFolder(); }
      catch (error) { toast(`打开文件夹失败：${errorMessage(error)}`); }
    });
  }

  function init() {
    const version = editVersion;
    return enqueue(async () => {
      try {
        const settings = await api.getSettings();
        if (version === editVersion) applySettings(settings);
      } catch (error) {
        toast(`读取设置失败：${errorMessage(error)}`);
      }
    });
  }

  return { bind, init, saveSetting };
}
