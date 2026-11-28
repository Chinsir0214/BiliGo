const path = require('path');
const { resolveTaskDestination } = require('./destination');

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function collectAllowedLocalRoots({ settingsDownloadDir, defaultDownloadDir, history = [], tasks = [] }) {
  const roots = [settingsDownloadDir, defaultDownloadDir];
  for (const record of history) {
    if (!record || typeof record.outputDir !== 'string' || !path.isAbsolute(record.outputDir)) continue;
    roots.push(record.outputDir);
    const retry = record.retryTask;
    if (!retry || typeof retry.outputDir !== 'string' || !path.isAbsolute(retry.outputDir)) continue;
    const expectedDestination = resolveTaskDestination(retry);
    if (pathKey(expectedDestination) === pathKey(record.outputDir)) roots.push(retry.outputDir);
  }
  for (const task of tasks) if (task && typeof task.outputDir === 'string' && path.isAbsolute(task.outputDir)) roots.push(task.outputDir);
  const unique = new Map();
  for (const root of roots) {
    if (typeof root === 'string' && path.isAbsolute(root) && !unique.has(pathKey(root))) unique.set(pathKey(root), root);
  }
  return [...unique.values()];
}

module.exports = { collectAllowedLocalRoots, pathKey };
