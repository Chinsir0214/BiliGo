const { DOWNLOAD_DEFAULTS, AUDIO_FORMATS, CONTAINER_FORMATS } = require('./constants');

function createDownloadTask(data, info, settings, id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`) {
  const selectedAudioFormat = data.audioFormat || settings.audioFormat;
  const selectedContainer = data.containerFormat || settings.containerFormat;
  return {
    id,
    url: data.url,
    urls: data.urls,
    itemTitles: data.itemTitles,
    title: info.title,
    thumbnail: info.thumbnail,
    folderName: data.folderName,
    resourceType: data.resourceType,
    contentModes: data.contentModes?.length ? data.contentModes : settings.contentModes?.length ? settings.contentModes : [data.mode || 'video-audio'],
    videoQuality: data.videoQuality || settings.videoQuality || DOWNLOAD_DEFAULTS.videoQuality,
    audioQuality: data.audioQuality || settings.audioQuality || DOWNLOAD_DEFAULTS.audioQuality,
    audioFormat: AUDIO_FORMATS.has(selectedAudioFormat) ? selectedAudioFormat : DOWNLOAD_DEFAULTS.audioFormat,
    outputDir: data.outputDir,
    filenameTemplate: data.filenameTemplate || settings.filenameTemplate || DOWNLOAD_DEFAULTS.filenameTemplate,
    containerFormat: CONTAINER_FORMATS.has(selectedContainer) ? selectedContainer : DOWNLOAD_DEFAULTS.containerFormat,
    embedThumbnail: data.embedThumbnail ?? settings.embedThumbnail ?? DOWNLOAD_DEFAULTS.embedThumbnail,
    embedMetadata: data.embedMetadata ?? settings.embedMetadata ?? DOWNLOAD_DEFAULTS.embedMetadata,
    embedChapters: data.embedChapters ?? settings.embedChapters,
    embedSubs: data.embedSubs ?? settings.embedSubs,
    subtitleLangs: data.subtitleLangs || settings.subtitleLangs || DOWNLOAD_DEFAULTS.subtitleLangs,
    rateLimit: data.rateLimit ?? settings.rateLimit,
    retries: data.retries || settings.retries || DOWNLOAD_DEFAULTS.retries,
    fragmentThreads: Number(data.fragmentThreads || settings.fragmentThreads || DOWNLOAD_DEFAULTS.fragmentThreads),
    queuedAt: new Date().toISOString()
  };
}

function serializeTaskForQueue(task) {
  return {
    id: task.id,
    url: task.url,
    urls: task.urls,
    itemTitles: task.itemTitles,
    title: task.title,
    thumbnail: task.thumbnail,
    folderName: task.folderName,
    resourceType: task.resourceType,
    contentModes: task.contentModes,
    videoQuality: task.videoQuality,
    audioQuality: task.audioQuality,
    audioFormat: task.audioFormat,
    outputDir: task.outputDir,
    filenameTemplate: task.filenameTemplate,
    containerFormat: task.containerFormat,
    embedChapters: task.embedChapters,
    embedThumbnail: task.embedThumbnail,
    embedMetadata: task.embedMetadata,
    embedSubs: task.embedSubs,
    subtitleLangs: task.subtitleLangs,
    rateLimit: task.rateLimit,
    retries: task.retries,
    fragmentThreads: task.fragmentThreads,
    queuedAt: new Date().toISOString()
  };
}

module.exports = { createDownloadTask, serializeTaskForQueue };
