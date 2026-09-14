'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isCompiledBinary } = require('./package-root');

const MARKER = 'forge-gh-router-v1';
const HELPER_NAME = 'forge-github-credential-v1';
const LOCK_NAME = '.forge-github-router.lock';
const LOCK_OWNER = 'owner.json';
const LOCK_RECOVERY = 'recovery';
const SHELL_SINGLE_QUOTE = String.raw`'\''`;

function isPackageRunnerBin(directory) {
  return path.basename(directory).toLowerCase() === '.bin'
    && path.basename(path.dirname(directory)).toLowerCase() === 'node_modules';
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", SHELL_SINGLE_QUOTE)}'`;
}

function shellPath(value) {
  return /^[A-Za-z]:[\\/]/.test(value) ? value.replaceAll('\\', '/') : value;
}

function isCurrentForgeLauncher(candidate, options) {
  const entrypoint = path.resolve(options.entrypointPath || process.argv[1]);
  try {
    if (fs.realpathSync(candidate) === fs.realpathSync(entrypoint)) return true;
  } catch { /* Windows package shims are wrappers rather than links */ }
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile() || stat.size > 64 * 1024) return false;
    const directory = path.dirname(candidate).replaceAll('\\', '/');
    const text = fs.readFileSync(candidate, 'utf8').replaceAll('\\', '/')
      .replaceAll(/%dp0%/gi, directory).replaceAll(/\$basedir\b/g, directory).toLowerCase();
    return text.includes(entrypoint.replaceAll('\\', '/').toLowerCase());
  } catch { return false; }
}

function findForgeLauncher(options = {}) {
  const platform = options.platform || process.platform;
  const pathValue = options.pathEnv ?? process.env.PATH ?? '';
  const names = platform === 'win32'
    ? ['forge-workflow.exe', 'forge-workflow.com', 'forge-workflow.bat', 'forge-workflow.cmd', 'forge.exe', 'forge.com', 'forge.bat', 'forge.cmd']
    : ['forge-workflow', 'forge'];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    const name = names.find(candidate => {
      try {
        const launcher = path.join(directory, candidate);
        fs.accessSync(launcher, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
        return (options.isForgeLauncher || isCurrentForgeLauncher)(launcher, options);
      } catch { return false; }
    });
    if (name && isPackageRunnerBin(directory)) {
      const error = new Error('Install Forge on a stable PATH before enabling automatic GitHub routing; npx and bunx launchers are temporary.');
      error.code = 'GITHUB_ROUTER_UNAVAILABLE';
      throw error;
    }
    if (name) return path.resolve(directory, name);
  }
  const error = new Error('Forge must be installed on PATH before automatic GitHub routing can be enabled.');
  error.code = 'GITHUB_ROUTER_UNAVAILABLE';
  throw error;
}

function findForgeBinDir(options = {}) {
  if (options.binDir) return path.resolve(options.binDir);
  if (options.compiled ?? isCompiledBinary()) return path.dirname(options.executablePath || process.execPath);
  return path.dirname(findForgeLauncher(options));
}

function runtimeCommand(options = {}) {
  if (options.runtimeCommand) return options.runtimeCommand;
  if (options.compiled ?? isCompiledBinary()) return [options.executablePath || process.execPath];
  if (!options.binDir) return [findForgeLauncher(options)];
  return [process.execPath, path.resolve(process.argv[1])];
}

function shellCommand(command) {
  return command.map(value => shellQuote(shellPath(value))).join(' ');
}

function cmdCommand(command) {
  return command.map(value => `"${String(value).replaceAll('"', '""')}"`).join(' ');
}

function powershellCommand(command) {
  return command.map(value => `'${String(value).replaceAll("'", "''")}'`).join(' ');
}

