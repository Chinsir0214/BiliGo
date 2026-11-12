const path = require('path');

function resolveTaskDestination(task, safeName) {
  const destinationRoot = task.outputDir;
  const group = task.folderName || (task.resourceType && task.resourceType !== 'video' ? task.title : '');
  return group ? path.join(destinationRoot, safeName(group)) : destinationRoot;
}

module.exports = { resolveTaskDestination };
