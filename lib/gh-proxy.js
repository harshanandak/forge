'use strict';

const { execFileSync, spawnSync: nativeSpawnSync } = require('node:child_process');
const { createGithubTokenContext, readGithubAuto } = require('./github-context');
const {
  commandName, exitCode, isForgeProxy, isLocalGhInvocation, resolveRealGh, runNativeGh, shortOptionValue,
  withoutProxyMarker,
} = require('./native-gh');
const { assertGithubRouterCloneRegistered } = require('./github-router');
const { resolveLocalGithubTarget } = require('./commands/github');

const COMMAND_VALUE_FLAGS = new Set(['--hostname', '--repo', '-R', '--jq', '--template']);
const REPOSITORY_TARGET_POSITIONS = new Map([
  ['extension install', 2],
  ['issue transfer', 3],
  ['label clone', 2],
  ...['archive', 'clone', 'create', 'delete', 'edit', 'fork', 'new', 'set-default', 'sync', 'unarchive', 'view']
    .map(verb => [`repo ${verb}`, 2]),
]);
const RESOURCE_TARGET_POSITIONS = new Map([
  ['co', 1],
  ['api', 1],
  ['agent-task view', 2],
  ...['clone', 'delete', 'edit', 'rename', 'view'].map(verb => [`gist ${verb}`, 2]),
]);

function capturedRunner(realGh) {
  return (command, args, options = {}) => {
    if (command !== 'gh') return execFileSync(command, args, options);
    const result = nativeSpawnSync(realGh, args, options);
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const error = new Error(`GitHub CLI exited with status ${result.status}.`);
      Object.assign(error, { status: result.status, stdout: result.stdout, stderr: result.stderr });
      throw error;
    }
    return result.stdout || '';
  };
}

function environmentValue(environment, name, platform) {
  if (platform !== 'win32') return environment[name] || undefined;
  const key = Object.keys(environment).find(candidate => candidate.toUpperCase() === name);
  return key ? (environment[key] || undefined) : undefined;
}

function resourceHostname(value) {
  const text = String(value || '');
  if (text.includes('://')) {
    const url = new URL(text);
    if (url.protocol !== 'https:' || url.port) throw new Error('Unsupported GitHub target URL.');
    const hostname = url.hostname.toLowerCase();
    return ['api.github.com', 'gist.github.com', 'uploads.github.com'].includes(hostname) ? 'github.com' : hostname;
  }
  return undefined;
}

function repositoryHostname(value) {
  const text = String(value || '');
  if (text.includes('://')) {
    const url = new URL(text);
    if (!['https:', 'ssh:'].includes(url.protocol) || (url.protocol === 'https:' && url.port)) {
      throw new Error('Unsupported GitHub target URL.');
    }
    return url.hostname.toLowerCase();
  }
  const scpHost = /^(?:[^@\s/:]+@)?([^:\s/]+):[^/\s]+\/[^/\s]+$/.exec(text);
  if (scpHost) return scpHost[1].toLowerCase();
  if (text.includes(':')) throw new Error('Unknown GitHub repository destination.');
  const parts = text.split('/');
  if (parts.length === 2 && parts.every(Boolean)) return undefined;
  if (parts.length === 3 && parts.every(Boolean)) return parts[0].toLowerCase();
  throw new Error('Unknown GitHub repository destination.');
}

function commandPath(args) {
  const result = [];
  let started = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (COMMAND_VALUE_FLAGS.has(arg)) { index += 1; continue; }
    if (/^(?:--hostname|--repo|--jq|--template)=/.test(arg) || /^-R=?\S+/.test(arg)) continue;
    if (arg === '--' || (started && arg.startsWith('-'))) break;
    if (arg.startsWith('-')) continue;
    started = true;
    result.push(arg);
  }
  return result;
}

function flagTakesValue(help, flag) {
  const matches = new Set();
  for (const line of String(help || '').split(/\r?\n/)) {
    const [declaration, description] = line.trim().split(/\s{2,}/, 2);
    if (!description) continue;
    const tokens = declaration.replaceAll(',', '').split(/\s+/);
    if (tokens.includes(flag)) matches.add(tokens.some(token => !token.startsWith('-')));
  }
  return matches.size === 1 ? [...matches][0] : null;
}

function optionValueResolver(args, realGh, baseEnv, options) {
  let help;
  const readHelp = () => {
    if (help !== undefined) return help;
    if (options.readCommandHelp) help = String(options.readCommandHelp(commandPath(args)) || '');
    else {
      const pathParts = commandPath(args);
      for (let length = pathParts.length; length > 0; length -= 1) {
        try {
          help = String((options.execFileSync || execFileSync)(realGh, ['help', ...pathParts.slice(0, length)], {
            encoding: 'utf8', env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 3000,
          }) || '');
          break;
        } catch { /* try the parent command */ }
      }
    }
    return help || '';
  };
  const resolve = flag => flagTakesValue(readHelp(), flag);
  resolve.help = readHelp;
  return resolve;
}