function contentsFor(platform, command) {
  const shell = shellCommand(command);
  const files = new Map([
    ['gh', `#!/bin/sh\n# ${MARKER}\nif [ "\${FORGE_GH_PROXY_ACTIVE:-}" = "1" ]; then echo "Forge GitHub router recursion blocked." >&2; exit 1; fi\nexport FORGE_GH_PROXY_ACTIVE=1\nexec ${shell} github proxy -- "$@"\n`],
    [HELPER_NAME, `#!/bin/sh\n# ${MARKER}\nexec ${shell} github credential "$@"\n`],
  ]);
  if (platform === 'win32') {
    const cmd = cmdCommand(command);
    const ps = powershellCommand(command);
    files.set('gh.cmd', `@echo off\r\nsetlocal\r\nrem ${MARKER}\r\nif "%FORGE_GH_PROXY_ACTIVE%"=="1" (echo Forge GitHub router recursion blocked. 1>&2 & exit /b 1)\r\nset "FORGE_GH_PROXY_ACTIVE=1"\r\ncall ${cmd} github proxy -- %*\r\nexit /b %ERRORLEVEL%\r\n`);
    files.set('gh.ps1', `# ${MARKER}\nif ($env:FORGE_GH_PROXY_ACTIVE -eq '1') { Write-Error 'Forge GitHub router recursion blocked.'; exit 1 }\n$previousForgeGhProxyActive = $env:FORGE_GH_PROXY_ACTIVE\n$forgeGhProxyExitCode = 1\ntry {\n  $env:FORGE_GH_PROXY_ACTIVE = '1'\n  & ${ps} github proxy -- @args\n  $forgeGhProxyExitCode = $LASTEXITCODE\n} finally {\n  if ($null -eq $previousForgeGhProxyActive) { Remove-Item Env:FORGE_GH_PROXY_ACTIVE -ErrorAction SilentlyContinue }\n  else { $env:FORGE_GH_PROXY_ACTIVE = $previousForgeGhProxyActive }\n}\nexit $forgeGhProxyExitCode\n`);
  }
  return files;
}

function isOwnedFile(file, fileSystem = fs) {
  try { return fileSystem.readFileSync(file, 'utf8').includes(MARKER); } catch { return false; }
}

function helperPathFromValue(value) {
  const match = typeof value === 'string' ? /^!'(.*)'$/.exec(value) : null;
  if (!match) return null;
  const helperPath = match[1].replaceAll(String.raw`'\''`, "'");
  const absolute = path.isAbsolute(helperPath) || path.win32.isAbsolute(helperPath);
  const basename = path.basename(helperPath) === HELPER_NAME || path.win32.basename(helperPath) === HELPER_NAME;
  return absolute && basename ? helperPath : null;
}

function isOwnedCredentialHelperValue(value) {
  const helperPath = helperPathFromValue(value);
  return Boolean(helperPath && isOwnedFile(helperPath));
}

function assertRouterPrecedence(binDir, options) {
  if (options.binDir) return;
  const platform = options.platform || process.platform;
  const names = platform === 'win32' ? ['gh.exe', 'gh.com', 'gh.bat', 'gh.cmd', 'gh.ps1', 'gh'] : ['gh'];
  const directories = (options.pathEnv ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const normalize = value => platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  for (const directory of directories) {
    if (normalize(directory) === normalize(binDir)) return;
    if (names.some(name => fs.existsSync(path.join(directory, name)))) {
      const error = new Error('A GitHub CLI executable appears before Forge on PATH.');
      error.code = 'GITHUB_ROUTER_SHADOWED';
      throw error;
    }
  }
  const error = new Error('Forge launcher directory is not on PATH.');
  error.code = 'GITHUB_ROUTER_UNAVAILABLE';
  throw error;
}

function getGithubRouterStatus(options = {}) {
  const platform = options.platform || process.platform;
  const names = platform === 'win32' ? ['gh.exe', 'gh.com', 'gh.bat', 'gh.cmd', 'gh.ps1', 'gh'] : ['gh'];
  const directories = (options.pathEnv ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (fs.existsSync(candidate)) return isOwnedFile(candidate) ? 'ready' : 'shadowed';
    }
  }
  return 'missing';
}

function assertInstallTargetsAvailable(platform, binDir, files) {
  const conflicts = platform === 'win32' ? ['gh.exe', 'gh.com', 'gh.bat'] : [];
  for (const name of conflicts) {
    if (fs.existsSync(path.join(binDir, name))) {
      const error = new Error(`A GitHub CLI launcher already exists beside Forge: ${name}`);
      error.code = 'GITHUB_ROUTER_CONFLICT';
      throw error;
    }
  }
  for (const name of files.keys()) {
    const target = path.join(binDir, name);
    if (fs.existsSync(target) && !isOwnedFile(target)) {
      const error = new Error(`Refusing to replace existing GitHub CLI launcher: ${target}`);
      error.code = 'GITHUB_ROUTER_CONFLICT';
      throw error;
    }
  }
}

function processIsRunning(pid, probe = process.kill.bind(process)) {
  try { probe(pid, 0); return true; } catch (error) { return error?.code !== 'ESRCH'; }
}

function readLockOwner(lock, fileSystem) {
  try {
    const owner = JSON.parse(fileSystem.readFileSync(path.join(lock, LOCK_OWNER), 'utf8'));
    return owner?.marker === MARKER && Number.isInteger(owner.pid) && owner.pid > 0 && typeof owner.token === 'string'
      ? owner : null;
  } catch { return null; }
}

