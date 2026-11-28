const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const STAGE_DIRECTORY = '.biligo-staging';
const MARKER_FILE = '.biligo-workspace.json';
const MARKER_KIND = 'BiliGoTaskWorkspace/v1';
const activeStages = new Set();

function pathKey(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
  const absolute = path.resolve(value);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function taskHash(taskId) {
  return createHash('sha256').update(taskId).digest('hex');
}

function warn(onWarning, error) {
  try { onWarning?.(error); } catch { /* A logging failure cannot undo a commit. */ }
}

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
  if (pathKey(target) === pathKey(root) || !isWithin(root, target)) throw new Error('任务暂存目录超出预期范围');
  if (!fs.existsSync(target)) return;
  assertDirectoryWithoutLink(root);
  assertDirectoryWithoutLink(target);

  function removeEntry(entry) {
    const absolute = path.resolve(entry);
    if (!isWithin(target, absolute)) throw new Error('任务暂存内容超出预期范围');
    const stat = fs.lstatSync(absolute);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const child of fs.readdirSync(absolute)) {
        if (absolute !== target || child !== MARKER_FILE) removeEntry(path.join(absolute, child));
      }
      if (absolute === target) fs.unlinkSync(path.join(absolute, MARKER_FILE));
      fs.rmdirSync(absolute);
    } else {
      fs.unlinkSync(absolute);
    }
  }

  removeEntry(target);
}

function assertWorkspaceMarker(root, stageDir, taskId) {
  assertDirectoryWithoutLink(root);
  assertDirectoryWithoutLink(path.dirname(stageDir));
  assertDirectoryWithoutLink(stageDir);
  const markerPath = path.join(stageDir, MARKER_FILE);
  let stored;
  try {
    if (!fs.lstatSync(markerPath).isFile()) throw new Error();
    stored = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    throw new Error('任务暂存目录缺少有效所有权标记');
  }
  if (stored?.kind !== MARKER_KIND || typeof stored.taskId !== 'string' || !stored.taskId.trim()
      || (taskId !== undefined && stored.taskId !== taskId)
      || pathKey(stored.root) !== pathKey(root) || pathKey(stored.stageDir) !== pathKey(stageDir)) {
    throw new Error('任务暂存目录的所有权标记不匹配');
  }
  const digest = taskHash(stored.taskId);
  const name = path.basename(pathKey(stageDir));
  if (name !== digest && name !== digest.slice(0, 16)) throw new Error('任务暂存目录的所有权标记不匹配');
}

function cleanupOrphanedWorkspaces(root, { onWarning } = {}) {
  if (!pathKey(root)) throw new Error('下载根目录必须为绝对路径');
  const stageRoot = path.join(root, STAGE_DIRECTORY);
  try {
    assertDirectoryWithoutLink(root);
    assertDirectoryWithoutLink(stageRoot);
    for (const entry of fs.readdirSync(stageRoot, { withFileTypes: true })) {
      const stageDir = path.join(stageRoot, entry.name);
      if (!entry.isDirectory() || activeStages.has(pathKey(stageDir))) continue;
      try {
        assertWorkspaceMarker(root, stageDir);
        removeOwnedTree(stageRoot, stageDir);
      } catch (error) { warn(onWarning, error); }
    }
    try { fs.rmdirSync(stageRoot); }
    catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
  } catch (error) { if (error.code !== 'ENOENT') warn(onWarning, error); }
}

function createTaskWorkspace({ destinationRoot, taskId, onWarning }) {
  if (typeof destinationRoot !== 'string' || !path.isAbsolute(destinationRoot)) throw new Error('下载根目录必须为绝对路径');
  if (typeof taskId !== 'string' || !taskId.trim()) throw new Error('任务 ID 无效');

  const root = path.resolve(destinationRoot);
  fs.mkdirSync(root, { recursive: true });
  assertDirectoryWithoutLink(root);
  const stageRoot = path.join(root, STAGE_DIRECTORY);
  fs.mkdirSync(stageRoot, { recursive: true });
  assertDirectoryWithoutLink(stageRoot);
  const stageDir = path.join(stageRoot, taskHash(taskId).slice(0, 16));
  const marker = { kind: MARKER_KIND, taskId, root, stageDir };
  const key = pathKey(stageDir);
  let released = false;
  if (activeStages.has(key)) throw new Error('任务暂存目录已被当前进程使用');

  function assertOwned() {
    if (released || !fs.existsSync(stageDir)) return false;
    assertWorkspaceMarker(root, stageDir, taskId);
    return true;
  }

  if (fs.existsSync(stageDir)) {
    if (!assertOwned()) throw new Error('任务暂存目录无效');
    removeOwnedTree(stageRoot, stageDir);
  }
  fs.mkdirSync(stageDir);
  fs.writeFileSync(path.join(stageDir, MARKER_FILE), JSON.stringify(marker), { flag: 'wx' });
  activeStages.add(key);

  function cleanup() {
    if (released) return;
    try {
      if (assertOwned()) removeOwnedTree(stageRoot, stageDir);
    } finally {
      released = true;
      activeStages.delete(key);
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
    assertDirectoryWithoutLink(root);
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
      // rename can replace an existing file. Reserve the name exclusively before publishing.
      const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.part`);
      try {
        await fs.promises.lstat(target);
        throw Object.assign(new Error('目标文件已存在'), { code: 'EEXIST' });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      let reserved = false;
      let ownTemporary = true;
      try {
        try { await fs.promises.copyFile(source, temporary, fs.constants.COPYFILE_EXCL); }
        catch (copyError) {
          if (copyError.code === 'EEXIST') ownTemporary = false;
          throw copyError;
        }
        const reservation = await fs.promises.open(target, 'wx');
        reserved = true;
        await reservation.close();
        await fs.promises.rename(temporary, target);
      } catch (publishError) {
        const discard = [];
        if (ownTemporary) discard.push(temporary);
        if (reserved) discard.push(target);
        for (const file of discard) {
          try { await fs.promises.unlink(file); }
          catch (unlinkError) { if (unlinkError.code !== 'ENOENT') warn(onWarning, unlinkError); }
        }
        throw publishError;
      }
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
    } catch (error) {
      const remaining = [];
      for (const file of committedFiles.reverse()) {
        try { await fs.promises.unlink(file); }
        catch (unlinkError) {
          if (unlinkError.code !== 'ENOENT') {
            remaining.push(file);
            warn(onWarning, unlinkError);
          }
        }
      }
      error.committedFiles = remaining.reverse();
      throw error;
    }
    try { cleanup(); } catch (error) { warn(onWarning, error); }
    return committedFiles;
  }

  return { stageDir, commit, cleanup };
}

module.exports = { createTaskWorkspace, cleanupOrphanedWorkspaces };