function isOptionValue(args, index, resolveOptionValue) {
  const previous = args[index - 1];
  if (!previous?.startsWith('-') || previous.includes('=')) return false;
  if (COMMAND_VALUE_FLAGS.has(previous)) return true;
  if (!previous.startsWith('--') && previous.length > 2) {
    const option = shortOptionValue(previous, resolveOptionValue);
    return Boolean(option && !option.attached);
  }
  const takesValue = resolveOptionValue(previous);
  if (typeof takesValue !== 'boolean') throw new Error(`Unable to determine GitHub CLI option arity for ${previous}.`);
  return takesValue;
}

function positionalArguments(args, resolveOptionValue) {
  const delimiter = args.indexOf('--');
  return args.filter((arg, index) => arg !== '--' && ((delimiter >= 0 && index > delimiter)
    || (!arg.startsWith('-') && !isOptionValue(args, index, resolveOptionValue))));
}

function namedUrlPositions(help, positionalCount) {
  const positions = new Set();
  for (const line of String(help || '').split(/\r?\n/)) {
    const usage = /^\s*(?:Usage:\s*)?gh\s+(.+)$/i.exec(line)?.[1];
    if (!usage) continue;
    const tokens = usage.match(/\[[^\]]*\]|\{[^}]*\}|<[^>]+>|\S+/g) || [];
    let position = tokens.findIndex(token => /^[\[{<]/.test(token));
    if (position < 0) continue;
    for (const token of tokens.slice(position)) {
      const placeholders = [...token.matchAll(/<([^>]+)>/g)].map(match => match[1]);
      if (!placeholders.length) continue;
      if (placeholders.some(name => /(?:^|[-_])urls?$/i.test(name))) {
        positions.add(position);
        if (placeholders.some(name => /(?:^|[-_])urls$/i.test(name))) {
          for (let index = position + 1; index < positionalCount; index += 1) positions.add(index);
        }
      }
      position += 1;
    }
  }
  return positions;
}

function positionalResourceHosts(args, command, resolveOptionValue, excludedPosition) {
  if (!args.some(arg => arg.includes('://'))) return [];
  const route = command.slice(0, 2).join(' ');
  const position = RESOURCE_TARGET_POSITIONS.get(route) ?? RESOURCE_TARGET_POSITIONS.get(command[0]);
  const help = position === undefined ? resolveOptionValue.help() : '';
  if (position === undefined && !help.trim()) throw new Error('Unable to classify the GitHub CLI URL argument.');
  const positions = position === undefined ? namedUrlPositions(help, args.length) : new Set([position]);
  if (positions.size === 0) return [];
  const values = positionalArguments(args, resolveOptionValue);
  return [...positions].filter(index => index !== excludedPosition)
    .map(index => resourceHostname(values[index])).filter(Boolean);
}

function repositoryFromShortOptions(arg, args, index, resolveOptionValue) {
  if (!arg.startsWith('-') || arg.startsWith('--') || !arg.slice(1).includes('R')) return null;
  const option = shortOptionValue(arg, resolveOptionValue);
  if (option?.flag !== '-R') return null;
  const next = args[index + 1];
  return option.attached || (next && !next.startsWith('-') ? next : '');
}

function argumentDestinations(args, realGh, baseEnv, options) {
  const hosts = [];
  let explicit = false;
  let remoteName;
  const resolveOptionValue = optionValueResolver(args, realGh, baseEnv, options);
  const command = commandPath(args);
  const commandRoute = command.slice(0, 2).join(' ');
  const delimiter = args.indexOf('--');
  const end = delimiter < 0 ? args.length : delimiter;
  for (let index = 0; index < end; index += 1) {
    const arg = args[index];
    let value;
    if (arg === '--hostname' || arg === '--repo' || arg === '-R'
      || (commandRoute === 'repo create' && (arg === '--template' || arg === '-p'))) {
      explicit = true;
      value = args[++index];
      if (!value || value.startsWith('-')) throw new Error(`Missing value for ${arg}.`);
    } else if (arg.startsWith('--hostname=')) {
      explicit = true;
      value = arg.slice('--hostname='.length);
      if (!value) throw new Error('Missing value for --hostname.');
    } else if (arg.startsWith('--repo=')) {
      explicit = true;
      value = arg.slice('--repo='.length);
      if (!value) throw new Error('Missing value for --repo.');
    } else if (commandRoute === 'repo create' && arg.startsWith('--template=')) {
      explicit = true;
      value = arg.slice('--template='.length);
      if (!value) throw new Error('Missing value for --template.');
    } else if (commandRoute === 'repo create' && /^-p=?\S+/.test(arg)) {
      explicit = true;
      value = arg.slice(2).replace(/^=/, '');
    } else if (/^-R=?\S+/.test(arg)) {
      explicit = true;
      value = arg.slice(2).replace(/^=/, '');
    } else {
      value = repositoryFromShortOptions(arg, args, index, resolveOptionValue);
      if (value === null) continue;
      explicit = true;
      if (!value) throw new Error('Missing value for -R.');
    }
    const host = arg.startsWith('--hostname') ? value.toLowerCase() : repositoryHostname(value);
    if (host) hosts.push(host);
  }

  const repositoryPosition = REPOSITORY_TARGET_POSITIONS.get(commandRoute);
  if (repositoryPosition !== undefined) {
    const target = positionalArguments(args, resolveOptionValue)[repositoryPosition];
    if (target) {
      explicit = true;
      const localName = ['repo create', 'repo new'].includes(commandRoute) && !/[/:]/.test(target);
      const localRemote = commandRoute === 'repo set-default' && !/[/:]/.test(target);
      if (localRemote) remoteName = target;
      const host = localName || localRemote ? undefined : repositoryHostname(target);
      if (host) hosts.push(host);
    }
  }
  const resourceHosts = positionalResourceHosts(args, command, resolveOptionValue, repositoryPosition);
  if (resourceHosts.length) { explicit = true; hosts.push(...resourceHosts); }
  return { explicit, hosts, remoteName };
}

