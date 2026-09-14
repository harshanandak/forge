'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const spawn = require('cross-spawn');
const { createGithubContext, readGithubAuto } = require('./github-context');

const ROUTER_MARKER = 'forge-gh-router-v1';

function isForgeProxy(candidate, ownPath) {
  try {
    if (fs.realpathSync(candidate) === fs.realpathSync(ownPath)) return true;
    const stat = fs.statSync(candidate);
    if (stat.size > 64 * 1024) return false;
    const text = fs.readFileSync(candidate, 'utf8').replaceAll('\\', '/').toLowerCase();
    return text.includes(ROUTER_MARKER) || (text.includes('forge-workflow') && text.includes('/bin/gh.js'));
  } catch { return false; }
}

function resolveRealGh(options = {}) {
  const platform = options.platform || process.platform;
  const pathValue = options.pathEnv ?? process.env.PATH ?? '';
  const ownPath = options.ownPath || process.argv[1];
  const extensions = platform === 'win32'
    ? (options.pathExt || process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
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

function capturedRunner(realGh) {
  return (command, args, options = {}) => {
    if (command !== 'gh') return execFileSync(command, args, options);
    const result = spawn.sync(realGh, args, options);
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const error = new Error(`GitHub CLI exited with status ${result.status}.`);
      error.status = result.status;
      error.stdout = result.stdout;
      error.stderr = result.stderr;
      throw error;
    }
    return result.stdout || '';
  };
}

function exitCode(result) {
  if (result?.error?.code === 'ENOENT') return 127;
  if (result?.error?.code === 'EACCES') return 126;
  if (Number.isInteger(result?.status)) return result.status;
  return result?.signal && os.constants.signals[result.signal] ? 128 + os.constants.signals[result.signal] : 1;
}

function commandName(args) {
  const takesValue = new Set(['--hostname', '--repo', '-R', '--jq', '--template']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (takesValue.has(arg)) { index += 1; continue; }
    if (arg.startsWith('-')) continue;
    return arg;
  }
  return null;
}

function explicitHostname(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--hostname') return args[index + 1] || '';
    if (arg.startsWith('--hostname=')) return arg.slice('--hostname='.length);
  }
  return null;
}

function runGhProxy(args, projectRoot = process.cwd(), options = {}) {
  const writeError = options.writeError || (value => process.stderr.write(value));
  const realGh = (options.resolveExecutable || resolveRealGh)(options);
  if (!realGh) {
    writeError('GitHub CLI executable not found outside the Forge proxy.\n');
    return 127;
  }
  const baseEnv = { ...(options.baseEnv || process.env) };
  delete baseEnv.FORGE_GH_PROXY_ACTIVE;
  const spawnSync = options.spawnSync || spawn.sync;
  const passthrough = () => exitCode(spawnSync(realGh, args, {
    cwd: projectRoot, env: baseEnv, stdio: 'inherit', shell: false,
  }));
  if (commandName(args) === 'auth') return passthrough();
  const hostname = explicitHostname(args);
  if (hostname !== null && hostname.toLowerCase() !== 'github.com') return passthrough();
  try {
    if (!(options.readAuto || readGithubAuto)(projectRoot, options)) return passthrough();
    const context = (options.createContext || createGithubContext)(projectRoot, {
      ...options, baseEnv, runner: options.runner || capturedRunner(realGh), childRunner: spawnSync,
    });
    if (!context.bound) throw new Error('Automatic routing requires a clone account binding.');
    return exitCode(context.runChild(realGh, args, { cwd: projectRoot, stdio: 'inherit', shell: false }));
  } catch {
    writeError('Forge could not select this clone\'s GitHub account. Run forge github status.\n');
    return 1;
  }
}

module.exports = { commandName, explicitHostname, isForgeProxy, resolveRealGh, runGhProxy };
