import { errorMessage, imageUrl } from '../format.mjs';

function drawQr(canvas, qr) {
  const size = 164;
  const scale = size / qr.size;
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, size, size);
  context.fillStyle = '#181818';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.data[y * qr.size + x]) {
        context.fillRect(Math.round(x * scale), Math.round(y * scale), Math.ceil(scale), Math.ceil(scale));
      }
    }
  }
}

export function createAuth(ctx) {
  const { $, api, modal, on, toast } = ctx;
  const dialog = $('#loginModal');
  const canvas = $('#qrCanvas');
  const hint = $('#loginHint');
  const refreshQr = $('#refreshQr');
  const closeButton = $('#closeModal');
  const sidebarLogin = $('#loginSmall');
  const settingsLogin = $('#loginBtn');
  const refreshStatus = $('#refreshLoginBtn');
  const avatar = $('#accountAvatar');
  let authVersion = 0;
  let accountBusy = false;
  let session;
  let stopScanListeners = [];

  function setAccountBusy(busy) {
    accountBusy = busy;
    sidebarLogin.disabled = settingsLogin.disabled = refreshStatus.disabled = busy;
  }

  function applyProfile(profile, loggedIn = Boolean(profile)) {
    const url = imageUrl(profile?.avatar);
    avatar.hidden = !url;
    if (url) avatar.src = url;
    else avatar.removeAttribute('src');
    $('#accountText').textContent = profile?.name || (loggedIn ? '已登录' : '未登录');
    sidebarLogin.querySelector('[data-label]').textContent = loggedIn ? '退出' : '登录';
    settingsLogin.querySelector('[data-label]').textContent = loggedIn ? '退出账号' : '扫码登录';
    settingsLogin.classList.toggle('primary-button', !loggedIn);
    settingsLogin.classList.toggle('ghost-button', loggedIn);
    $('#settingLogin').textContent = loggedIn ? `已登录${profile?.name ? `：${profile.name}` : ''}` : '尚未使用扫码登录。';
  }

  function endSession() {
    session = undefined;
    for (const stop of stopScanListeners) stop();
    stopScanListeners = [];
    refreshQr.disabled = false;
  }

  async function closeLogin() {
    if (!modal.isOpen(dialog)) return;
    endSession();
    modal.close(dialog);
    try { await api.cancelLogin(); }
    catch (error) { toast(`取消登录失败：${errorMessage(error)}`); }
  }

  async function beginLogin(trigger) {
    if (refreshQr.disabled || !modal.open(dialog, trigger, closeButton, closeLogin)) return;
    endSession();
    const request = session = Symbol('login');
    const current = () => session === request && modal.isOpen(dialog);
    refreshQr.disabled = true;
    hint.textContent = '二维码生成中…';
    try {
      canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
      const login = await api.startLogin();
      if (!current()) return;
      drawQr(canvas, login.qr);
      hint.textContent = '请使用 Bilibili App 扫一扫';
      // The main process emits scan events only for its active poller. Accept them
      // after the new QR arrives, and retire its listeners on refresh or dismiss.
      stopScanListeners = [
        on('login:scanned', () => {
          if (current()) hint.textContent = '已扫码，请在手机上确认';
        }),
        on('login:expired', () => {
          if (!current()) return;
          hint.textContent = '二维码已过期，请刷新后重试';
          endSession();
        }),
        on('login:error', data => {
          if (!current()) return;
          hint.textContent = data?.message || '登录失败，请刷新二维码重试';
          endSession();
        })
      ];
    } catch (error) {
      if (!current()) return;
      hint.textContent = errorMessage(error);
      toast(`二维码生成失败：${errorMessage(error)}`);
      endSession();
    } finally {
      if (current()) refreshQr.disabled = false;
    }
  }

  async function handleAccount(trigger) {
    if (accountBusy) return;
    setAccountBusy(true);
    const version = ++authVersion;
    let openLogin = false;
    try {
      const status = await api.loginStatus();
      if (version !== authVersion) return;
      applyProfile(status.profile, status.loggedIn);
      if (!trigger) {
        toast(status.profile ? `账号状态正常：${status.profile.name}` :
          status.loggedIn ? '登录凭据存在，但账号资料暂时不可用' : '当前未登录');
      } else if (status.loggedIn) {
        await api.logout();
        if (version !== authVersion) return;
        applyProfile(null);
        toast('已退出登录');
      } else {
        openLogin = true;
      }
    } catch (error) {
      if (version === authVersion) toast((trigger ? '账号操作失败：' : '刷新失败：') + errorMessage(error));
    } finally { setAccountBusy(false); }
    if (openLogin) await beginLogin(trigger);
  }

  function bind() {
    for (const button of [sidebarLogin, settingsLogin]) {
      button.addEventListener('click', () => handleAccount(button));
    }
    avatar.addEventListener('error', () => { avatar.hidden = true; });
    refreshStatus.addEventListener('click', () => handleAccount(undefined));
    refreshQr.addEventListener('click', () => {
      if (modal.isOpen(dialog)) return beginLogin(undefined);
    });
    closeButton.addEventListener('click', closeLogin);
    on('login:success', data => {
      ++authVersion;
      endSession();
      modal.close(dialog);
      applyProfile(data.profile, data.loggedIn !== false);
      if (!accountBusy) setAccountBusy(false);
      toast('登录成功');
    });
  }

  async function init() {
    const version = ++authVersion;
    try {
      const status = await api.loginStatus();
      if (version === authVersion) applyProfile(status.profile, status.loggedIn);
    } catch (error) {
      if (version !== authVersion) return;
      applyProfile(null);
      toast(`账号状态刷新失败：${errorMessage(error)}`);
    } finally {
      if (version === authVersion) setAccountBusy(false);
    }
  }

  return { bind, init };
}