function selectedTarget(args, projectRoot, baseEnv, options, platform) {
  const destinations = argumentDestinations(args, options.realGh, baseEnv, options);
  const hosts = destinations.hosts;
  const environmentHost = environmentValue(baseEnv, 'GH_HOST', platform);
  const environmentRepository = environmentValue(baseEnv, 'GH_REPO', platform);
  if (environmentHost) hosts.push(environmentHost.toLowerCase());
  const repositoryHost = environmentRepository ? repositoryHostname(environmentRepository) : undefined;
  if (repositoryHost) hosts.push(repositoryHost);

  let local;
  if (destinations.remoteName || (!destinations.explicit && !environmentRepository)) {
    local = resolveLocalGithubTarget(projectRoot, options, destinations.remoteName);
    if (!local) throw new Error('Unable to resolve the local GitHub repository host.');
    hosts.push(local.hostname.toLowerCase());
  }
  if (hosts.length === 0) hosts.push('github.com');
  const unique = [...new Set(hosts)];
  if (unique.length !== 1 || unique[0] !== 'github.com') throw new Error('Automatic routing supports github.com only.');
  return { local, environmentRepository };
}

function runGhProxy(args, projectRoot = process.cwd(), options = {}) {
  const writeError = options.writeError || (value => process.stderr.write(value));
  const realGh = (options.resolveExecutable || resolveRealGh)(options);
  if (!realGh) {
    writeError('GitHub CLI executable not found outside the Forge proxy.\n');
    return 127;
  }
  const baseEnv = withoutProxyMarker(options.baseEnv || process.env);
  const resolveOptionValue = optionValueResolver(args, realGh, baseEnv, options);
  if (isLocalGhInvocation(args, resolveOptionValue)) {
    return runNativeGh(args, projectRoot, { ...options, resolveExecutable: () => realGh });
  }
  const spawnSync = options.spawnSync || nativeSpawnSync;
  const passthrough = () => exitCode(spawnSync(realGh, args, {
    cwd: projectRoot, env: baseEnv, stdio: 'inherit', shell: false,
  }));
  try {
    const automatic = (options.readAuto || readGithubAuto)(projectRoot, options);
    if (automatic === false) return passthrough();
    if (automatic !== true) throw new Error('Invalid automatic routing state.');
    (options.assertRegistered || assertGithubRouterCloneRegistered)(projectRoot, options);
    const platform = options.platform || process.platform;
    const { local, environmentRepository } = selectedTarget(args, projectRoot, baseEnv, { ...options, realGh }, platform);
    const childRepository = environmentRepository || (local ? `github.com/${local.repository}` : undefined);
    const childRunner = (command, childArgs, childOptions) => spawnSync(command, childArgs, {
      ...childOptions,
      ...(childRepository ? { env: { ...childOptions.env, GH_REPO: childRepository } } : {}),
    });
    const context = (options.createContext || createGithubTokenContext)(projectRoot, {
      ...options, baseEnv, runner: options.runner || capturedRunner(realGh), childRunner,
    });
    if (!context.bound) throw new Error('Automatic routing requires a clone account binding.');
    return exitCode(context.runChild(realGh, args, { cwd: projectRoot, stdio: 'inherit', shell: false }));
  } catch {
    writeError('Forge could not select this clone\'s GitHub account. Run forge github status.\n');
    return 1;
  }
}

module.exports = { commandName, isForgeProxy, resolveRealGh, runGhProxy };
