const pages = {
  download: ['DOWNLOAD CENTER / 01', '下载中心'],
  history: ['DOWNLOAD LOG / 02', '任务记录'],
  settings: ['PREFERENCES / 03', '应用设置']
};

export function createNavigation(ctx) {
  const { $, $$, state } = ctx;
  const container = $('.main-content');
  const links = $$('.nav-item');
  const panels = $$('.view');

  function switchView(view) {
    if (!Object.hasOwn(pages, view)) return;
    const previous = state.activeView;
    if (previous === 'history') state.historyScrollTop = container.scrollTop;
    state.activeView = view;
    container.dataset.view = view;
    for (const link of links) {
      const current = link.dataset.view === view;
      link.classList.toggle('active', current);
      if (current) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    const panel = $(`#${view}View`);
    for (const item of panels) item.classList.toggle('active-view', item === panel);
    const [eyebrow, title] = pages[view];
    $('#pageEyebrow').textContent = eyebrow;
    $('#pageTitle').textContent = title;
    if (view === 'history') {
      ctx.history.syncHistoryActions();
      ctx.history.loadHistory();
    }
    if (view === 'settings') ctx.selects.setup(panel);
    if (view === 'download') ctx.tasks.scheduleProgress();
    container.scrollTop = view === 'history' ? state.historyScrollTop : 0;
  }

  function bind() {
    for (const link of links) link.addEventListener('click', () => switchView(link.dataset.view));
    switchView(state.activeView);
  }

  return { switchView, bind };
}
