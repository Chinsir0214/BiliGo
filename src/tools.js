const fs = require('fs');
const path = require('path');

const platform = process.platform;

function toolName(name) {
  return platform === 'win32' ? `${name}.exe` : name;
}

function resolveTool(name) {
  const file = toolName(name);
  const candidates = [
    path.join(process.resourcesPath || '', 'tools', file),
    path.join(__dirname, '..', 'tools', file)
  ];
  const resolved = candidates.find(candidate => fs.existsSync(candidate));
  if (!resolved) throw new Error(`未找到 ${name}`);
  return resolved;
}

module.exports = { resolveTool };
