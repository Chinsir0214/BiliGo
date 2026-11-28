const path = require('path');

function safeName(value) {
  const name = String(value || '未命名资源').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim().slice(0, 90).replace(/[. ]+$/g, '');
  if (!name || name.toLowerCase() === '.biligo-staging') return '未命名资源';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `_${name}` : name;
}

function resolveTaskDestination(task) {
  const destinationRoot = task.outputDir;
  const group = task.folderName || (task.resourceType && task.resourceType !== 'video' ? task.title : '');
  return group ? path.join(destinationRoot, safeName(group)) : destinationRoot;
}

module.exports = { safeName, resolveTaskDestination };
