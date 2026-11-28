import { errorMessage } from '../format.mjs';

export function createUpdater({ $, api, window, toast }) {
  const button = $('#checkUpdateBtn');
  const label = button.querySelector('[data-label]');
  const status = $('#updateStatus');
  let checkRequested = false;

  async function checkUpdates(showToast) {
    if (button.disabled) return;
    checkRequested = true;
    button.disabled = true;
    label.textContent = '检查中';
    delete button.dataset.updateUrl;
    try {
      const result = await api.checkForUpdates();
      if (result.hasUpdate) {
        status.textContent = `发现新版本 ${result.latestVersion}（当前 ${result.currentVersion}）`;
        label.textContent = '查看更新';
        button.dataset.updateUrl = result.pageUrl;
        if (showToast) toast(`发现新版本 ${result.latestVersion}`);
      } else {
        status.textContent = `当前已是最新版本 ${result.currentVersion}`;
        label.textContent = '重新检查';
        if (showToast) toast('当前已是最新版本');
      }
    } catch (error) {
      status.textContent = '更新检查失败，请稍后重试。';
      label.textContent = '重新检查';
      if (showToast) toast(`更新检查失败：${errorMessage(error)}`);
    } finally { button.disabled = false; }
  }

  function scheduleAutomaticCheck() {
    let observer;
    const run = () => {
      observer?.disconnect();
      if (!checkRequested) checkUpdates(false);
    };
    // A minimized window may never report a contentful paint.
    const fallback = window.setTimeout(run, 10000);
    if (!window.PerformanceObserver?.supportedEntryTypes.includes('paint')) return;
    observer = new window.PerformanceObserver(entries => {
      if (!entries.getEntriesByName('first-contentful-paint').length) return;
      observer.disconnect();
      window.clearTimeout(fallback);
      if (window.requestIdleCallback) window.requestIdleCallback(run, { timeout: 2000 });
      else window.setTimeout(run, 0);
    });
    observer.observe({ type: 'paint', buffered: true });
  }

  function bind() {
    button.addEventListener('click', async () => {
      const url = button.dataset.updateUrl;
      if (!url) return checkUpdates(true);
      try { await api.openVideo(url); }
      catch (error) { toast(`打开更新页面失败：${errorMessage(error)}`); }
    });
  }

  async function init() {
    scheduleAutomaticCheck();
    try {
      const version = await api.appVersion();
      $('#appVersion [data-label]').textContent = `BiliGo ${version}`;
    } catch { /* The static product name remains available offline. */ }
  }

  return { bind, init };
}
