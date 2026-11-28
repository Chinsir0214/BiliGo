const { MEDIA_MODES, DEFAULT_FRAGMENT_THREADS, DEFAULT_VIDEO_QUALITY, normalizeVideoQuality } = require('./options');

const ALLOWED_MODES = new Set([...MEDIA_MODES, 'cover', 'subtitle', 'danmaku']);
const DOWNLOAD_DEFAULTS = Object.freeze({ containerFormat: 'mp4', filenameTemplate: '%(title)s.%(ext)s', subtitleLangs: 'all', retries: 3, fragmentThreads: DEFAULT_FRAGMENT_THREADS, maxConcurrentTasks: 1, videoQuality: DEFAULT_VIDEO_QUALITY, audioQuality: 'ba/b', audioFormat: 'original', embedThumbnail: false, embedMetadata: false, embedSubs: false, embedChapters: false, contentModes: Object.freeze(['video-audio']), rateLimit: '', showThumbnails: false });
const AUDIO_FORMATS = new Set(['original', 'mp3', 'm4a', 'flac', 'opus']);
const CONTAINER_FORMATS = new Set(['mp4', 'mkv', 'webm']);
const VIDEO_QUALITIES = new Set(['bv*', 'bv[height<=2160]', 'bv[height<=1080]', 'bv[height<=720]', 'bv[height<=480]']);
const AUDIO_QUALITIES = new Set(['ba/b', 'ba[abr>=192]/ba', 'ba[abr>=128]/ba']);

module.exports = { ALLOWED_MODES, DOWNLOAD_DEFAULTS, AUDIO_FORMATS, CONTAINER_FORMATS, VIDEO_QUALITIES, AUDIO_QUALITIES, normalizeVideoQuality };
