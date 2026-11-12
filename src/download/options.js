(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BiliGoDownloadOptions ||= factory();
})(globalThis, function () {
  const MEDIA_MODES = Object.freeze(['video-audio', 'video', 'audio']);
  const DEFAULT_FRAGMENT_THREADS = 4;

  function normalizeContentModes(value, fallback = ['video-audio']) {
    const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : fallback;
    return values.flatMap(mode => String(mode || '').split(',')).map(mode => mode.trim().replace(/^video\+audio$/i, 'video-audio')).filter(Boolean);
  }

  function getMediaCapabilities(modes) {
    const mediaMode = MEDIA_MODES.find(mode => modes.includes(mode));
    return {
      mediaMode,
      hasVideo: mediaMode === 'video-audio' || mediaMode === 'video',
      hasAudio: mediaMode === 'video-audio' || mediaMode === 'audio',
      hasMedia: mediaMode !== undefined
    };
  }

  function parseRetryCount(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    const text = String(value).trim();
    return /^(?:[1-9]|10)$/.test(text) ? Number(text) : null;
  }

  function normalizeFragmentThreads(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return DEFAULT_FRAGMENT_THREADS;
    const number = Number(value);
    return Number.isFinite(number) && number >= 1
      ? Math.min(16, Math.floor(number))
      : DEFAULT_FRAGMENT_THREADS;
  }

  return { MEDIA_MODES, DEFAULT_FRAGMENT_THREADS, normalizeContentModes, getMediaCapabilities, parseRetryCount, normalizeFragmentThreads };
});