function reclaimStaleRouterLock(lock, fileSystem, isRunning) {
  const owner = readLockOwner(lock, fileSystem);
  if (!owner || isRunning(owner.pid)) return false;
  const recovery = path.join(lock, LOCK_RECOVERY);
  try { fileSystem.mkdirSync(recovery); } catch { return false; }
  try {
    const current = readLockOwner(lock, fileSystem);
    if (!current || current.token !== owner.token || isRunning(current.pid)) return false;
    fileSystem.unlinkSync(path.join(lock, LOCK_OWNER));
    fileSystem.rmdirSync(recovery);
    fileSystem.rmdirSync(lock);
    return true;
  } finally {
    try { if (fileSystem.existsSync(recovery)) fileSystem.rmdirSync(recovery); } catch { /* another operation owns recovery */ }
  }
}

function publishRouterLock(lock, owner, fileSystem) {
  const candidate = `${lock}.${owner.pid}.${owner.token}.pending`;
  fileSystem.mkdirSync(candidate);
  try {
    fileSystem.writeFileSync(path.join(candidate, LOCK_OWNER), JSON.stringify(owner), { mode: 0o600, flag: 'wx' });
    if (fileSystem.existsSync(lock)) {
      const error = new Error('Router lock already exists.');
      error.code = 'EEXIST';
      throw error;
    }
    fileSystem.renameSync(candidate, lock);
  } catch (error) {
    try { if (fileSystem.existsSync(path.join(candidate, LOCK_OWNER))) fileSystem.unlinkSync(path.join(candidate, LOCK_OWNER)); } catch { /* preserve acquisition failure */ }
    try { if (fileSystem.existsSync(candidate)) fileSystem.rmdirSync(candidate); } catch { /* preserve acquisition failure */ }
    throw error;
  }
}

function acquireRouterLock(binDir, fileSystem = fs, isRunning = processIsRunning) {
  const lock = path.join(binDir, LOCK_NAME);
  const owner = { marker: MARKER, pid: process.pid, token: randomUUID() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      publishRouterLock(lock, owner, fileSystem);
      break;
    } catch (error) {
      if (!fileSystem.existsSync(lock)) throw error;
      if (attempt === 0 && reclaimStaleRouterLock(lock, fileSystem, isRunning)) continue;
      const failure = new Error('Another Forge GitHub router operation is in progress. Retry after it finishes; remove the lock only after confirming its owner is gone.');
      failure.code = 'GITHUB_ROUTER_BUSY';
      throw failure;
    }
  }
  const currentOwner = readLockOwner(lock, fileSystem);
  if (!currentOwner || currentOwner.token !== owner.token) {
    const failure = new Error('Another Forge GitHub router operation is in progress. Retry after it finishes; remove the lock only after confirming its owner is gone.');
    failure.code = 'GITHUB_ROUTER_BUSY';
    throw failure;
  }
  let held = true;
  return () => {
    if (!held) return;
    const current = readLockOwner(lock, fileSystem);
    if (!current || current.token !== owner.token) return;
    const released = `${lock}.${owner.token}.released`;
    fileSystem.renameSync(lock, released);
    held = false;
    try { fileSystem.unlinkSync(path.join(released, LOCK_OWNER)); } catch { /* lock is already released */ }
    try { fileSystem.rmdirSync(released); } catch { /* lock is already released */ }
  };
}

function stageRouterFile(target, content, mode, fileSystem = fs) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  fileSystem.writeFileSync(temporary, content, { mode, flag: 'wx' });
  fileSystem.chmodSync(temporary, mode);
  return temporary;
}

function replaceRouterFile(target, content, mode, fileSystem = fs) {
  const temporary = stageRouterFile(target, content, mode, fileSystem);
  try { fileSystem.renameSync(temporary, target); } finally {
    try { if (fileSystem.existsSync(temporary)) fileSystem.unlinkSync(temporary); } catch { /* preserve the publication failure */ }
  }
}

