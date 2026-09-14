'use strict';

const os = require('node:os');
const { execFileSync } = require('node:child_process');
const spawn = require('cross-spawn');
const { createGithubContext, readGithubAuto } = require('./github-context');
const { isForgeProxy, resolveRealGh } = require('./native-gh');

const LOCAL_COMMANDS = new Set(['alias', 'auth', 'completion', 'config', 'help', 'version']);
const EXTENSION_NAMESPACES = new Set(['ext', 'extension', 'extensions']);
const COMMAND_VALUE_FLAGS = new Set(['--hostname', '--repo', '-R', '--jq', '--template']);

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
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (COMMAND_VALUE_FLAGS.has(arg)) { index += 1; continue; }
    if (arg.startsWith('-')) continue;
    return arg;
  }
  return null;
}

function commandPath(args) {
  const path = [];
  let started = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!started && COMMAND_VALUE_FLAGS.has(arg)) { index += 1; continue; }
    if (arg === '--' || (started && arg.startsWith('-'))) break;
    if (arg.startsWith('-')) continue;
    started = true;
    path.push(arg);
  }
  return path;
}

function flagTakesValue(help, flag) {
  const matches = new Set();
  for (const line of String(help || '').split(/\r?\n/)) {
    const [declaration, description] = line.trim().split(/\s{2,}/, 2);
    if (!description) continue;
    const tokens = declaration.replaceAll(',', '').split(/\s+/);
    if (!tokens.includes(flag)) continue;
    matches.add(tokens.some(token => !token.startsWith('-')));
  }
  return matches.size === 1 ? [...matches][0] : null;
}

function readCommandHelp(args, realGh, baseEnv, options) {
  if (options.readCommandHelp) return options.readCommandHelp(commandPath(args));
  const run = options.execFileSync || execFileSync;
  const pathParts = commandPath(args);
  for (let length = pathParts.length; length > 0; length -= 1) {
    try {
      return String(run(realGh, ['help', ...pathParts.slice(0, length)], {
        encoding: 'utf8', env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 3000,
      }) || '');
    } catch { /* try the parent command */ }
  }
  return '';
}

function optionValueResolver(args, realGh, baseEnv, options) {
  let help;
  const readHelp = () => {
    help ??= readCommandHelp(args, realGh, baseEnv, options);
    return help;
  };
  const resolve = flag => flagTakesValue(readHelp(), flag);
  resolve.help = readHelp;
  return resolve;
}

function configuredAliasNames(realGh, baseEnv, options) {
  const output = options.readAliases
    ? options.readAliases()
    : (options.execFileSync || execFileSync)(realGh, ['alias', 'list'], {
      encoding: 'utf8', env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 3000,
    });
  return new Set(String(output || '').split(/\r?\n/).map(line => /^([^:\s]+):(?:\s|$)/.exec(line)?.[1]).filter(Boolean));
}

function installedExtensionNames(realGh, baseEnv, options) {
  const output = options.readExtensions
    ? options.readExtensions()
    : (options.execFileSync || execFileSync)(realGh, ['extension', 'list'], {
      encoding: 'utf8', env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 3000,
    });
  return new Set(String(output || '').split(/\r?\n/).map(line => /^gh\s+(\S+)\s/.exec(line)?.[1]).filter(Boolean));
}

function extensionCommand(args) {
  const parts = commandPath(args);
  return EXTENSION_NAMESPACES.has(parts[0]) && parts[1] === 'exec' ? parts[2] : parts[0];
}

function isExtensionManagement(args) {
  const parts = commandPath(args);
  return EXTENSION_NAMESPACES.has(parts[0]) && parts[1] !== 'exec';
}

