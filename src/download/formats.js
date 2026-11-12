const { AUDIO_FORMATS, DOWNLOAD_DEFAULTS } = require('./constants');
const { getMediaCapabilities, normalizeContentModes, normalizeFragmentThreads, parseRetryCount } = require('./options');

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
  const retries = parseRetryCount(task.retries === undefined ? DOWNLOAD_DEFAULTS.retries : task.retries);
  if (retries === null) throw new Error('下载及分片重试次数无效：请输入 1–10 的整数');
  const threads = normalizeFragmentThreads(task.fragmentThreads);
  const args = ['--newline', '--no-warnings', '--progress', '--no-playlist', '--ffmpeg-location', resolveFfmpeg(), '--retries', String(retries), '--fragment-retries', String(retries), '--abort-on-unavailable-fragments', '--retry-sleep', 'http:exp=1:10', '--retry-sleep', 'fragment:exp=1:10', '-N', String(threads)];
  // Bilibili's audio CDN can throttle a single HTTP request; range chunks keep audio downloads from getting stuck at a low rate.
  if (getMediaCapabilities(modes).hasAudio) args.push('--http-chunk-size', '10M');
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

module.exports = { normalizeContentModes, limitRateArg, parseRetryCount, ytdlpDownloadArgs, audioFormatArgs };
