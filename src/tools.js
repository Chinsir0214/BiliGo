const fs = require('fs');
const path = require('path');

function resolveTool(name) {
  if (name !== 'yt-dlp' && name !== 'ffmpeg') throw new Error(`不支持的工具：${name}`);
  const file = process.platform === 'win32' ? name + '.exe' : name;
  const candidates = [path.join(__dirname, '..', 'tools', file)];
  if (typeof process.resourcesPath === 'string' && path.isAbsolute(process.resourcesPath)) {
    candidates.unshift(path.join(process.resourcesPath, 'tools', file));
  }
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
  }
  throw new Error(`未找到 ${name}`);
}

module.exports = { resolveTool };
