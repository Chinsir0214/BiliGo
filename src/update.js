const { assertExternalUrl: validateExternalUrl } = require('./security');

const UPDATE_REPOSITORY = 'https://github.com/Chinsir0214/BiliGo';
const UPDATE_API = 'https://api.github.com/repos/Chinsir0214/BiliGo';

function versionParts(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/i.exec(String(value).trim());
  if (!match) return null;
  const pre = match[4]?.split('.') || [];
  if (pre.some(part => /^0\d+$/.test(part))) return null;
  return { core: match.slice(1, 4).map(BigInt), pre };
}

function isNewerVersion(latest, current) {
  const a = versionParts(latest);
  const b = versionParts(current);
  if (!a || !b) return false;
  for (let i = 0; i < a.core.length; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i];
  }
  if (!a.pre.length || !b.pre.length) return !a.pre.length && b.pre.length > 0;
  for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
    const left = a.pre[i], right = b.pre[i];
    if (left === right) continue;
    const leftNumeric = /^\d+$/.test(left), rightNumeric = /^\d+$/.test(right);
    if (leftNumeric !== rightNumeric) return rightNumeric;
    return leftNumeric ? BigInt(left) > BigInt(right) : left > right;
  }
  return a.pre.length > b.pre.length;
}

function createUpdateChecker({ getCurrentVersion, checkForUpdates, requestJson, log = () => {}, assertExternalUrl = validateExternalUrl }) {
  return async function checkForPublishedUpdate() {
    const currentVersion = getCurrentVersion();
    const fallbackPageUrl = UPDATE_REPOSITORY + '/releases/latest';
    try {
      const result = await checkForUpdates();
      const latestVersion = result?.updateInfo?.version;
      if (!latestVersion) throw new Error('更新信息缺少版本号');
      return {
        currentVersion,
        latestVersion: String(latestVersion).replace(/^v/i, ''),
        hasUpdate: isNewerVersion(latestVersion, currentVersion),
        pageUrl: fallbackPageUrl
      };
    } catch (error) {
      log('warn', `electron-updater 检查失败：${error?.message || error}`, error);
      try {
        const release = await requestJson(UPDATE_API + '/releases/latest');
        const latestVersion = release?.tag_name;
        if (!latestVersion) throw new Error('发布版本缺少版本号');
        let pageUrl = fallbackPageUrl;
        if (release.html_url) {
          try { pageUrl = assertExternalUrl(release.html_url); } catch { /* Use the known release page. */ }
        }
        return {
          currentVersion,
          latestVersion: String(latestVersion).replace(/^v/i, ''),
          hasUpdate: isNewerVersion(latestVersion, currentVersion),
          pageUrl
        };
      } catch (error) {
        throw new Error('更新检查失败：' + error.message, { cause: error });
      }
    }
  };
}

module.exports = { createUpdateChecker, isNewerVersion };
