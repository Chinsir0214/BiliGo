const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createTempDir } = require('./helpers/test-env');

const sourceFile = require.resolve('../src/tools');
const evaluateTools = vm.compileFunction(fs.readFileSync(sourceFile, 'utf8'),
  ['require', 'module', '__dirname', 'process'], { filename: sourceFile });
const executable = name => process.platform === 'win32' ? name + '.exe' : name;

function toolEnvironment(t) {
  const root = createTempDir(t, 'biligo-tools-');
  const project = path.join(root, 'project');
  const resources = path.join(root, 'resources');
  for (const base of [project, resources]) {
    fs.mkdirSync(path.join(base, 'tools'), { recursive: true });
  }

  // Give the module a fixture project directory and an isolated Electron process.resourcesPath.
  function resolver(resourcesPath) {
    const module = { exports: {} };
    const electronProcess = Object.assign(Object.create(process), { resourcesPath });
    evaluateTools(require, module, path.join(project, 'src'), electronProcess);
    return module.exports.resolveTool;
  }
  return { project, resources, resolver };
}

test('only yt-dlp and ffmpeg are accepted as tool names', t => {
  const { project, resolver } = toolEnvironment(t);
  const resolveTool = resolver(undefined);
  for (const name of ['yt-dlp', 'ffmpeg']) {
    const file = path.join(project, 'tools', executable(name));
    fs.writeFileSync(file, '');
    assert.equal(resolveTool(name), file);
  }
  for (const name of ['ffprobe', '../tools/ffmpeg', '']) {
    assert.throws(() => resolveTool(name), /不支持的工具/);
  }
});

test('a directory with the tool name is skipped in favor of a file', t => {
  const { project, resources, resolver } = toolEnvironment(t);
  const file = executable('ffmpeg');
  const projectFile = path.join(project, 'tools', file);
  fs.mkdirSync(path.join(resources, 'tools', file));
  const resolveTool = resolver(resources);
  assert.throws(() => resolveTool('ffmpeg'), /未找到 ffmpeg/);
  fs.writeFileSync(projectFile, '');
  assert.equal(resolveTool('ffmpeg'), projectFile);
});

test('an empty resourcesPath cannot select a tool from the working directory', t => {
  const { resources, resolver } = toolEnvironment(t);
  fs.writeFileSync(path.join(resources, 'tools', executable('yt-dlp')), '');
  const previousCwd = process.cwd();
  try {
    process.chdir(resources);
    for (const resourcesPath of [undefined, '']) {
      assert.throws(() => resolver(resourcesPath)('yt-dlp'), /未找到 yt-dlp/);
    }
  } finally {
    process.chdir(previousCwd);
  }
});

test('a tool in an absolute resourcesPath takes priority over the project copy', t => {
  const { project, resources, resolver } = toolEnvironment(t);
  const file = executable('yt-dlp');
  const packagedFile = path.join(resources, 'tools', file);
  fs.writeFileSync(path.join(project, 'tools', file), '');
  fs.writeFileSync(packagedFile, '');
  assert.equal(resolver(resources)('yt-dlp'), packagedFile);
});
