'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isCompiledBinary } = require('./package-root');

const MARKER = 'forge-gh-router-v1';
const HELPER_NAME = 'forge-github-credential-v1';

function shellQuote(value) {
  return `'${String(value).replaceAll("'", String.raw`'\''`)}'`;
}

function shellPath(value) {
  return /^[A-Za-z]:[\\/]/.test(value) ? value.replaceAll('\\', '/') : value;
}

function findForgeLauncher(options = {}) {
  const platform = options.platform || process.platform;
  const pathValue = options.pathEnv ?? process.env.PATH ?? '';
  const names = platform === 'win32' ? ['forge.exe', 'forge.com', 'forge.bat', 'forge.cmd'] : ['forge'];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    const name = names.find(candidate => {
      try {
        fs.accessSync(path.join(directory, candidate), platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
        return true;
      } catch { return false; }
    });
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

function isOwnedFile(file) {
  try { return fs.readFileSync(file, 'utf8').includes(MARKER); } catch { return false; }
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

function installGithubRouter(options = {}) {
  const platform = options.platform || process.platform;
  const binDir = findForgeBinDir(options);
  assertRouterPrecedence(binDir, options);
  const files = contentsFor(platform, runtimeCommand(options));
  assertInstallTargetsAvailable(platform, binDir, files);
  const previous = new Map();
  const touched = new Set();
  const rollback = () => {
    for (const target of touched) {
      try {
        if (previous.has(target)) {
          const snapshot = previous.get(target);
          fs.writeFileSync(target, snapshot.content);
          fs.chmodSync(target, snapshot.mode);
        } else if (fs.existsSync(target)) fs.unlinkSync(target);
      } catch { /* best effort rollback */ }
    }
  };
  try {
    for (const [name, content] of files) {
      const target = path.join(binDir, name);
      if (fs.existsSync(target)) {
        const stat = fs.statSync(target);
        previous.set(target, { content: fs.readFileSync(target), mode: stat.mode });
      }
      touched.add(target);
      const mode = name.includes('.') ? 0o600 : 0o700;
      fs.writeFileSync(target, content, { mode });
      fs.chmodSync(target, mode);
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
  return result;
}

function uninstallGithubRouter(options = {}) {
  const platform = options.platform || process.platform;
  const names = platform === 'win32' ? ['gh', 'gh.cmd', 'gh.ps1', HELPER_NAME] : ['gh', HELPER_NAME];
  const directories = options.binDir
    ? [path.resolve(options.binDir)]
    : (options.pathEnv ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.resolve(directory));
  const removed = [];
  for (const binDir of new Set(directories)) {
    for (const name of names) {
      const target = path.join(binDir, name);
      if (!isOwnedFile(target)) continue;
      try { fs.unlinkSync(target); } catch (error) {
        if (error?.code === 'EACCES' || error?.code === 'EPERM') {
          const failure = new Error('Forge cannot remove its router files.');
          failure.code = 'GITHUB_ROUTER_PERMISSION';
          throw failure;
        }
        throw error;
      }
      removed.push(name);
    }
  }
  return { removed };
}

module.exports = { HELPER_NAME, MARKER, findForgeBinDir, findForgeLauncher, helperPathFromValue,
  getGithubRouterStatus, installGithubRouter, isOwnedCredentialHelperValue, isOwnedFile, uninstallGithubRouter };
