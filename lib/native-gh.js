'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isCompiledBinary } = require('./package-root');

const ROUTER_MARKER = 'forge-gh-router-v1';

function environmentValue(environment, name) {
  const key = Object.keys(environment).find(candidate => candidate.toUpperCase() === name);
  return key ? environment[key] : undefined;
}

function isForgeProxy(candidate, ownPath) {
  const candidatePath = fs.realpathSync(candidate);
  try {
    if (candidatePath === fs.realpathSync(ownPath)) return true;
  } catch { /* compiled Bun entrypoints may not exist on the host filesystem */ }
  const stat = fs.statSync(candidatePath);
  if (!stat.isFile()) throw new Error('GitHub CLI candidate is not a file.');
  if (stat.size > 64 * 1024) return false;
  const text = fs.readFileSync(candidatePath, 'utf8').replaceAll('\\', '/').toLowerCase();
  return text.includes(ROUTER_MARKER) || (text.includes('forge-workflow') && text.includes('/bin/gh.js'));
}

function resolveRealGh(options = {}) {
  const platform = options.platform || process.platform;
  const environment = options.env || process.env;
  const pathValue = options.pathEnv ?? environmentValue(environment, 'PATH') ?? '';
  const ownPath = options.ownPath ?? (isCompiledBinary() ? process.execPath : process.argv[1]);
  const extensions = platform === 'win32'
    ? (options.pathExt || environmentValue(environment, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `gh${extension.toLowerCase()}`);
      try {
        fs.accessSync(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
        if (!isForgeProxy(candidate, ownPath)) return candidate;
      } catch { /* keep searching */ }
    }
  }
  return null;
}

module.exports = { isForgeProxy, resolveRealGh };
