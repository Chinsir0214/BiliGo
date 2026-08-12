const fs = require('fs');
const path = require('path');

const platform = process.platform;

function toolName(name) {
  return platform === 'win32' ? `${name}.exe` : name;
}

function resolveTool(app, name) {
  const file = toolName(name);
  const candidates = [
    path.join(process.resourcesPath || '', 'tools', file),
    path.join(__dirname, '..', 'tools', file),
    path.join(app.getPath('userData'), 'tools', file)
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || name;
}

module.exports = { resolveTool };
