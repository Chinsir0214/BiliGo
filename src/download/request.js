const path = require('path');
const { ALLOWED_MODES, VIDEO_QUALITIES, AUDIO_QUALITIES } = require('./constants');
const { normalizeContentModes } = require('./formats');

function validateDownloadData(data, { assertBilibiliUrl, isAllowedLocalPath }) {
  if (!data || typeof data !== 'object') throw new Error('下载参数无效');
  const url = assertBilibiliUrl(data.url);
  const urls = Array.isArray(data.urls) && data.urls.length ? data.urls.map(assertBilibiliUrl) : [url];
  const modes = normalizeContentModes(data.contentModes, data.mode ? [data.mode] : []);
  if (!modes.length || modes.some(mode => !ALLOWED_MODES.has(mode))) throw new Error('下载内容类型无效');
  const mediaMode = modes.find(mode => ['video-audio', 'video', 'audio'].includes(mode));
  if (modes.filter(mode => ['video-audio', 'video', 'audio'].includes(mode)).length > 1) throw new Error('下载类型冲突：只能选择一种媒体类型');
  if (data.videoQuality !== undefined && !VIDEO_QUALITIES.has(String(data.videoQuality))) throw new Error('视频画质无效');
  if (data.audioQuality !== undefined && !AUDIO_QUALITIES.has(String(data.audioQuality))) throw new Error('音频质量无效');
  if (data.embedSubs === true && !['video-audio', 'video'].includes(mediaMode)) throw new Error('嵌入字幕仅支持视频模式');
  if (data.outputDir !== undefined && (!path.isAbsolute(String(data.outputDir)) || !isAllowedLocalPath(String(data.outputDir)))) throw new Error('下载目录不允许');
  return { ...data, url, urls, contentModes: modes };
}

module.exports = { validateDownloadData };
