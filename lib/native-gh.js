'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { isCompiledBinary } = require('./package-root');

const ROUTER_MARKER = 'forge-gh-router-v1';
const LOCAL_COMMANDS = new Set(['alias', 'auth', 'completion', 'config', 'help', 'licenses', 'preview', 'version']);
const HELP_COMMANDS = new Set([
  'agent-task', 'api', 'attestation', 'browse', 'cache', 'codespace', 'gist', 'gpg-key', 'issue', 'label',
  'org', 'pr', 'project', 'release', 'repo', 'ruleset', 'run', 'search', 'secret', 'ssh-key', 'status',
  'variable', 'workflow',
]);
const GLOBAL_VALUE_FLAGS = new Set(['--hostname', '--repo', '-R']);

function environmentValue(environment, name) {
  const key = Object.keys(environment).find(candidate => candidate.toUpperCase() === name);
  return key ? environment[key] : undefined;
}

function withoutProxyMarker(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => key.toUpperCase() !== 'FORGE_GH_PROXY_ACTIVE'));
}

function commandName(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (GLOBAL_VALUE_FLAGS.has(arg)) { index += 1; continue; }
    if (!arg.startsWith('-')) return arg;
  }
  return null;
}

function isLocalGhInvocation(args) {
  if (args.length === 0) return true;
  const command = commandName(args);
  if (LOCAL_COMMANDS.has(command)) return true;
  if (['skill', 'skills'].includes(command) && args[args.indexOf(command) + 1] === 'list') return true;
  if (args.length === 1) return ['--help', '-h', '--version'].includes(args[0]);
  return HELP_COMMANDS.has(command) && args.length <= 3 && ['--help', '-h'].includes(args.at(-1))
    && args.slice(0, -1).every(arg => !arg.startsWith('-'));
}

function exitCode(result) {
  if (result?.error?.code === 'ENOENT') return 127;
  if (result?.error?.code === 'EACCES') return 126;
  if (Number.isInteger(result?.status)) return result.status;
  return result?.signal && os.constants.signals[result.signal] ? 128 + os.constants.signals[result.signal] : 1;
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

function runNativeGh(args, projectRoot = process.cwd(), options = {}) {
  const writeError = options.writeError || (value => process.stderr.write(value));
  const executable = (options.resolveExecutable || resolveRealGh)(options);
  if (!executable) {
    writeError('GitHub CLI executable not found outside the Forge proxy.\n');
    return 127;
  }
  return exitCode((options.spawnSync || spawnSync)(executable, args, {
    cwd: projectRoot,
    env: withoutProxyMarker(options.baseEnv || process.env),
    stdio: 'inherit',
    shell: false,
  }));
}

module.exports = { commandName, exitCode, isForgeProxy, isLocalGhInvocation, resolveRealGh, runNativeGh, withoutProxyMarker };
