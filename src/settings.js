const path = require('path');
const { DOWNLOAD_DEFAULTS, AUDIO_FORMATS, CONTAINER_FORMATS, VIDEO_QUALITIES, AUDIO_QUALITIES, normalizeVideoQuality } = require('./download/constants');
const { validateContentModes } = require('./download/request');
const { getMediaCapabilities, normalizeFragmentThreads, parseRetryCount } = require('./download/options');

const SETTING_KEYS = new Set([
  'downloadDir', 'showThumbnails', 'contentModes', 'videoQuality', 'audioQuality',
  'audioFormat', 'fragmentThreads', 'maxConcurrentTasks', 'containerFormat',
  'filenameTemplate', 'subtitleLangs', 'rateLimit', 'retries', 'embedThumbnail',
  'embedMetadata', 'embedSubs', 'embedChapters'
]);

function defaults(downloadDir) {
  return {
    downloadDir,
    showThumbnails: false,
    contentModes: ['video-audio'],
    videoQuality: DOWNLOAD_DEFAULTS.videoQuality,
    audioQuality: DOWNLOAD_DEFAULTS.audioQuality,
    audioFormat: DOWNLOAD_DEFAULTS.audioFormat,
    fragmentThreads: DOWNLOAD_DEFAULTS.fragmentThreads,
    maxConcurrentTasks: DOWNLOAD_DEFAULTS.maxConcurrentTasks,
    containerFormat: DOWNLOAD_DEFAULTS.containerFormat,
    filenameTemplate: DOWNLOAD_DEFAULTS.filenameTemplate,
    subtitleLangs: DOWNLOAD_DEFAULTS.subtitleLangs,
    rateLimit: '',
    retries: String(DOWNLOAD_DEFAULTS.retries),
    embedThumbnail: false,
    embedMetadata: false,
    embedSubs: false,
    embedChapters: false
  };
}

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum
    ? Math.max(minimum, Math.min(maximum, Math.floor(number)))
    : fallback;
}

function normalizeSettings(value, defaultDownloadDir) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const base = defaults(defaultDownloadDir);
  let contentModes;
  try { contentModes = validateContentModes(raw.contentModes, false, base.contentModes); }
  catch (_) { contentModes = base.contentModes; }
  const { hasVideo } = getMediaCapabilities(contentModes);
  const videoQuality = normalizeVideoQuality(raw.videoQuality);
  return {
    downloadDir: typeof raw.downloadDir === 'string' && path.isAbsolute(raw.downloadDir) ? raw.downloadDir : base.downloadDir,
    showThumbnails: raw.showThumbnails === true,
    contentModes,
    videoQuality: VIDEO_QUALITIES.has(videoQuality) ? videoQuality : base.videoQuality,
    audioQuality: AUDIO_QUALITIES.has(raw.audioQuality) ? raw.audioQuality : base.audioQuality,
    audioFormat: AUDIO_FORMATS.has(raw.audioFormat) ? raw.audioFormat : base.audioFormat,
    fragmentThreads: normalizeFragmentThreads(raw.fragmentThreads),
    maxConcurrentTasks: boundedNumber(raw.maxConcurrentTasks, base.maxConcurrentTasks, 1, 10),
    containerFormat: CONTAINER_FORMATS.has(raw.containerFormat) ? raw.containerFormat : base.containerFormat,
    filenameTemplate: String(raw.filenameTemplate || base.filenameTemplate),
    subtitleLangs: String(raw.subtitleLangs || base.subtitleLangs),
    rateLimit: String(raw.rateLimit || ''),
    retries: String(parseRetryCount(raw.retries) ?? base.retries),
    embedThumbnail: raw.embedThumbnail === true,
    embedMetadata: raw.embedMetadata === true,
    embedSubs: hasVideo && raw.embedSubs === true,
    embedChapters: raw.embedChapters === true
  };
}

function applySettingsChanges(currentValue, changes, defaultDownloadDir, isDirectory) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('设置参数无效');
  const current = normalizeSettings(currentValue, defaultDownloadDir);
  const safe = Object.fromEntries(Object.entries(changes).filter(([key]) => SETTING_KEYS.has(key)));
  if (safe.downloadDir !== undefined) {
    const directory = String(safe.downloadDir);
    if (!path.isAbsolute(directory) || !isDirectory(directory)) throw new Error('下载目录无效');
    safe.downloadDir = directory;
  }
  if (safe.videoQuality !== undefined && !VIDEO_QUALITIES.has(String(normalizeVideoQuality(safe.videoQuality)))) throw new Error('视频画质无效');
  if (safe.audioQuality !== undefined && !AUDIO_QUALITIES.has(String(safe.audioQuality))) throw new Error('音频质量无效');
  if (safe.retries !== undefined && parseRetryCount(safe.retries) === null) throw new Error('下载及分片重试次数无效：请输入 1–10 的整数');
  const modes = safe.contentModes === undefined
    ? current.contentModes
    : validateContentModes(safe.contentModes, false, []);
  let embedSubs = safe.embedSubs === undefined ? current.embedSubs : safe.embedSubs === true;
  if (safe.contentModes !== undefined && safe.embedSubs === undefined && !getMediaCapabilities(modes).hasVideo) embedSubs = false;
  validateContentModes(modes, embedSubs, []);
  return normalizeSettings({ ...current, ...safe, contentModes: modes, embedSubs }, defaultDownloadDir);
}

module.exports = { defaults, normalizeSettings, applySettingsChanges };
