const { MEDIA_MODES, DEFAULT_FRAGMENT_THREADS } = require('./options');

const ALLOWED_MODES = new Set([...MEDIA_MODES, 'cover', 'subtitle', 'danmaku']);
const DOWNLOAD_DEFAULTS = Object.freeze({ containerFormat: 'mp4', filenameTemplate: '%(title)s.%(ext)s', subtitleLangs: 'all', retries: 3, fragmentThreads: DEFAULT_FRAGMENT_THREADS, maxConcurrentTasks: 1, videoQuality: 'bv*', audioQuality: 'ba/b', audioFormat: 'original', embedThumbnail: false, embedMetadata: false });
const AUDIO_FORMATS = new Set(['original', 'mp3', 'm4a', 'flac', 'opus']);
const CONTAINER_FORMATS = new Set(['mp4', 'mkv', 'webm']);
const VIDEO_QUALITIES = new Set(['bv*', 'bv[height<=2160]', 'bv[height<=1080]', 'bv[height<=720]', 'bv[height<=480]']);
const AUDIO_QUALITIES = new Set(['ba/b', 'ba[abr>=192]/ba', 'ba[abr>=128]/ba']);

function normalizeVideoQuality(value) {
  return value === 'bv' ? DOWNLOAD_DEFAULTS.videoQuality : value;
}

module.exports = { ALLOWED_MODES, DOWNLOAD_DEFAULTS, AUDIO_FORMATS, CONTAINER_FORMATS, VIDEO_QUALITIES, AUDIO_QUALITIES, normalizeVideoQuality };
