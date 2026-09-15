'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { isCompiledBinary } = require('./package-root');

const MARKER = 'forge-gh-router-v1';
const HELPER_NAME = 'forge-github-credential-v1';
const LOCK_NAME = '.forge-github-router.lock';
const REGISTRY_LOCK_NAME = '.forge-github-router-registry.lock';
const LOCK_OWNER = 'owner.json';
const LOCK_RECOVERY = 'recovery';
const REGISTRY_MARKER = 'forge-github-router-registry-v1';
const REGISTRY_NAME = 'github-router-clones.json';
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
  const platformPath = (options.platform || process.platform) === 'win32' ? path.win32 : path.posix;
  const entrypoint = platformPath.resolve(options.entrypointPath || process.argv[1]);
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

function runtimeCommands(options = {}) {
  const compiled = options.compiled ?? isCompiledBinary();
  if (!options.runtimeCommand && !compiled) {
    return {
      credential: [process.execPath, options.credentialEntrypointPath || path.resolve(__dirname, '../bin/forge-github-credential.js')],
      proxy: [process.execPath, options.proxyEntrypointPath || path.resolve(__dirname, '../bin/forge-gh-proxy.js')],
    };
  }
  const forge = options.runtimeCommand || [options.executablePath || process.execPath];
  return {
    credential: [...forge, 'github', 'credential'],
    proxy: [...forge, 'github', 'proxy'],
  };
}

function shellCommand(command) {
  return command.map(value => shellQuote(shellPath(value))).join(' ');
}

function cmdCommand(command) {
  return command.map(value => `"${String(value).replaceAll('%', '%%').replaceAll('"', '""')}"`).join(' ');
}

function powershellCommand(command) {
  return command.map(value => `'${String(value).replaceAll("'", "''")}'`).join(' ');
}

function contentsFor(platform, commands) {
  const proxyShell = shellCommand(commands.proxy);
  const credentialShell = shellCommand(commands.credential);
  const files = new Map([
    ['gh', `#!/bin/sh\n# ${MARKER}\nif [ "\${FORGE_GH_PROXY_ACTIVE:-}" = "1" ]; then echo "Forge GitHub router recursion blocked." >&2; exit 1; fi\nexport FORGE_GH_PROXY_ACTIVE=1\nexec ${proxyShell} -- "$@"\n`],
    [HELPER_NAME, `#!/bin/sh\n# ${MARKER}\nexec ${credentialShell} "$@"\n`],
  ]);
  if (platform === 'win32') {
    const proxyCmd = cmdCommand(commands.proxy);
    const proxyPs = powershellCommand(commands.proxy);
    files.set('gh.cmd', `@echo off\r\nsetlocal\r\nrem ${MARKER}\r\nif "%FORGE_GH_PROXY_ACTIVE%"=="1" (echo Forge GitHub router recursion blocked. 1>&2 & exit /b 1)\r\nset "FORGE_GH_PROXY_ACTIVE=1"\r\n${proxyCmd} -- %*\r\nexit /b %ERRORLEVEL%\r\n`);
    files.set('gh.ps1', `# ${MARKER}\nif ($env:FORGE_GH_PROXY_ACTIVE -eq '1') { Write-Error 'Forge GitHub router recursion blocked.'; exit 1 }\n$previousForgeGhProxyActive = $env:FORGE_GH_PROXY_ACTIVE\n$forgeGhProxyExitCode = 1\ntry {\n  $env:FORGE_GH_PROXY_ACTIVE = '1'\n  & ${proxyPs} -- @args\n  $forgeGhProxyExitCode = $LASTEXITCODE\n} finally {\n  if ($null -eq $previousForgeGhProxyActive) { Remove-Item Env:FORGE_GH_PROXY_ACTIVE -ErrorAction SilentlyContinue }\n  else { $env:FORGE_GH_PROXY_ACTIVE = $previousForgeGhProxyActive }\n}\nexit $forgeGhProxyExitCode\n`);
  }
  return files;
}

function isOwnedFile(file, fileSystem = fs) {
  try { return fileSystem.readFileSync(file, 'utf8').includes(MARKER); } catch { return false; }
}

