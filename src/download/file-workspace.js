const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const STAGE_DIRECTORY = '.biligo-staging';
const MARKER_FILE = '.biligo-workspace.json';
const MARKER_KIND = 'BiliGoTaskWorkspace/v1';
const activeStages = new Set();

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertDirectoryWithoutLink(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`目录不是普通目录：${directory}`);
}

function removeOwnedTree(stageRoot, stageDir) {
  // Resolve and compare absolute paths before any recursive removal, including on Windows.
  const root = path.resolve(stageRoot);
  const target = path.resolve(stageDir);
  if (target === root || !isWithin(root, target)) throw new Error('任务暂存目录超出预期范围');
  if (!fs.existsSync(target)) return;
  assertDirectoryWithoutLink(root);
  assertDirectoryWithoutLink(target);

  function removeEntry(entry) {
    const absolute = path.resolve(entry);
    if (!isWithin(target, absolute)) throw new Error('任务暂存内容超出预期范围');
    const stat = fs.lstatSync(absolute);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const child of fs.readdirSync(absolute)) removeEntry(path.join(absolute, child));
      fs.rmdirSync(absolute);
    } else {
      fs.unlinkSync(absolute);
    }
  }

  removeEntry(target);
}

function createTaskWorkspace({ destinationRoot, taskId }) {
  if (typeof destinationRoot !== 'string' || !path.isAbsolute(destinationRoot)) throw new Error('下载根目录必须为绝对路径');
  if (typeof taskId !== 'string' || !taskId.trim()) throw new Error('任务 ID 无效');

  const root = path.resolve(destinationRoot);
  fs.mkdirSync(root, { recursive: true });
  assertDirectoryWithoutLink(root);
  const stageRoot = path.join(root, STAGE_DIRECTORY);
  fs.mkdirSync(stageRoot, { recursive: true });
  assertDirectoryWithoutLink(stageRoot);
  const stageDir = path.join(stageRoot, createHash('sha256').update(taskId).digest('hex'));
  const marker = { kind: MARKER_KIND, taskId, root, stageDir };
  if (activeStages.has(stageDir)) throw new Error('任务暂存目录已被当前进程使用');

  function assertOwned() {
    if (!fs.existsSync(stageDir)) return false;
    assertDirectoryWithoutLink(stageRoot);
    assertDirectoryWithoutLink(stageDir);
    const markerPath = path.join(stageDir, MARKER_FILE);
    let markerStat;
    try { markerStat = fs.lstatSync(markerPath); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      throw new Error('任务暂存目录缺少有效所有权标记');
    }
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error('任务暂存目录缺少有效所有权标记');
    let stored;
    try { stored = JSON.parse(fs.readFileSync(markerPath, 'utf8')); }
    catch (_) { throw new Error('任务暂存目录缺少有效所有权标记'); }
    if (stored.kind !== marker.kind || stored.taskId !== marker.taskId || stored.root !== marker.root || stored.stageDir !== marker.stageDir) {
      throw new Error('任务暂存目录的所有权标记不匹配');
    }
    return true;
  }

  if (fs.existsSync(stageDir)) {
    if (!assertOwned()) throw new Error('任务暂存目录无效');
    removeOwnedTree(stageRoot, stageDir);
  }
  fs.mkdirSync(stageDir);
  fs.writeFileSync(path.join(stageDir, MARKER_FILE), JSON.stringify(marker), { flag: 'wx' });
  activeStages.add(stageDir);

  function cleanup() {
    try {
      if (assertOwned()) removeOwnedTree(stageRoot, stageDir);
    } finally {
      activeStages.delete(stageDir);
    }
  }

  function outputFiles() {
    const files = [];
    function visit(directory) {
      for (const name of fs.readdirSync(directory)) {
        if (directory === stageDir && name === MARKER_FILE) continue;
        const file = path.join(directory, name);
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) throw new Error('任务产物不能包含符号链接');
        if (stat.isDirectory()) visit(file);
        else if (stat.isFile()) files.push(path.relative(stageDir, file));
        else throw new Error('任务产物包含不支持的文件类型');
      }
    }
    visit(stageDir);
    return files;
  }

  function ensureDestinationDirectory(directory) {
    const target = path.resolve(directory);
    if (!isWithin(root, target) || isWithin(stageRoot, target)) throw new Error('目标目录超出下载根目录');
    let current = root;
    const relative = path.relative(root, target);
    if (!relative) return;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      try { fs.mkdirSync(current); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      assertDirectoryWithoutLink(current);
    }
  }

  async function copyExclusively(source, target) {
    try {
      await fs.promises.link(source, target);
    } catch (error) {
      if (!['EXDEV', 'ENOSYS', 'EOPNOTSUPP', 'ENOTSUP', 'EPERM'].includes(error.code)) throw error;
      await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    }
  }

  async function commit(destination) {
    if (typeof destination !== 'string' || !path.isAbsolute(destination)) throw new Error('目标目录必须为绝对路径');
    if (!assertOwned()) throw new Error('任务暂存目录已不存在');
    const files = outputFiles();
    if (!files.length) throw new Error('任务没有生成文件');
    const committedFiles = [];
    try {
      ensureDestinationDirectory(destination);
      for (const relative of files) {
        const source = path.join(stageDir, relative);
        const targetDirectory = path.join(destination, path.dirname(relative));
        ensureDestinationDirectory(targetDirectory);
        const { name, ext } = path.parse(relative);
        for (let index = 1; ; index += 1) {
          const filename = index === 1 ? `${name}${ext}` : `${name} (${index})${ext}`;
          const target = path.join(targetDirectory, filename);
          try {
            await copyExclusively(source, target);
            committedFiles.push(target);
            break;
          } catch (error) {
            if (error.code !== 'EEXIST' || index >= 10000) throw error;
          }
        }
      }
      cleanup();
      return committedFiles;
    } catch (error) {
      error.committedFiles = committedFiles;
      throw error;
    }
  }

  return { stageDir, commit, cleanup };
}

module.exports = { createTaskWorkspace };
