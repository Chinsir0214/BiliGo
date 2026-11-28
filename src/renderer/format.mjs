const modeLabels = {
  'video-audio': '视频 + 音频',
  video: '仅视频',
  audio: '仅音频',
  danmaku: '弹幕',
  subtitle: '字幕',
  cover: '封面'
};

export function modeLabel(value) {
  return String(value || '').split(',').map(mode => modeLabels[mode] || mode).join('、') || '下载任务';
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || '');
}

export function imageUrl(value) {
  if (typeof value !== 'string') return '';
  const source = value.trim();
  if (!/^https:\/\//i.test(source) || /[\s\\]/.test(source)) return '';
  try {
    const url = new URL(source);
    return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

function nonnegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

export function duration(value) {
  const seconds = Math.round(nonnegativeNumber(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const rest = String(seconds % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

export function fileSize(value) {
  const bytes = nonnegativeNumber(value);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
