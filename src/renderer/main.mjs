import { createAuth } from './features/auth.mjs';
import { createDownload } from './features/download.mjs';
import { createHistory } from './features/history.mjs';
import { createSettings } from './features/settings.mjs';
import { createTasks } from './features/tasks.mjs';
import { createUpdater } from './features/updater.mjs';
import { createSubscriptions } from './ipc.mjs';
import { createNavigation } from './navigation.mjs';
import { createState } from './state.mjs';
import { createSelects } from './ui/custom-select.mjs';
import { createModal } from './ui/modal.mjs';
import { createToast } from './ui/toast.mjs';

const $ = selector => document.querySelector(selector);
const $$ = selector => document.querySelectorAll(selector);
const api = globalThis.bili;
const subscriptions = createSubscriptions(api);
const ctx = {
  $, $$, api, document, window, on: subscriptions.on,
  state: createState(),
  options: globalThis.BiliGoDownloadOptions,
  toast: createToast($('#toast')),
  modal: createModal({ $, document }),
  selects: createSelects({ $, document })
};
ctx.navigation = createNavigation(ctx);
ctx.tasks = createTasks(ctx);
ctx.history = createHistory(ctx);
ctx.download = createDownload(ctx);
ctx.auth = createAuth(ctx);
ctx.settings = createSettings(ctx);
ctx.updater = createUpdater(ctx);

for (const icon of $$('[data-icon]')) {
  if (icon instanceof HTMLElement) {
    const source = new URL(`../assets/fluent/${icon.dataset.icon}.svg`, import.meta.url);
    icon.style.setProperty('--icon-image', `url("${source.href}")`);
  }
}

ctx.modal.bind();
ctx.selects.bind();
ctx.tasks.bind();
ctx.history.bind();
ctx.download.bind();
ctx.auth.bind();
ctx.settings.bind();
ctx.updater.bind();
ctx.navigation.bind();
ctx.on('app:error', ctx.toast);
window.addEventListener('pagehide', subscriptions.dispose, { once: true });

ctx.tasks.restoreQueue();
ctx.updater.init();
ctx.settings.init();
ctx.auth.init();
