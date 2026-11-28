const path = require('path');
const { SCHEMA_VERSION, assertSchemaVersion } = require('./infra/json-store');
const { DOWNLOAD_DEFAULTS, AUDIO_FORMATS, CONTAINER_FORMATS, VIDEO_QUALITIES, AUDIO_QUALITIES, normalizeVideoQuality } = require('./download/constants');
const { validateContentModes } = require('./download/request');
const { getMediaCapabilities, normalizeFragmentThreads, parseRetryCount } = require('./download/options');
const { limitRateArg } = require('./download/formats');

const SETTING_KEYS = new Set(['downloadDir', ...Object.keys(DOWNLOAD_DEFAULTS)]);

function defaults(downloadDir) {
  return {
    ...DOWNLOAD_DEFAULTS, downloadDir, schemaVersion: SCHEMA_VERSION,
    contentModes: [...DOWNLOAD_DEFAULTS.contentModes], retries: String(DOWNLOAD_DEFAULTS.retries)
  };
}

function positiveNumber(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? number : null;
}

function cleanText(value) {
  return typeof value === 'string' && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : null;
}

function normalizeSettings(value, defaultDownloadDir, strict = false) {
  assertSchemaVersion(value);
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = defaults(defaultDownloadDir);
  function set(key, normalized, message) {
    if (raw[key] === undefined) return;
    if (normalized !== null && normalized !== undefined) result[key] = normalized;
    else if (strict) throw new Error(message);
  }
  set('downloadDir', typeof raw.downloadDir === 'string' && path.isAbsolute(raw.downloadDir) ? raw.downloadDir : null, '下载目录无效');
  try { result.contentModes = validateContentModes(raw.contentModes, false, result.contentModes); }
  catch (error) { if (strict) throw error; }
  const videoQuality = normalizeVideoQuality(raw.videoQuality);
  set('videoQuality', VIDEO_QUALITIES.has(videoQuality) ? videoQuality : null, '视频画质无效');
  set('audioQuality', AUDIO_QUALITIES.has(raw.audioQuality) ? raw.audioQuality : null, '音频质量无效');
  set('audioFormat', AUDIO_FORMATS.has(raw.audioFormat) ? raw.audioFormat : null, '音频格式无效');
  set('containerFormat', CONTAINER_FORMATS.has(raw.containerFormat) ? raw.containerFormat : null, '容器格式无效');
  const concurrency = positiveNumber(raw.maxConcurrentTasks);
  set('maxConcurrentTasks', concurrency === null ? null : Math.min(10, Math.floor(concurrency)), '同时下载任务数无效');
  set('fragmentThreads', positiveNumber(raw.fragmentThreads) === null ? null : normalizeFragmentThreads(raw.fragmentThreads), '分片线程数无效');
  const retries = parseRetryCount(raw.retries);
  set('retries', retries === null ? null : String(retries), '下载及分片重试次数无效：请输入 1–10 的整数');
  const rate = typeof raw.rateLimit === 'number' ? String(raw.rateLimit) : cleanText(raw.rateLimit);
  set('rateLimit', rate === '' || (rate && limitRateArg(rate)) ? rate : null, '下载限速无效');
  const template = cleanText(raw.filenameTemplate);
  set('filenameTemplate', template === null ? null : template.replace(/[\\/]/g, '_').replace(/\.\./g, '_') || result.filenameTemplate, '文件名模板无效');
  const langs = cleanText(raw.subtitleLangs);
  set('subtitleLangs', langs === null ? null : langs.split(',').map(lang => lang.trim()).filter(Boolean).join(',') || result.subtitleLangs, '字幕语言无效');
  for (const key of ['showThumbnails', 'embedThumbnail', 'embedMetadata', 'embedSubs', 'embedChapters']) {
    set(key, typeof raw[key] === 'boolean' ? raw[key] : null, '设置项 ' + key + ' 必须是布尔值');
  }
  if (!getMediaCapabilities(result.contentModes).hasVideo) result.embedSubs = false;
  return result;
}

function applySettingsChanges(currentValue, changes, defaultDownloadDir, isDirectory) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('设置参数无效');
  assertSchemaVersion(changes);
  const current = normalizeSettings(currentValue, defaultDownloadDir);
  const safe = Object.fromEntries(Object.entries(changes).filter(([key, value]) => SETTING_KEYS.has(key) && value !== undefined));
  if (safe.downloadDir !== undefined && (typeof safe.downloadDir !== 'string' || !path.isAbsolute(safe.downloadDir) || !isDirectory(safe.downloadDir))) {
    throw new Error('下载目录无效');
  }
  if (safe.contentModes !== undefined || safe.embedSubs === true) {
    validateContentModes(safe.contentModes === undefined ? current.contentModes : safe.contentModes, safe.embedSubs, []);
  }
  return normalizeSettings({ ...current, ...safe }, defaultDownloadDir, true);
}

module.exports = { SCHEMA_VERSION, defaults, normalizeSettings, applySettingsChanges };
