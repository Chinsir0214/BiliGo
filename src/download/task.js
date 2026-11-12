const { DOWNLOAD_DEFAULTS, AUDIO_FORMATS, CONTAINER_FORMATS, normalizeVideoQuality } = require('./constants');
const { getMediaCapabilities, normalizeContentModes, normalizeFragmentThreads } = require('./options');

const PERSISTED_TASK_FIELDS = [
  'id', 'url', 'urls', 'itemTitles', 'title', 'thumbnail', 'folderName', 'resourceType',
  'contentModes', 'videoQuality', 'audioQuality', 'audioFormat', 'outputDir',
  'filenameTemplate', 'containerFormat', 'embedChapters', 'embedThumbnail',
  'embedMetadata', 'embedSubs', 'subtitleLangs', 'rateLimit', 'retries',
  'fragmentThreads', 'queuedAt'
];

function createDownloadTask(data, info, settings, id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`) {
  const selectedAudioFormat = data.audioFormat || settings.audioFormat;
  const selectedContainer = data.containerFormat || settings.containerFormat;
  const contentModes = normalizeContentModes(data.contentModes?.length ? data.contentModes : settings.contentModes?.length ? settings.contentModes : [data.mode || 'video-audio']);
  const { hasVideo } = getMediaCapabilities(contentModes);
  const fragmentThreads = data.fragmentThreads === undefined ? settings.fragmentThreads : data.fragmentThreads;
  return {
    id,
    url: data.url,
    urls: data.urls,
    itemTitles: data.itemTitles,
    title: info.title,
    thumbnail: info.thumbnail,
    folderName: data.folderName,
    resourceType: data.resourceType,
    contentModes,
    videoQuality: normalizeVideoQuality(data.videoQuality || settings.videoQuality || DOWNLOAD_DEFAULTS.videoQuality),
    audioQuality: data.audioQuality || settings.audioQuality || DOWNLOAD_DEFAULTS.audioQuality,
    audioFormat: AUDIO_FORMATS.has(selectedAudioFormat) ? selectedAudioFormat : DOWNLOAD_DEFAULTS.audioFormat,
    outputDir: data.outputDir,
    filenameTemplate: data.filenameTemplate || settings.filenameTemplate || DOWNLOAD_DEFAULTS.filenameTemplate,
    containerFormat: CONTAINER_FORMATS.has(selectedContainer) ? selectedContainer : DOWNLOAD_DEFAULTS.containerFormat,
    embedThumbnail: data.embedThumbnail ?? settings.embedThumbnail ?? DOWNLOAD_DEFAULTS.embedThumbnail,
    embedMetadata: data.embedMetadata ?? settings.embedMetadata ?? DOWNLOAD_DEFAULTS.embedMetadata,
    embedChapters: data.embedChapters ?? settings.embedChapters,
    embedSubs: hasVideo && (data.embedSubs ?? settings.embedSubs),
    subtitleLangs: data.subtitleLangs || settings.subtitleLangs || DOWNLOAD_DEFAULTS.subtitleLangs,
    rateLimit: data.rateLimit ?? settings.rateLimit,
    retries: data.retries || settings.retries || DOWNLOAD_DEFAULTS.retries,
    fragmentThreads: normalizeFragmentThreads(fragmentThreads),
    queuedAt: new Date().toISOString()
  };
}

function serializeTaskForQueue(task) {
  return Object.fromEntries(PERSISTED_TASK_FIELDS.map(field => [field, task[field]]));
}

module.exports = { createDownloadTask, serializeTaskForQueue };