function installGithubRouter(options = {}) {
  const platform = options.platform || process.platform;
  const binDir = findForgeBinDir(options);
  assertRouterPrecedence(binDir, options);
  const files = contentsFor(platform, runtimeCommand(options));
  let releaseLock = () => {};
  let finalized = false;
  const previous = new Map();
  const touched = new Set();
  const rollback = () => {
    if (finalized) return;
    finalized = true;
    try {
      for (const target of touched) {
        try {
          if (previous.has(target)) {
            const snapshot = previous.get(target);
            replaceRouterFile(target, snapshot.content, snapshot.mode);
          } else if (fs.existsSync(target)) fs.unlinkSync(target);
        } catch { /* best effort rollback */ }
      }
    } finally {
      releaseLock();
    }
  };
  try {
    releaseLock = acquireRouterLock(binDir, fs, options.isProcessRunning);
    assertInstallTargetsAvailable(platform, binDir, files);
    const staged = [];
    try {
      for (const [name, content] of files) {
        const target = path.join(binDir, name);
        if (fs.existsSync(target)) {
          const stat = fs.statSync(target);
          previous.set(target, { content: fs.readFileSync(target), mode: stat.mode });
        }
        const mode = name.includes('.') ? 0o600 : 0o700;
        staged.push({ target, temporary: stageRouterFile(target, content, mode) });
      }
      for (const item of staged) {
        fs.renameSync(item.temporary, item.target);
        touched.add(item.target);
      }
    } finally {
      for (const item of staged) {
        try { if (fs.existsSync(item.temporary)) fs.unlinkSync(item.temporary); } catch { /* preserve the publication failure */ }
      }
    }
  } catch (error) {
    rollback();
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      const failure = new Error('Forge cannot write its launcher directory.');
      failure.code = 'GITHUB_ROUTER_PERMISSION';
      throw failure;
    }
    throw error;
  }
  const helperPath = shellPath(path.join(binDir, HELPER_NAME));
  const result = { binDir, credentialHelperValue: `!${shellQuote(helperPath)}` };
  Object.defineProperty(result, 'rollback', { value: rollback, enumerable: false });
  Object.defineProperty(result, 'commit', { value: () => {
    if (finalized) return {};
    finalized = true;
    try { releaseLock(); return {}; } catch {
      return { warning: 'Configuration applied; router lock cleanup failed.' };
    }
  }, enumerable: false });
  return result;
}

function ownedRouterTargets(binDirs, names, fileSystem) {
  const targets = [];
  for (const binDir of binDirs) {
    for (const name of names) {
      const target = path.join(binDir, name);
      if (!fileSystem.existsSync(target)) continue;
      const content = fileSystem.readFileSync(target);
      if (content.includes(MARKER)) targets.push({ name, target, content, mode: fileSystem.statSync(target).mode });
    }
  }
  return targets;
}

function ownedRouterDirectories(directories, names, fileSystem, platform) {
  const owned = new Map();
  for (const directory of directories) {
    let canonical;
    try { canonical = fileSystem.realpathSync(directory); } catch { continue; }
    if (!names.some(name => isOwnedFile(path.join(canonical, name), fileSystem))) continue;
    const key = platform === 'win32' ? canonical.toLowerCase() : canonical;
    owned.set(key, canonical);
  }
  return [...owned.values()].sort((left, right) => left.localeCompare(right));
}

function restoreRouterTargets(removed, fileSystem) {
  for (const item of removed.toReversed()) {
    try {
      if (!fileSystem.existsSync(item.target)) {
        replaceRouterFile(item.target, item.content, item.mode, fileSystem);
      }
    } catch { /* preserve the original removal failure */ }
  }
}

function uninstallGithubRouter(options = {}) {
  const platform = options.platform || process.platform;
  const fileSystem = options.fileSystem || fs;
  const names = platform === 'win32' ? ['gh', 'gh.cmd', 'gh.ps1', HELPER_NAME] : ['gh', HELPER_NAME];
  const directories = options.binDir
    ? [path.resolve(options.binDir)]
    : (options.pathEnv ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.resolve(directory));
  const releaseLocks = [];
  let warning;
  let targets;
  const removed = [];
  try {
    const binDirs = ownedRouterDirectories(directories, names, fileSystem, platform);
    for (const binDir of binDirs) releaseLocks.push(acquireRouterLock(binDir, fileSystem, options.isProcessRunning));
    targets = ownedRouterTargets(binDirs, names, fileSystem);
    for (const item of targets) {
      fileSystem.unlinkSync(item.target);
      removed.push(item);
    }
  } catch (error) {
    restoreRouterTargets(removed, fileSystem);
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      const failure = new Error('Forge cannot remove its router files.');
      failure.code = 'GITHUB_ROUTER_PERMISSION';
      throw failure;
    }
    throw error;
  } finally {
    for (const release of releaseLocks.toReversed()) {
      try { release(); } catch { warning = 'Router files were processed, but lock cleanup failed.'; }
    }
  }
  return { removed: targets.map(item => item.name), ...(warning ? { warning } : {}) };
}

module.exports = { HELPER_NAME, MARKER, findForgeBinDir, findForgeLauncher, helperPathFromValue,
  getGithubRouterStatus, installGithubRouter, isOwnedCredentialHelperValue, isOwnedFile, uninstallGithubRouter };
