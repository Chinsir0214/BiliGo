const { execFile } = require('node:child_process');
const { readdirSync } = require('node:fs');
const { availableParallelism } = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const root = path.resolve(__dirname, '..');
const batchSize = Math.min(8, availableParallelism());
const run = promisify(execFile);

/** @returns {Generator<string>} */
function* findScripts(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      yield* findScripts(file);
    } else if (entry.isFile() && /\.m?js$/.test(entry.name)) {
      yield file;
    }
  }
}

async function checkFile(file) {
  try {
    const { stderr } = await run(process.execPath, ['--check', file], { windowsHide: true });
    if (stderr) process.stderr.write(stderr);
  } catch (error) {
    console.error(`Syntax check failed for ${path.relative(root, file)}`);
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

async function main() {
  const files = ['src', 'scripts', 'test'].flatMap(dir => [...findScripts(path.join(root, dir))]);
  for (let i = 0; i < files.length; i += batchSize) {
    await Promise.all(files.slice(i, i + batchSize).map(checkFile));
  }
  console.log(`Checked ${files.length} JavaScript files.`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
