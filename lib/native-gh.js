'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { isCompiledBinary } = require('./package-root');

const ROUTER_MARKER = 'forge-gh-router-v1';
const LOCAL_COMMANDS = new Set([
  'accessibility', 'actions', 'alias', 'auth', 'completion', 'config', 'environment', 'exit-codes', 'formatting',
  'help', 'licenses', 'mintty', 'preview', 'reference', 'telemetry', 'version',
]);
const HELP_COMMANDS = new Set([
  'agent-task', 'api', 'attestation', 'browse', 'cache', 'co', 'codespace', 'copilot', 'discussion', 'extension',
  'gist', 'gpg-key', 'issue', 'label', 'org', 'pr', 'project', 'release', 'repo', 'ruleset', 'run', 'search',
  'secret', 'skill', 'skills', 'ssh-key', 'status', 'variable', 'workflow',
]);
const GLOBAL_VALUE_FLAGS = new Set(['--hostname', '--repo', '-R']);
const SKILL_VALUE_FLAGS = new Set(['--agent', '--dir', '--pin', '--scope']);
const TRUE_BOOLEAN_VALUES = new Set(['1', 't', 'T', 'TRUE', 'true', 'True']);

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

function enabledBooleanFlag(argument, name) {
  return argument === name || (argument.startsWith(`${name}=`)
    && TRUE_BOOLEAN_VALUES.has(argument.slice(name.length + 1)));
}

function shortOptionValue(arg, resolveOptionValue) {
  for (let offset = 1; offset < arg.length; offset += 1) {
    const flag = `-${arg[offset]}`;
    const takesValue = resolveOptionValue(flag);
    if (typeof takesValue !== 'boolean') throw new Error(`Unable to determine GitHub CLI option arity for ${flag}.`);
    if (takesValue) return { flag, attached: arg.slice(offset + 1).replace(/^=/, '') };
  }
  return null;
}

function isLocalSkillInvocation(args, command) {
  const commandIndex = args.indexOf(command);
  const subcommand = args[commandIndex + 1];
  if (subcommand === 'list') return true;
  if (!['install', 'add'].includes(subcommand)) return false;
  let local = false;
  for (let index = commandIndex + 2; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') return false;
    if (SKILL_VALUE_FLAGS.has(arg)) { index += 1; continue; }
    if (enabledBooleanFlag(arg, '--upstream')) return false;
    if (enabledBooleanFlag(arg, '--from-local')) local = true;
  }
  return local;
}

function isLocalExtensionInvocation(args, command) {
  const commandIndex = args.indexOf(command);
  if (args[commandIndex + 1] !== 'install') return false;
  const values = [];
  for (let index = commandIndex + 2; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') return false;
    if (arg === '--pin') { index += 1; continue; }
    if (arg === '--force' || arg.startsWith('--force=') || arg.startsWith('--pin=')) continue;
    if (arg.startsWith('-')) return false;
    values.push(arg);
  }
  return values.length === 1 && values[0] === '.';
}

function isLocalGhInvocation(args, resolveOptionValue = () => null) {
  if (args.length === 0) return true;
  const command = commandName(args);
  if (LOCAL_COMMANDS.has(command)) return true;
  if (['skill', 'skills'].includes(command) && isLocalSkillInvocation(args, command)) return true;
  if (command === 'extension' && isLocalExtensionInvocation(args, command)) return true;
  const help = argument => {
    if (enabledBooleanFlag(argument, '--help')) return true;
    if (!enabledBooleanFlag(argument, '-h')) return false;
    try { return resolveOptionValue('-h') === false; } catch { return false; }
  };
  if (args.length === 1) return enabledBooleanFlag(args[0], '--help') || enabledBooleanFlag(args[0], '-h')
    || enabledBooleanFlag(args[0], '--version');
  const delimiter = args.indexOf('--');
  const end = delimiter < 0 ? args.length : delimiter;
  if (!HELP_COMMANDS.has(command) || !args.slice(0, end).some(help)) return false;
  for (let index = 0; index < end; index += 1) {
    const arg = args[index];
    if (help(arg)) return true;
    if (!arg.startsWith('-') || arg.includes('=')) continue;
    try {
      if (arg.startsWith('--')) {
        const takesValue = GLOBAL_VALUE_FLAGS.has(arg) || resolveOptionValue(arg);
        if (typeof takesValue !== 'boolean') return false;
        if (takesValue) index += 1;
      } else {
        const option = shortOptionValue(arg, resolveOptionValue);
        if (option && !option.attached) index += 1;
      }
    } catch { return false; }
  }
  return false;
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

module.exports = {
  commandName, exitCode, isForgeProxy, isLocalGhInvocation, resolveRealGh, runNativeGh, shortOptionValue, withoutProxyMarker,
};