function assertNotOpaqueCommand(args, command, realGh, baseEnv, options) {
  const alias = command && configuredAliasNames(realGh, baseEnv, options).has(command);
  const extension = installedExtensionNames(realGh, baseEnv, options).has(extensionCommand(args));
  if (!alias && !extension) return;
  const error = new Error(`Forge cannot safely route the configured gh ${alias ? 'alias' : 'extension'} "${alias ? command : extensionCommand(args)}". Run its expanded gh command explicitly.`);
  error.code = 'GITHUB_ROUTER_OPAQUE_COMMAND';
  throw error;
}

function explicitHostname(args, resolveOptionValue) {
  let hostname = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') break;
    if (arg === '--hostname' || arg.startsWith('--hostname=')) {
      if (isOptionValue(args, index, resolveOptionValue)) continue;
      const next = args[index + 1];
      hostname = arg === '--hostname' ? (next && !next.startsWith('-') ? next : '') : arg.slice('--hostname='.length);
    }
  }
  return hostname;
}

function explicitRepository(args, resolveOptionValue) {
  let repository = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') break;
    if (arg === '--repo' || arg === '-R' || arg.startsWith('--repo=') || arg.startsWith('-R=')) {
      if (isOptionValue(args, index, resolveOptionValue)) continue;
      if (arg === '--repo' || arg === '-R') {
        const next = args[index + 1];
        repository = next && !next.startsWith('-') ? next : '';
      }
      else if (arg.startsWith('--repo=')) repository = arg.slice('--repo='.length);
      else repository = arg.slice('-R='.length);
      continue;
    }
    const shortRepository = repositoryFromShortOptions(arg, args, index, resolveOptionValue);
    if (shortRepository !== null) repository = shortRepository;
  }
  return repository;
}

function repositoryFromShortOptions(arg, args, index, resolveOptionValue) {
  if (!arg.startsWith('-') || arg.startsWith('--') || !arg.slice(1).includes('R')) return null;
  if (isOptionValue(args, index, resolveOptionValue)) return null;
  for (let offset = 1; offset < arg.length; offset += 1) {
    const flag = `-${arg[offset]}`;
    if (flag === '-R') {
      const attached = arg.slice(offset + 1).replace(/^=/, '');
      const next = args[index + 1];
      return attached || (next && !next.startsWith('-') ? next : '');
    }
    const takesValue = resolveOptionValue(flag);
    if (typeof takesValue !== 'boolean') throw new Error(`Unable to determine GitHub CLI option arity for ${flag}.`);
    if (takesValue) return null;
  }
  return null;
}

function repositoryHostname(repository) {
  const urlHost = resourceUrlHostname(repository);
  if (urlHost) return urlHost;
  const parts = String(repository || '').split('/');
  return parts.length === 3 ? parts[0] : undefined;
}

function resourceUrlHostname(value) {
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    return url.hostname.toLowerCase() === 'gist.github.com' ? 'github.com' : url.hostname;
  } catch { return undefined; }
}

function positionalArguments(args, resolveOptionValue) {
  const delimiter = args.indexOf('--');
  return args.filter((arg, index) => {
    if (arg === '--') return false;
    if (delimiter >= 0 && index > delimiter) return true;
    return !arg.startsWith('-') && !isOptionValue(args, index, resolveOptionValue);
  });
}

function positionalUrlHostnames(args, resolveOptionValue) {
  if (!args.some(arg => arg.includes('://'))) return [];
  if (!/<url>/i.test(resolveOptionValue.help())) return [];
  return positionalArguments(args, resolveOptionValue).map(resourceUrlHostname).filter(Boolean);
}

