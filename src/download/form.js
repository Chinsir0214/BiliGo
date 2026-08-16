const downloadModes = new Set(['video-audio', 'video', 'audio', 'cover', 'subtitle', 'danmaku']);

export function readDownloadForm({ sourceUrl, selectedItems, resource, modes, controls, subtitleValues }) {
  const selectedSubtitleLangs = subtitleValues.map(value => value.split(':')[0]).join(',');
  return {
    sourceUrl: sourceUrl.trim(),
    selectedItems: [...selectedItems],
    subtitleValues: [...subtitleValues],
    folderName: resource.type !== 'video' ? resource.title : '',
    modes: [...modes],
    embedSubs: controls.embedSubs.checked === true,
    subtitleLangs: selectedSubtitleLangs || controls.subtitleLangs.value.trim() || 'all',
    videoQuality: controls.videoQuality.value,
    audioQuality: controls.audioQuality.value,
    audioFormat: controls.audioFormat.value,
    filenameTemplate: controls.filenameTemplate.value.trim(),
    containerFormat: controls.containerFormat.value,
    embedThumbnail: controls.embedThumbnail.checked,
    embedMetadata: controls.embedMetadata.checked,
    embedChapters: controls.embedChapters.checked,
    rateLimit: controls.rateLimit.value.trim(),
    retries: controls.retries.value,
    fragmentThreads: controls.fragmentThreads.value
  };
}

export function validateDownloadForm(form) {
  if (!form.selectedItems.length) return '请至少选择一个条目';
  if (!form.modes.length) return '请至少选择一种下载内容';
  if ((form.modes.includes('subtitle') || form.embedSubs) && !form.subtitleValues.length) return '请至少选择字幕语言';
  if (form.modes.some(mode => !downloadModes.has(mode))) return '下载内容无效';
  if (form.embedSubs && !form.modes.includes('video-audio') && !form.modes.includes('video')) return '嵌入字幕仅支持视频模式';
  return '';
}

export function buildDownloadRequest(form, item) {
    const url = item.url || form.sourceUrl;
    return {
      url,
      urls: [url],
      itemTitles: [item.title],
      title: item.title,
      folderName: form.folderName,
      resourceType: 'video',
      contentModes: form.modes,
      videoQuality: form.videoQuality,
      audioQuality: form.audioQuality,
      audioFormat: form.audioFormat,
      filenameTemplate: form.filenameTemplate,
      containerFormat: form.containerFormat,
      embedThumbnail: form.embedThumbnail,
      embedMetadata: form.embedMetadata,
      embedSubs: form.embedSubs,
      embedChapters: form.embedChapters,
      subtitleLangs: form.subtitleLangs,
      rateLimit: form.rateLimit,
      retries: form.retries,
      fragmentThreads: form.fragmentThreads
    };
}
