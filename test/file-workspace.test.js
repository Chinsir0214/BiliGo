const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTaskWorkspace } = require('../src/download/file-workspace');

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'biligo-workspace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('commits multiple outputs without overwriting a destination file', async t => {
  const root = temporaryRoot(t);
  const destination = path.join(root, 'Collection');
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination, 'episode.mp4'), 'original video');
  const workspace = createTaskWorkspace({ destinationRoot: root, taskId: 'task-one' });
  fs.writeFileSync(path.join(workspace.stageDir, 'episode.mp4'), 'new video');
  fs.mkdirSync(path.join(workspace.stageDir, 'subtitles'));
  fs.writeFileSync(path.join(workspace.stageDir, 'subtitles', 'episode.zh.srt'), 'new subtitles');

  const files = await workspace.commit(destination);

  assert.deepEqual(files.sort(), [
    path.join(destination, 'episode (2).mp4'),
    path.join(destination, 'subtitles', 'episode.zh.srt')
  ].sort());
  assert.equal(fs.readFileSync(path.join(destination, 'episode.mp4'), 'utf8'), 'original video');
  assert.equal(fs.readFileSync(path.join(destination, 'episode (2).mp4'), 'utf8'), 'new video');
  assert.equal(fs.readFileSync(path.join(destination, 'subtitles', 'episode.zh.srt'), 'utf8'), 'new subtitles');
  assert.equal(fs.existsSync(workspace.stageDir), false);
  workspace.cleanup();
});

test('cancel cleanup removes only this task stage', t => {
  const root = temporaryRoot(t);
  const destination = path.join(root, 'Collection');
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination, 'existing.mp4'), 'keep me');
  const first = createTaskWorkspace({ destinationRoot: root, taskId: 'cancel-me' });
  const other = createTaskWorkspace({ destinationRoot: root, taskId: 'another-task' });
  fs.writeFileSync(path.join(first.stageDir, 'partial.part'), 'partial');
  fs.writeFileSync(path.join(other.stageDir, 'other.part'), 'other');

  first.cleanup();

  assert.equal(fs.existsSync(first.stageDir), false);
  assert.equal(fs.readFileSync(path.join(other.stageDir, 'other.part'), 'utf8'), 'other');
  assert.equal(fs.readFileSync(path.join(destination, 'existing.mp4'), 'utf8'), 'keep me');
  other.cleanup();
});

test('a restarted task removes its own stale stage before downloading again', async t => {
  const root = temporaryRoot(t);
  const first = createTaskWorkspace({ destinationRoot: root, taskId: 'resume-me' });
  fs.writeFileSync(path.join(first.stageDir, 'old.part'), 'obsolete');

  // Loading the module again models a new app process with no in-memory active task set.
  const modulePath = require.resolve('../src/download/file-workspace');
  delete require.cache[modulePath];
  const { createTaskWorkspace: createAfterRestart } = require('../src/download/file-workspace');
  const resumed = createAfterRestart({ destinationRoot: root, taskId: 'resume-me' });

  assert.equal(resumed.stageDir, first.stageDir);
  assert.equal(fs.existsSync(path.join(resumed.stageDir, 'old.part')), false);
  fs.writeFileSync(path.join(resumed.stageDir, 'new.mp4'), 'fresh');
  assert.deepEqual(await resumed.commit(root), [path.join(root, 'new.mp4')]);
  assert.equal(fs.readFileSync(path.join(root, 'new.mp4'), 'utf8'), 'fresh');
});

test('rejects unowned stage and destinations outside the chosen root', async t => {
  const root = temporaryRoot(t);
  const workspace = createTaskWorkspace({ destinationRoot: root, taskId: 'guarded' });
  fs.writeFileSync(path.join(workspace.stageDir, 'video.mp4'), 'video');
  await assert.rejects(workspace.commit(path.dirname(root)), /目标目录超出下载根目录/);
  fs.writeFileSync(path.join(workspace.stageDir, '.biligo-workspace.json'), '{}');
  assert.throws(() => workspace.cleanup(), /所有权标记不匹配/);
  assert.equal(fs.existsSync(path.join(workspace.stageDir, 'video.mp4')), true);
});

test('unsupported hard links use asynchronous exclusive copies and preserve earlier outputs on failure', async t => {
  const root = temporaryRoot(t);
  const workspace = createTaskWorkspace({ destinationRoot: root, taskId: 'copy-fallback' });
  fs.writeFileSync(path.join(workspace.stageDir, 'a.mp4'), 'fresh');
  fs.writeFileSync(path.join(workspace.stageDir, 'b.srt'), 'subtitles');
  fs.writeFileSync(path.join(root, 'a.mp4'), 'existing');
  fs.writeFileSync(path.join(root, 'b.srt'), 'existing');
  t.mock.method(fs.promises, 'link', async () => { throw Object.assign(new Error(), { code: 'EPERM' }); });
  const copyFile = fs.promises.copyFile;
  let firstOutput;
  t.mock.method(fs.promises, 'copyFile', async (source, target, flags) => {
    assert.equal(flags, fs.constants.COPYFILE_EXCL);
    if (firstOutput) throw new Error('disk full');
    await copyFile(source, target, flags);
    firstOutput = target;
  });
  await assert.rejects(workspace.commit(root), error => {
    assert.match(error.message, /disk full/);
    assert.deepEqual(error.committedFiles, [firstOutput]);
    return true;
  });
  assert.equal(fs.readFileSync(path.join(root, 'a.mp4'), 'utf8'), 'existing');
  assert.equal(fs.readFileSync(path.join(root, 'b.srt'), 'utf8'), 'existing');
  assert.match(path.basename(firstOutput), / \(2\)\.(mp4|srt)$/);
  assert.equal(fs.readFileSync(firstOutput, 'utf8'), firstOutput.endsWith('.mp4') ? 'fresh' : 'subtitles');
  workspace.cleanup();
});
