const path = require('path');
const { resolveTaskDestination } = require('./destination');

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function collectAllowedLocalRoots({ settingsDownloadDir, defaultDownloadDir, history, tasks, safeName }) {
  const roots = [settingsDownloadDir, defaultDownloadDir];
  for (const record of history) {
    if (!record || typeof record.outputDir !== 'string' || !path.isAbsolute(record.outputDir)) continue;
    roots.push(record.outputDir);
    const retry = record.retryTask;
    if (!retry || typeof retry.outputDir !== 'string' || !path.isAbsolute(retry.outputDir)) continue;
    const expectedDestination = resolveTaskDestination(retry, safeName);
    if (samePath(expectedDestination, record.outputDir)) roots.push(retry.outputDir);
  }
  for (const task of tasks) if (task && typeof task.outputDir === 'string' && path.isAbsolute(task.outputDir)) roots.push(task.outputDir);
  return [...new Set(roots.filter(root => typeof root === 'string' && path.isAbsolute(root)))];
}

module.exports = { collectAllowedLocalRoots };
