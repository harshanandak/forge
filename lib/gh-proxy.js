'use strict';

const { execFileSync, spawnSync: nativeSpawnSync } = require('node:child_process');
const { createGithubTokenContext, readGithubAuto } = require('./github-context');
const {
  commandName, exitCode, isForgeProxy, isLocalGhInvocation, resolveRealGh, runNativeGh, withoutProxyMarker,
} = require('./native-gh');
const { assertGithubRouterCloneRegistered } = require('./github-router');
const { resolveGithubRemote } = require('./commands/github');

const COMMAND_VALUE_FLAGS = new Set(['--hostname', '--repo', '-R', '--jq', '--template']);
const REPOSITORY_TARGET_POSITIONS = new Map([
  ['extension install', 2],
  ...['archive', 'clone', 'delete', 'edit', 'fork', 'set-default', 'sync', 'unarchive', 'view']
    .map(verb => [`repo ${verb}`, 2]),
]);
const RESOURCE_TARGET_POSITIONS = new Map([
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
    if (url.protocol !== 'https:') throw new Error('Unsupported GitHub target URL.');
    const hostname = url.hostname.toLowerCase();
    return ['api.github.com', 'gist.github.com', 'uploads.github.com'].includes(hostname) ? 'github.com' : hostname;
  }
  return undefined;
}

function repositoryHostname(value) {
  const urlHost = resourceHostname(value);
  if (urlHost) return urlHost;
  const parts = String(value || '').split('/');
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
  const takesValue = resolveOptionValue(previous);
  if (typeof takesValue !== 'boolean') throw new Error(`Unable to determine GitHub CLI option arity for ${previous}.`);
  return takesValue;
}

function positionalArguments(args, resolveOptionValue) {
  const delimiter = args.indexOf('--');
  return args.filter((arg, index) => arg !== '--' && ((delimiter >= 0 && index > delimiter)
    || (!arg.startsWith('-') && !isOptionValue(args, index, resolveOptionValue))));
}

function namedUrlPositions(help) {
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
      if (placeholders.some(name => /(?:^|[-_])url$/i.test(name))) positions.add(position);
      position += 1;
    }
  }
  return positions;
}

function positionalResourceHosts(args, command, resolveOptionValue) {
  if (!args.some(arg => arg.includes('://'))) return [];
  const route = command.slice(0, 2).join(' ');
  const position = RESOURCE_TARGET_POSITIONS.get(route) ?? RESOURCE_TARGET_POSITIONS.get(command[0]);
  const help = position === undefined ? resolveOptionValue.help() : '';
  if (position === undefined && !help.trim()) throw new Error('Unable to classify the GitHub CLI URL argument.');
  const positions = position === undefined ? namedUrlPositions(help) : new Set([position]);
  const values = positionalArguments(args, resolveOptionValue);
  return [...positions].map(index => resourceHostname(values[index])).filter(Boolean);
}

function repositoryFromShortOptions(arg, args, index, resolveOptionValue) {
  if (!arg.startsWith('-') || arg.startsWith('--') || !arg.slice(1).includes('R')) return null;
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

function argumentDestinations(args, realGh, baseEnv, options) {
  const hosts = [];
  let explicit = false;
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
      const host = repositoryHostname(target);
      if (host) hosts.push(host);
    }
  }
  const resourceHosts = positionalResourceHosts(args, command, resolveOptionValue);
  if (resourceHosts.length) { explicit = true; hosts.push(...resourceHosts); }
  return { explicit, hosts };
}

function localRepositoryTarget(projectRoot, options) {
  if (options.resolveLocalTarget) return options.resolveLocalTarget(projectRoot);
  const run = options.execFileSync || execFileSync;
  const git = args => String(run('git', args, {
    cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 3000,
  }) || '').trim();
  let remoteName = 'origin';
  try {
    const resolved = git(['config', '--local', '--get-regexp', '^remote\\..*\\.gh-resolved$'])
      .split(/\r?\n/).map(line => /^remote\.(.+)\.gh-resolved\s+(?:base|true)$/i.exec(line)?.[1]).filter(Boolean);
    if (resolved.length > 1) throw new Error('Multiple GitHub CLI default remotes are configured.');
    if (resolved.length === 1) remoteName = resolved[0];
  } catch (error) {
    if (!Number.isInteger(error?.status) || error.status !== 1) throw error;
  }
  let remoteUrl;
  try {
    remoteUrl = git(['remote', 'get-url', remoteName]);
  } catch (error) {
    if (remoteName !== 'origin' || error?.status !== 2) throw error;
    const remotes = git(['remote']).split(/\r?\n/).filter(Boolean);
    if (remotes.length !== 1) throw error;
    remoteUrl = git(['remote', 'get-url', remotes[0]]);
  }
  const target = resolveGithubRemote(remoteUrl, projectRoot, { ...options, runner: run });
  if (!target) throw new Error('Unable to resolve the local GitHub repository host.');
  return target;
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
  if (hosts.length === 0 && !destinations.explicit && !environmentRepository) {
    local = localRepositoryTarget(projectRoot, options);
    hosts.push(local.hostname.toLowerCase());
  }
  if (hosts.length === 0) hosts.push('github.com');
  const unique = [...new Set(hosts)];
  if (unique.length !== 1 || unique[0] !== 'github.com') throw new Error('Automatic routing supports github.com only.');
  return { local, environmentRepository };
}

function runGhProxy(args, projectRoot = process.cwd(), options = {}) {
  if (isLocalGhInvocation(args)) return runNativeGh(args, projectRoot, options);
  const writeError = options.writeError || (value => process.stderr.write(value));
  const realGh = (options.resolveExecutable || resolveRealGh)(options);
  if (!realGh) {
    writeError('GitHub CLI executable not found outside the Forge proxy.\n');
    return 127;
  }
  const baseEnv = withoutProxyMarker(options.baseEnv || process.env);
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