function isCurrentGeneratedFile(file, name, options = {}) {
  const platform = options.platform || process.platform;
  const fileSystem = options.fs || fs;
  try {
    const commands = runtimeCommands(options);
    const command = name === HELPER_NAME ? commands.credential : commands.proxy;
    if (!command?.length || !(path.posix.isAbsolute(command[0]) || path.win32.isAbsolute(command[0]))) return false;
    for (let index = 0; index < command.length; index += 1) {
      const target = command[index];
      if (!path.posix.isAbsolute(target) && !path.win32.isAbsolute(target)) continue;
      if (!fileSystem.statSync(target).isFile()) return false;
      const mode = index === 0 && platform !== 'win32' ? fs.constants.X_OK : fs.constants.R_OK;
      fileSystem.accessSync(target, mode);
    }
    return fileSystem.readFileSync(file, 'utf8') === contentsFor(platform, commands).get(name);
  } catch { return false; }
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

function isManagedCredentialHelperValue(value, options = {}) {
  const helperPath = helperPathFromValue(value);
  const fileSystem = options.fs || fs;
  if (!helperPath) return false;
  if (isOwnedFile(helperPath, fileSystem)) return true;
  try {
    fileSystem.statSync(helperPath);
    return false;
  } catch (error) {
    if (error?.code !== 'ENOENT') return false;
  }
  try {
    const platform = options.platform || process.platform;
    const pathImpl = platform === 'win32' ? path.win32 : path.posix;
    const normalize = target => platform === 'win32' ? pathImpl.resolve(target).toLowerCase() : pathImpl.resolve(target);
    const binDir = options.binDir ? pathImpl.resolve(options.binDir) : findForgeBinDir(options);
    return normalize(helperPath) === normalize(pathImpl.join(binDir, HELPER_NAME));
  } catch { return false; }
}

function isExecutableFile(file, platform, fileSystem) {
  if (platform === 'win32') return true;
  try { fileSystem.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
}

function isUsableCredentialHelperValue(value, options = {}) {
  const helperPath = helperPathFromValue(value);
  const fileSystem = options.fs || fs;
  return Boolean(helperPath && isOwnedFile(helperPath, fileSystem)
    && isExecutableFile(helperPath, options.platform || process.platform, fileSystem)
    && (options.isCurrentRouterFile || isCurrentGeneratedFile)(helperPath, HELPER_NAME, options));
}

function assertRouterPrecedence(binDir, options) {
  if (options.binDir) return;
  const platform = options.platform || process.platform;
  const fileSystem = options.fs || fs;
  const names = platform === 'win32' ? ['gh.exe', 'gh.com', 'gh.bat', 'gh.cmd', 'gh.ps1', 'gh'] : ['gh'];
  const directories = (options.pathEnv ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const normalize = value => platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  for (const directory of directories) {
    if (normalize(directory) === normalize(binDir)) return;
    if (names.some(name => {
      const candidate = path.join(directory, name);
      return fileSystem.existsSync(candidate) && isExecutableFile(candidate, platform, fileSystem);
    })) {
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
  const fileSystem = options.fs || fs;
  const names = platform === 'win32' ? ['gh.exe', 'gh.com', 'gh.bat', 'gh.cmd', 'gh.ps1', 'gh'] : ['gh'];
  const directories = (options.pathEnv ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  let ownedUnusable = false;
  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (fileSystem.existsSync(candidate)) {
        if (!isExecutableFile(candidate, platform, fileSystem)) {
          ownedUnusable ||= isOwnedFile(candidate, fileSystem);
          continue;
        }
        if (!isOwnedFile(candidate, fileSystem)) return 'shadowed';
        return (options.isCurrentRouterFile || isCurrentGeneratedFile)(candidate, name, options) ? 'ready' : 'unusable';
      }
    }
  }
  return ownedUnusable ? 'unusable' : 'missing';
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

function acquireRouterLock(binDir, fileSystem = fs, isRunning = processIsRunning, lockName = LOCK_NAME) {
  const lock = path.join(binDir, lockName);
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

function releaseRouterLocks(releases) {
  let failure;
  for (const release of releases.toReversed()) {
    try { release(); } catch (error) { failure ||= error; }
  }
  if (failure) throw failure;
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

function registryPath(options = {}) {
  return options.registryPath || path.join(options.stateDir || path.join(os.homedir(), '.forge'), REGISTRY_NAME);
}

function acquireRegistryLock(options = {}) {
  const fileSystem = options.fileSystem || fs;
  const directory = path.dirname(registryPath(options));
  fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return acquireRouterLock(directory, fileSystem, options.isProcessRunning, REGISTRY_LOCK_NAME);
}

function registryFailure(message = 'Forge cannot verify its automatic-routing registry.') {
  const error = new Error(message);
  error.code = 'GITHUB_ROUTER_REGISTRY_INVALID';
  return error;
}

function pathImplementation(options) {
  return (options.registryPlatform || process.platform) === 'win32' ? path.win32 : path.posix;
}

function canonicalPath(value, options = {}) {
  if (typeof value !== 'string' || !value) throw registryFailure();
  const pathImpl = pathImplementation(options);
  if (!pathImpl.isAbsolute(value)) throw registryFailure();
  const fileSystem = options.fileSystem || fs;
  const absolute = pathImpl.resolve(value);
  try {
    const realpath = fileSystem.realpathSync.native || fileSystem.realpathSync;
    return realpath(absolute);
  } catch { return absolute; }
}

function registryKey(value, options = {}) {
  const normalized = value.replaceAll('\\', '/');
  return (options.registryPlatform || process.platform) === 'win32' ? normalized.toLowerCase() : normalized;
}

function runRegistryGit(args, options = {}, preserveTrailing = false) {
  const run = options.registryRunner || execFileSync;
  const output = String(run('git', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 3000,
  }) || '');
  return preserveTrailing ? output : output.trimEnd();
}

function resolveGitCommonDir(projectRoot, options = {}) {
  if (options.gitCommonDir) return canonicalPath(options.gitCommonDir, options);
  try {
    const value = runRegistryGit(['-C', projectRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], options);
    return canonicalPath(value, options);
  } catch { throw registryFailure('Forge cannot resolve this clone\'s Git common directory.'); }
}

function resolveCloneIdentity(projectRoot, options = {}) {
  let identity;
  try {
    identity = options.resolveCloneIdentity
      ? options.resolveCloneIdentity(projectRoot)
      : {
          root: runRegistryGit(['-C', projectRoot, 'rev-parse', '--show-toplevel'], options),
          gitCommonDir: resolveGitCommonDir(projectRoot, options),
        };
    return {
      root: canonicalPath(identity.root, options),
      gitCommonDir: canonicalPath(identity.gitCommonDir, options),
    };
  } catch (error) {
    if (error?.code === 'GITHUB_ROUTER_REGISTRY_INVALID') throw error;
    throw registryFailure('Forge cannot resolve this clone for automatic routing.');
  }
}

function parseRegistry(content, options = {}) {
  let parsed;
  try { parsed = JSON.parse(content); } catch { throw registryFailure(); }
  if (parsed?.marker !== REGISTRY_MARKER || !Array.isArray(parsed.clones)) throw registryFailure();
  const seen = new Set();
  const clones = parsed.clones.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).some(key => !['root', 'gitCommonDir'].includes(key))) throw registryFailure();
    const clone = {
      root: canonicalPath(entry.root, options),
      gitCommonDir: canonicalPath(entry.gitCommonDir, options),
    };
    const key = registryKey(clone.gitCommonDir, options);
    if (seen.has(key)) throw registryFailure();
    seen.add(key);
    return clone;
  });
  return { marker: REGISTRY_MARKER, clones };
}

function readRegistry(options = {}, allowMissing = false) {
  const fileSystem = options.fileSystem || fs;
  try { return parseRegistry(fileSystem.readFileSync(registryPath(options), 'utf8'), options); } catch (error) {
    if (error?.code === 'ENOENT' && allowMissing) return null;
    if (error?.code === 'GITHUB_ROUTER_REGISTRY_INVALID') throw error;
    throw registryFailure();
  }
}

function writeRegistry(registry, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const target = registryPath(options);
  fileSystem.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const clones = [...registry.clones].sort((left, right) => registryKey(left.gitCommonDir, options)
    .localeCompare(registryKey(right.gitCommonDir, options)));
  replaceRouterFile(target, `${JSON.stringify({ marker: REGISTRY_MARKER, clones }, null, 2)}\n`, 0o600, fileSystem);
}

function snapshotRegistry(options = {}) {
  const fileSystem = options.fileSystem || fs;
  const target = registryPath(options);
  try {
    const stat = fileSystem.statSync(target);
    return { content: fileSystem.readFileSync(target), mode: stat.mode };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw registryFailure();
  }
}

function restoreRegistry(snapshot, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const target = registryPath(options);
  if (snapshot) replaceRouterFile(target, snapshot.content, snapshot.mode, fileSystem);
  else {
    try { fileSystem.unlinkSync(target); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
}

function registerClone(registry, identity, options = {}) {
  const key = registryKey(identity.gitCommonDir, options);
  return { marker: REGISTRY_MARKER,
    clones: [...registry.clones.filter(entry => registryKey(entry.gitCommonDir, options) !== key), identity] };
}

function registryForRegistration(binDir, options = {}) {
  const registry = readRegistry(options, true);
  if (registry) return registry;
  const platform = options.platform || process.platform;
  const names = platform === 'win32' ? ['gh', 'gh.cmd', 'gh.ps1', HELPER_NAME] : ['gh', HELPER_NAME];
  const directories = [binDir];
  if (options.pathEnv !== undefined || !options.binDir) {
    directories.push(...(options.pathEnv ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean));
  }
  if (ownedRouterTargets([...new Set(directories.map(directory => path.resolve(directory)))], names,
    options.fileSystem || fs).length) {
    throw registryFailure('Forge router files exist but the automatic-routing registry is missing.');
  }
  return { marker: REGISTRY_MARKER, clones: [] };
}

function unregisterClone(registry, gitCommonDir, options = {}) {
  const key = registryKey(gitCommonDir, options);
  return { marker: REGISTRY_MARKER,
    clones: registry.clones.filter(entry => registryKey(entry.gitCommonDir, options) !== key) };
}

function releaseWithWarning(release, message) {
  try { release(); return {}; } catch { return { warning: message }; }
}

function registerGithubRouterClone(projectRoot, options = {}) {
  const binDir = findForgeBinDir(options);
  const releases = [];
  let warning;
  try {
    releases.push(acquireRouterLock(binDir, options.fileSystem || fs, options.isProcessRunning));
    releases.push(acquireRegistryLock(options));
    const registry = registryForRegistration(binDir, options);
    writeRegistry(registerClone(registry, resolveCloneIdentity(projectRoot, options), options), options);
  } finally {
    warning = releaseWithWarning(() => releaseRouterLocks(releases), 'Clone registered, but router lock cleanup failed.').warning;
  }
  return warning ? { warning } : {};
}

function unregisterGithubRouterClone(projectRoot, options = {}) {
  const binDir = findForgeBinDir(options);
  const releases = [];
  let warning;
  try {
    releases.push(acquireRouterLock(binDir, options.fileSystem || fs, options.isProcessRunning));
    releases.push(acquireRegistryLock(options));
    const registry = readRegistry(options, true);
    if (registry) writeRegistry(unregisterClone(registry, resolveGitCommonDir(projectRoot, options), options), options);
  } finally {
    warning = releaseWithWarning(() => releaseRouterLocks(releases), 'Clone unregistered, but router lock cleanup failed.').warning;
  }
  return warning ? { warning } : {};
}

function assertGithubRouterCloneRegistered(projectRoot, options = {}) {
  const gitCommonDir = resolveGitCommonDir(projectRoot, options);
  const key = registryKey(gitCommonDir, options);
  const registered = readRegistry(options).clones.some(entry => registryKey(entry.gitCommonDir, options) === key);
  if (!registered) throw registryFailure('This clone is not registered for automatic GitHub routing.');
  return true;
}

function directoryState(directory, options) {
  try { return (options.fileSystem || fs).statSync(directory).isDirectory() ? 'present' : 'missing'; } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    throw registryFailure();
  }
}

function registeredAutoState(entry, options) {
  if (directoryState(entry.gitCommonDir, options) === 'missing') {
    throw registryFailure('Forge cannot verify a registered clone because its Git directory is unavailable.');
  }
  let output;
  try {
    output = runRegistryGit(['--git-dir', entry.gitCommonDir, 'config', '--local', '--get-all', 'github.auto'], options, true);
  } catch (error) {
    if (error?.status === 1) return 'disabled';
    throw registryFailure('Forge cannot verify whether a registered clone still uses automatic routing.');
  }
  const values = output.replace(/\r?\n$/, '').split(/\r?\n/);
  if (values.length === 1 && values[0].toLowerCase() === 'true') return 'enabled';
  if (values.length === 1 && values[0].toLowerCase() === 'false') return 'disabled';
  throw registryFailure('A registered clone has invalid automatic-routing state.');
}

function usableRoot(entry, options) {
  if (directoryState(entry.root, options) === 'present') return canonicalPath(entry.root, options);
  const pathImpl = pathImplementation(options);
  const mainRoot = pathImpl.basename(entry.gitCommonDir).toLowerCase() === '.git'
    ? pathImpl.dirname(entry.gitCommonDir) : null;
  return mainRoot && directoryState(mainRoot, options) === 'present' ? canonicalPath(mainRoot, options) : entry.root;
}

function pruneRegistry(options = {}, allowMissing = false) {
  const registry = readRegistry(options, allowMissing);
  if (!registry) return { marker: REGISTRY_MARKER, clones: [] };
  const active = [];
  for (const entry of registry.clones) {
    if (registeredAutoState(entry, options) === 'enabled') active.push({ ...entry, root: usableRoot(entry, options) });
  }
  const pruned = { marker: REGISTRY_MARKER, clones: active };
  writeRegistry(pruned, options);
  return pruned;
}

function installGithubRouter(options = {}) {
  const platform = options.platform || process.platform;
  const binDir = findForgeBinDir(options);
  assertRouterPrecedence(binDir, options);
  const files = contentsFor(platform, runtimeCommands(options));
  const releaseLocks = [];
  let finalized = false;
  let registrySnapshot;
  let registryTouched = false;
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
      if (registryTouched) {
        try { restoreRegistry(registrySnapshot, options); } catch { /* best effort rollback */ }
      }
    } finally {
      releaseRouterLocks(releaseLocks);
    }
  };
  try {
    releaseLocks.push(acquireRouterLock(binDir, fs, options.isProcessRunning));
    if (options.projectRoot) {
      releaseLocks.push(acquireRegistryLock(options));
      registrySnapshot = snapshotRegistry(options);
      const registry = registryForRegistration(binDir, options);
      writeRegistry(registerClone(registry, resolveCloneIdentity(options.projectRoot, options), options), options);
      registryTouched = true;
    }
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
    try { releaseRouterLocks(releaseLocks); return {}; } catch {
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
    let binDirs = ownedRouterDirectories(directories, names, fileSystem, platform);
    if (binDirs.length === 0) {
      const fallback = options.binDir ? path.resolve(options.binDir) : findForgeBinDir(options);
      binDirs = [fileSystem.realpathSync(fallback)];
    }
    for (const binDir of binDirs) releaseLocks.push(acquireRouterLock(binDir, fileSystem, options.isProcessRunning));
    targets = ownedRouterTargets(binDirs, names, fileSystem);
    releaseLocks.push(acquireRegistryLock({ ...options, fileSystem }));
    const registry = pruneRegistry({ ...options, fileSystem }, targets.length === 0);
    if (registry.clones.length) {
      const failure = new Error('Automatic routing remains enabled in one or more registered clones.');
      failure.code = 'GITHUB_ROUTER_IN_USE';
      throw failure;
    }
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
    try { releaseRouterLocks(releaseLocks); } catch { warning = 'Router files were processed, but lock cleanup failed.'; }
  }
  return { removed: targets.map(item => item.name), ...(warning ? { warning } : {}) };
}

module.exports = { HELPER_NAME, MARKER, assertGithubRouterCloneRegistered, findForgeBinDir, findForgeLauncher,
  helperPathFromValue, getGithubRouterStatus, installGithubRouter, isOwnedCredentialHelperValue, isOwnedFile,
  isManagedCredentialHelperValue, isUsableCredentialHelperValue,
  registerGithubRouterClone, unregisterGithubRouterClone, uninstallGithubRouter };
