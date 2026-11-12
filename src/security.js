const fs = require('node:fs');
const path = require('node:path');

function assertBilibiliUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '')); } catch (_) { throw new Error('链接格式无效'); }
  const host = parsed.hostname.toLowerCase();
  const allowed = host === 'b23.tv' || host === 'bilibili.com' || host.endsWith('.bilibili.com');
  if (parsed.protocol !== 'https:' || !allowed || parsed.username || parsed.password) throw new Error('只支持 HTTPS Bilibili 链接');
  return parsed.toString();
}

function assertExternalUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '')); } catch (_) { throw new Error('链接格式无效'); }
  const host = parsed.hostname.toLowerCase();
  const bilibili = host === 'b23.tv' || host === 'bilibili.com' || host.endsWith('.bilibili.com');
  const releasePage = host === 'github.com' && /^\/Chinsir0214\/BiliGo(?:\/|$)/i.test(parsed.pathname);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (!bilibili && !releasePage)) throw new Error('不允许打开该外部链接');
  return parsed.toString();
}

function canonicalPath(value) {
  let existing = path.resolve(value);
  const missing = [];
  while (true) {
    try { return path.resolve(fs.realpathSync.native(existing), ...missing); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

function isPathInside(root, target) {
  const relative = path.relative(canonicalPath(root), canonicalPath(target));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isAllowedLocalPath(target, roots) {
  if (!target || !path.isAbsolute(target)) return false;
  return roots.some(root => {
    try { return Boolean(root && path.isAbsolute(root) && isPathInside(root, target)); }
    catch (_) { return false; }
  });
}

module.exports = { assertBilibiliUrl, assertExternalUrl, isAllowedLocalPath };
