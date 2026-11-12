const UPDATE_REPOSITORY = 'https://github.com/Chinsir0214/BiliGo';
const UPDATE_API = 'https://api.github.com/repos/Chinsir0214/BiliGo';

function versionParts(value) { return String(value || '0').replace(/^v/i, '').split(/[.-]/).map(part => Number.parseInt(part, 10) || 0); }
function isNewerVersion(latest, current) {
  const a = versionParts(latest);
  const b = versionParts(current);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0);
  }
  return false;
}

function createUpdateChecker({ getCurrentVersion, checkForUpdates, requestJson }) {
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
    } catch (_) {
      try {
        const release = await requestJson(UPDATE_API + '/releases/latest');
        const latestVersion = release?.tag_name;
        if (!latestVersion) throw new Error('发布版本缺少版本号');
        return {
          currentVersion,
          latestVersion: String(latestVersion).replace(/^v/i, ''),
          hasUpdate: isNewerVersion(latestVersion, currentVersion),
          pageUrl: release.html_url || fallbackPageUrl
        };
      } catch (error) {
        throw new Error('更新检查失败：' + error.message, { cause: error });
      }
    }
  };
}

module.exports = { createUpdateChecker };
