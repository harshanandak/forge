#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const sourceDir = path.join(rootDir, '.github', 'agentic-workflows');
const targetDir = path.join(rootDir, '.github', 'workflows');

function syncFile(fileName, checkOnly) {
  const sourcePath = path.join(sourceDir, fileName);
  const targetPath = path.join(targetDir, fileName);
  const source = fs.readFileSync(sourcePath, 'utf8');
  const target = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : null;

  if (source === target) {
    return { changed: false, fileName };
  }

  if (checkOnly) {
    return { changed: true, fileName };
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, source);
  return { changed: true, fileName };
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const fileNames = fs.readdirSync(sourceDir).filter((file) => file === 'behavioral-test.md' || file === 'behavioral-test.lock.yml');
  const results = fileNames.map((fileName) => syncFile(fileName, checkOnly));
  const changed = results.filter((result) => result.changed);

  if (checkOnly && changed.length > 0) {
    console.error(`Agentic workflow files out of sync: ${changed.map((result) => result.fileName).join(', ')}`);
    process.exit(1);
  }

  if (changed.length === 0) {
    console.log('Agentic workflow files already in sync');
    return;
  }

  console.log(`Synced agentic workflow files: ${changed.map((result) => result.fileName).join(', ')}`);
}

main();