function positionalRepositoryHostname(args, resolveOptionValue) {
  const usage = /^\s*gh\s+(.+?)\s+\[?<repository>/im.exec(resolveOptionValue.help());
  if (!usage) return undefined;
  const commandLength = usage[1].trim().split(/\s+/).length;
  return repositoryHostname(positionalArguments(args, resolveOptionValue)[commandLength]);
}

function targetHostname(args, repository, resolveOptionValue, environmentHost) {
  const explicit = explicitHostname(args, resolveOptionValue);
  if (explicit !== null && !explicit) throw new Error('GitHub hostname is missing.');
  const hosts = [explicit, repositoryHostname(repository),
    positionalRepositoryHostname(args, resolveOptionValue), ...positionalUrlHostnames(args, resolveOptionValue)]
    .filter(Boolean).map(host => host.toLowerCase());
  const unique = [...new Set(hosts)];
  if (unique.length > 1) throw new Error('Conflicting GitHub target hostnames.');
  return unique[0] ?? (environmentHost || undefined);
}

function isOptionValue(args, index, resolveOptionValue) {
  const previous = args[index - 1];
  if (!previous?.startsWith('-') || previous.includes('=')) return false;
  if (!previous.startsWith('--') && previous.length > 2) {
    for (let offset = 1; offset < previous.length; offset += 1) {
      const flag = `-${previous[offset]}`;
      const result = COMMAND_VALUE_FLAGS.has(flag) ? true : resolveOptionValue(flag);
      if (typeof result !== 'boolean') throw new Error(`Unable to determine GitHub CLI option arity for ${flag}.`);
      if (result) return offset === previous.length - 1;
    }
    return false;
  }
  const result = resolveOptionValue(previous);
  if (typeof result !== 'boolean') throw new Error(`Unable to determine GitHub CLI option arity for ${previous}.`);
  return result;
}

function hasStandaloneFlag(args, flag, resolveOptionValue) {
  const delimiter = args.indexOf('--');
  const end = delimiter < 0 ? args.length : delimiter;
  return args.slice(0, end).some((arg, index) => arg === flag && !isOptionValue(args, index, resolveOptionValue));
}

function environmentValue(environment, name, platform) {
  if (platform !== 'win32') return environment[name] || undefined;
  const key = Object.keys(environment).find(candidate => candidate.toUpperCase() === name);
  return key ? (environment[key] || undefined) : undefined;
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
  const command = commandName(args);
  const platform = options.platform || process.platform;
  const environmentRepository = environmentValue(baseEnv, 'GH_REPO', platform);
  const childRunner = (command, childArgs, childOptions) => spawnSync(command, childArgs, {
    ...childOptions,
    ...(environmentRepository ? { env: { ...childOptions.env, GH_REPO: environmentRepository } } : {}),
  });
  try {
    const resolveOptionValue = optionValueResolver(args, realGh, baseEnv, options);
    if (LOCAL_COMMANDS.has(command) || isExtensionManagement(args) || hasStandaloneFlag(args, '--help', resolveOptionValue)
      || hasStandaloneFlag(args, '--version', resolveOptionValue)) return passthrough();
    const repository = explicitRepository(args, resolveOptionValue) ?? environmentRepository;
    if (repository === '') throw new Error('GitHub repository is missing.');
    const hostname = targetHostname(args, repository, resolveOptionValue, environmentValue(baseEnv, 'GH_HOST', platform));
    if (hostname !== undefined && hostname.toLowerCase() !== 'github.com') return passthrough();
    if (!(options.readAuto || readGithubAuto)(projectRoot, options)) return passthrough();
    assertNotOpaqueCommand(args, command, realGh, baseEnv, options);
    const context = (options.createContext || createGithubContext)(projectRoot, {
      ...options, baseEnv, runner: options.runner || capturedRunner(realGh), childRunner,
    });
    if (!context.bound) throw new Error('Automatic routing requires a clone account binding.');
    return exitCode(context.runChild(realGh, args, { cwd: projectRoot, stdio: 'inherit', shell: false }));
  } catch (error) {
    writeError(error?.code === 'GITHUB_ROUTER_OPAQUE_COMMAND'
      ? `${error.message}\n`
      : 'Forge could not select this clone\'s GitHub account. Run forge github status.\n');
    return 1;
  }
}

module.exports = { commandName, explicitHostname, flagTakesValue, isForgeProxy, resolveRealGh, runGhProxy };
