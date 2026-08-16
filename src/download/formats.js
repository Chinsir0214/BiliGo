const { AUDIO_FORMATS, DOWNLOAD_DEFAULTS } = require('./constants');

function normalizeContentModes(value, fallback = ['video-audio']) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : fallback;
  return values.flatMap(mode => String(mode || '').split(',')).map(mode => mode.trim().replace(/^video\+audio$/i, 'video-audio')).filter(Boolean);
}

function limitRateArg(value) {
  const match = String(value || '').trim().match(/^([\d.]+)\s*(kbps|k|mbps|m|gbps|g)?$/i);
  if (!match) return '';
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return '';
  const unit = (match[2] || 'kbps').toLowerCase();
  const bitsPerSecond = unit === 'g' || unit === 'gbps' ? amount * 1000000000 : unit === 'm' || unit === 'mbps' ? amount * 1000000 : amount * 1000;
  return `${Math.round(bitsPerSecond / 8)}B`;
}

function ytdlpDownloadArgs(task, modes = [], resolveFfmpeg) {
  const retries = Math.max(1, Math.min(10, Number(task.retries || DOWNLOAD_DEFAULTS.retries)));
  const threads = Math.max(1, Math.min(16, Number(task.fragmentThreads || DOWNLOAD_DEFAULTS.fragmentThreads)));
  const args = ['--newline', '--no-warnings', '--progress', '--no-playlist', '--ffmpeg-location', resolveFfmpeg(), '--retries', String(retries), '--fragment-retries', String(retries), '-N', String(threads)];
  // Bilibili's audio CDN can throttle a single HTTP request; range chunks keep audio downloads from getting stuck at a low rate.
  if (modes.includes('video-audio') || modes.includes('audio')) args.push('--http-chunk-size', '10M');
  const limitRate = limitRateArg(task.rateLimit);
  if (limitRate) args.push('--limit-rate', limitRate);
  return args;
}

function audioFormatArgs(task, args) {
  const format = AUDIO_FORMATS.has(task.audioFormat) ? task.audioFormat : DOWNLOAD_DEFAULTS.audioFormat;
  if (format === 'flac') args.push('-f', 'ba[ext=flac]/ba');
  else args.push('-f', task.audioQuality || 'ba/b');
  if (format !== 'original' && format !== 'flac') args.push('--extract-audio', '--audio-format', format);
}

module.exports = { normalizeContentModes, limitRateArg, ytdlpDownloadArgs, audioFormatArgs };
