const path = require('path');
const { ALLOWED_MODES, VIDEO_QUALITIES, AUDIO_QUALITIES, normalizeVideoQuality } = require('./constants');
const { MEDIA_MODES, getMediaCapabilities, normalizeContentModes, normalizeFragmentThreads, parseRetryCount } = require('./options');

function validateContentModes(value, embedSubs, fallback = []) {
  const modes = [...new Set(normalizeContentModes(value, fallback))];
  if (!modes.length || modes.some(mode => !ALLOWED_MODES.has(mode))) throw new Error('下载内容类型无效');
  const mediaModes = modes.filter(mode => MEDIA_MODES.includes(mode));
  if (mediaModes.length > 1) throw new Error('下载类型冲突：只能选择一种媒体类型');
  if (embedSubs === true && !getMediaCapabilities(modes).hasVideo) throw new Error('嵌入字幕仅支持视频模式');
  return modes;
}

function validateDownloadData(data, { assertBilibiliUrl, isAllowedLocalPath }) {
  if (!data || typeof data !== 'object') throw new Error('下载参数无效');
  const url = assertBilibiliUrl(data.url);
  const urls = Array.isArray(data.urls) && data.urls.length ? data.urls.map(assertBilibiliUrl) : [url];
  const modes = validateContentModes(data.contentModes, data.embedSubs, data.mode ? [data.mode] : []);
  const videoQuality = normalizeVideoQuality(data.videoQuality);
  if (videoQuality !== undefined && !VIDEO_QUALITIES.has(String(videoQuality))) throw new Error('视频画质无效');
  if (data.audioQuality !== undefined && !AUDIO_QUALITIES.has(String(data.audioQuality))) throw new Error('音频质量无效');
  if (data.itemTitles !== undefined && !Array.isArray(data.itemTitles)) throw new TypeError('下载条目标题必须为数组');
  const retries = data.retries === undefined ? undefined : parseRetryCount(data.retries);
  if (retries === null) throw new Error('下载及分片重试次数无效：请输入 1–10 的整数');
  if (data.outputDir !== undefined && (!path.isAbsolute(String(data.outputDir)) || !isAllowedLocalPath(String(data.outputDir)))) throw new Error('下载目录不允许');
  return {
    ...data, url, urls, contentModes: modes,
    ...(data.itemTitles === undefined ? {} : { itemTitles: Array.from(data.itemTitles, String) }),
    ...(videoQuality === undefined ? {} : { videoQuality }),
    ...(retries === undefined ? {} : { retries }),
    ...(data.fragmentThreads === undefined ? {} : { fragmentThreads: normalizeFragmentThreads(data.fragmentThreads) })
  };
}

module.exports = { validateContentModes, validateDownloadData };
