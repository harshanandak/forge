'use strict';

const { execFileSync } = require('node:child_process');
const { constants } = require('node:os');
const spawn = require('cross-spawn');
const {
  assertGithubAutoAvailable, createGithubContext, disableGithubAuto, enableGithubAuto,
  hasGithubAutoCredentialHelper, prepareGithubAccount, readGithubAccount, readGithubAuto, writeGithubAccount,
  unsetGithubAccount, validateGithubLogin,
} = require('../github-context');
const { assertGithubRouterCloneRegistered, getGithubRouterStatus, installGithubRouter,
  isManagedCredentialHelperValue, isOwnedCredentialHelperValue, registerGithubRouterClone, unregisterGithubRouterClone,
  uninstallGithubRouter } = require('../github-router');
const { stripGlobalFlags } = require('../global-flags');
const { defaultResolveLocalRepository } = require('./merge');

const usage = 'forge github use <login> [--auto] | auto [--disable] | router --uninstall --force | status [--json] | unset | run -- <program> [args...]';
const ERROR_MESSAGES = {
  INVALID_GITHUB_LOGIN: 'GitHub login must be 1-39 letters, numbers, or internal hyphens.',
  GIT_CONFIG_FAILED: 'Unable to access this clone-local GitHub account binding.',
  GIT_CREDENTIAL_HELPER_CONFLICT: 'This clone already has a custom GitHub credential helper. Inspect it and remove only the conflicting local entry deliberately.',
  GITHUB_ROUTER_CONFLICT: 'A non-Forge gh launcher already exists beside Forge. Forge left it unchanged.',
  GITHUB_ROUTER_SHADOWED: 'GitHub CLI appears before Forge on PATH. Put Forge first, then retry automatic routing.',
  GITHUB_ROUTER_UNAVAILABLE: 'Install Forge on PATH before enabling automatic GitHub routing.',
  GITHUB_ROUTER_PERMISSION: 'Forge cannot update its launcher directory. Check directory permissions, then retry.',
  GITHUB_ROUTER_BUSY: 'Another automatic-routing update is in progress. Retry after it finishes.',
  GITHUB_ROUTER_REGISTRY_INVALID: 'Forge cannot verify the machine routing registry. Repair the registered clone state, then retry.',
  GITHUB_CREDENTIAL_HELPER_UNAVAILABLE: 'Automatic HTTPS routing requires the Forge-owned credential helper. Run forge github auto to restore it.',
  GITHUB_AUTO_INVALID: 'This clone has an invalid automatic-routing value. Disable or enable automatic routing to repair it.',
  GITHUB_ACCOUNT_REQUIRED: 'Automatic routing requires a clone account. Select one with forge github use <login> --auto, or disable routing.',
  GITHUB_ROUTER_CONFIRMATION: 'Router files are shared by every opted-in clone. Disable automatic routing in every clone, then rerun with --force.',
  GITHUB_ROUTER_IN_USE: 'Automatic routing remains enabled in a registered clone. Disable it there before removing the shared router.',
  GITHUB_NOT_AUTHENTICATED: 'Account is not authenticated. Run gh auth login --hostname github.com for the account, then retry.',
  GITHUB_AUTH_FAILED: 'Unable to verify the account. Run gh auth login --hostname github.com, then retry.',
  GITHUB_CLI_UNSUPPORTED: 'Upgrade GitHub CLI to support gh auth token --hostname github.com --user <login>.',
  GITHUB_ACCOUNT_MISMATCH: 'The authenticated GitHub account does not match this clone binding.',
  GITHUB_COMMAND_FAILED: 'The selected account cannot view this repository. Check repository permissions and organization SSO.',
  GITHUB_REPOSITORY_INVALID: 'A Git remote must identify a GitHub.com repository. Check its URL and SSH alias configuration.',
};

function safeFailure(error) {
  const code = Object.hasOwn(ERROR_MESSAGES, error?.code) ? error.code : 'GITHUB_OPERATION_FAILED';
  return { success: false, code, error: ERROR_MESSAGES[code] || 'GitHub account operation failed. Run forge github status for diagnostics.' };
}

function requiredGithubAutoState(projectRoot, options) {
  const automatic = readGithubAuto(projectRoot, options);
  if (automatic === null) throw Object.assign(new Error('Invalid automatic routing state.'), { code: 'GITHUB_AUTO_INVALID' });
  return automatic;
}

function resolveGithubRemote(remote, root, options = {}) {
  const repository = defaultResolveLocalRepository({ projectRoot: root, git: () => remote });
  if (!repository) return null;
  try {
    const scpHost = /^[A-Za-z]:/.test(remote) || /^(?:git|https?|ssh|file):/i.test(remote) ? null
      : /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9][A-Za-z0-9._-]*):/.exec(remote);
    const parsed = scpHost ? null : new URL(remote);
    if (parsed && !['https:', 'ssh:'].includes(parsed.protocol)) return null;
    if (parsed?.protocol === 'https:' && parsed.port) return null;
    const host = scpHost ? scpHost[1] : parsed.hostname;
    if (host.toLowerCase() === 'github.com' || (!scpHost && parsed.protocol !== 'ssh:')) {
      return { hostname: host.toLowerCase(), repository };
    }
    const run = options.runner || options.execFileSync || execFileSync;
    const config = String(run('ssh', ['-G', host], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 3000,
    }));
    const hostname = /^hostname\s+(\S+)\s*$/im.exec(config)?.[1];
    return hostname ? { hostname: hostname.toLowerCase(), repository } : null;
  } catch { return null; }
}

function runGit(root, args, options) {
  const run = options.runner || options.execFileSync || execFileSync;
  return String(run('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 3000,
  }) || '').trim();
}

function resolveLocalGithubTarget(root, options = {}) {
  if (options.resolveLocalTarget) return options.resolveLocalTarget(root);
  const git = args => runGit(root, args, options);
  let remoteName = 'origin';
  try {
    const resolved = git(['config', '--local', '--get-regexp', '^remote\\..*\\.gh-resolved$'])
      .split(/\r?\n/).map(line => /^remote\.(.+)\.gh-resolved\s+(?:base|true)$/i.exec(line)?.[1]).filter(Boolean);
    if (resolved.length > 1) throw new Error('Multiple GitHub CLI default remotes are configured.');
    if (resolved.length === 1) remoteName = resolved[0];
  } catch (error) {
    if (error?.status !== 1) throw error;
  }
  let remote;
  try {
    remote = git(['remote', 'get-url', remoteName]);
  } catch (error) {
    if (remoteName !== 'origin' || error?.status !== 2) throw error;
    const remotes = git(['remote']).split(/\r?\n/).filter(Boolean);
    if (remotes.length !== 1) throw error;
    remote = git(['remote', 'get-url', remotes[0]]);
  }
  const target = resolveGithubRemote(remote, root, options);
  return target ? { ...target, remote } : null;
}

function repositoryAccess(context, root, options, target = resolveLocalGithubTarget(root, options)) {
  if (target?.hostname !== 'github.com') {
    throw Object.assign(new Error(ERROR_MESSAGES.GITHUB_REPOSITORY_INVALID), { code: 'GITHUB_REPOSITORY_INVALID' });
  }
  context.runGh(['repo', 'view', `github.com/${target.repository}`, '--json', 'nameWithOwner'], { cwd: root, timeout: 30000 });
}

function readGit(root, args, options) {
  try { return runGit(root, args, options); } catch { return ''; }
}

function boundedText(value) {
  // Author fields are display data, never terminal control sequences.
  return value.replace(/\p{Cc}/gu, '').slice(0, 160) || null;
}

function transportOf(remote) {
  if (!remote) return 'missing';
  if (/^https:\/\//i.test(remote)) return 'https';
  if (/^http:\/\//i.test(remote)) return 'http';
  if (/^ssh:\/\//i.test(remote)
    || (!/^[A-Za-z]:/.test(remote) && !/^(?:git|https?|ssh|file):/i.test(remote)
      && /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9._-]*:[^\\/\s][^\s]*$/.test(remote))) return 'ssh';
  return 'other';
}

function helperOf(helper, options) {
  if (!helper) return 'none';
  const values = helper.split(/\r?\n/).map(value => value.trim());
  const ownsHelper = options.isOwnedCredentialHelper || isOwnedCredentialHelperValue;
  if (values.some(value => ownsHelper(value))) return 'forge';
  const managesHelper = options.isManagedCredentialHelper || isManagedCredentialHelperValue;
  if (values.some(value => managesHelper(value, options))) return 'forge-stale';
  if (/\bgh(?:\.exe)?\s+auth\s+git-credential\b/i.test(helper)) return 'github-cli';
  if (/\bmanager(?:-core)?\b/i.test(helper)) return 'credential-manager';
  return 'other';
}

function localDiagnostics(root, options) {
  let target;
  try { target = resolveLocalGithubTarget(root, options); } catch { /* report the remaining local state */ }
  return {
    target: target || null,
    author: {
      name: boundedText(readGit(root, ['config', '--get', 'user.name'], options)),
      email: boundedText(readGit(root, ['config', '--get', 'user.email'], options)),
    },
    transport: transportOf(target?.remote || readGit(root, ['remote', 'get-url', 'origin'], options)),
    credentialHelper: helperOf(readGit(root, ['config', '--get-urlmatch', 'credential.helper', 'https://github.com'], options), options),
  };
}

function renderStatus(status) {
  const lines = [
    `GitHub: ${status.state}`,
    `Clone account: ${status.account || 'not selected'}`,
    `Automatic routing: ${status.automatic ? 'on' : 'off'}`,
    `Router: ${status.router}`,
    `Verified login: ${status.login || 'unavailable'}`,
    `Commit author: ${status.author.name || 'unset'} <${status.author.email || 'unset'}>`,
    `Git transport: ${status.transport}; credential helper: ${status.credentialHelper}`,
  ];
  if (status.error) lines.push(status.error);
  if (status.automatic && status.router !== 'ready') lines.push('Automatic gh routing is not first on PATH; rerun setup after fixing PATH order.');
  if (status.state === 'unbound') lines.push('Optional: authenticate with gh auth login, then select an account with forge github use <login>.');
  if (status.transport === 'ssh') lines.push('SSH key selection is controlled by your SSH configuration.');
  if (status.code === 'GITHUB_CREDENTIAL_HELPER_UNAVAILABLE') {
    lines.push('The Forge HTTPS credential helper is missing or unowned, or another helper conflicts; run forge github auto to restore it.');
  } else if (status.transport === 'https' && status.credentialHelper === 'forge') {
    lines.push('HTTPS Git credentials use this clone\'s Forge-selected GitHub account.');
  } else if (status.transport === 'https' && status.credentialHelper === 'forge-stale') {
    lines.push('The Forge HTTPS credential helper is missing or unowned; restore Forge on PATH, then run forge github auto.');
  } else if (status.transport === 'https' && status.credentialHelper === 'github-cli') {
    lines.push('HTTPS uses the GitHub CLI helper; a launched session may also use its selected token for Git transport.');
  } else if (status.transport === 'https') {
    lines.push('HTTPS Git credentials are selected separately by your credential helper.');
  }
  return lines.join('\n');
}

function accountStatus(root, options) {
  const automatic = requiredGithubAutoState(root, options);
  const { target, ...diagnostics } = localDiagnostics(root, options);
  const status = { state: 'unbound', account: null, source: null, login: null, repositoryAccess: null,
    automatic, router: automatic ? (options.routerStatus || getGithubRouterStatus)(options) : 'disabled', ...diagnostics };
  try {
    const account = readGithubAccount(root, options);
    if (!account) {
      if (automatic) throw Object.assign(new Error('Automatic routing has no account binding.'), { code: 'GITHUB_ACCOUNT_REQUIRED' });
      return status;
    }
    status.source = 'clone-local';
    status.account = validateGithubLogin(account) ? account : null;
    if (automatic) {
      (options.assertRegistered || assertGithubRouterCloneRegistered)(root, options);
      if (status.router !== 'ready') {
        const code = status.router === 'shadowed' ? 'GITHUB_ROUTER_SHADOWED' : 'GITHUB_ROUTER_UNAVAILABLE';
        throw Object.assign(new Error('Automatic GitHub routing is unavailable.'), { code });
      }
      if (status.transport === 'https' && !hasGithubAutoCredentialHelper(root, options)) {
        if (status.credentialHelper === 'forge') status.credentialHelper = 'forge-conflict';
        throw Object.assign(new Error('Automatic HTTPS routing helper is unavailable.'), { code: 'GITHUB_CREDENTIAL_HELPER_UNAVAILABLE' });
      }
    }
    const context = prepareGithubAccount(root, account, options);
    status.login = context.login;
    status.repositoryAccess = false;
    repositoryAccess(context, root, options, target);
    status.repositoryAccess = true;
    status.state = 'ready';
  } catch (error) {
    const failure = safeFailure(error);
    status.state = failure.code.startsWith('GITHUB_ROUTER_') || failure.code === 'GITHUB_CREDENTIAL_HELPER_UNAVAILABLE'
      ? 'router_error' : (status.login ? 'no_repository_access' : 'unauthenticated');
    if (failure.code === 'GITHUB_ACCOUNT_MISMATCH') {
      status.state = 'mismatch';
      const match = /^GitHub account mismatch: expected [A-Za-z0-9-]+, received ([A-Za-z0-9-]+)\.$/.exec(error.message);
      status.login = match && validateGithubLogin(match[1]) ? match[1] : null;
    }
    status.code = failure.code;
    status.error = failure.error;
  }
  return status;
}

function launchFailure(error) {
  if (error?.code === 'ENOENT') return { success: false, code: 'ENOENT', exitCode: 127, error: 'Child program was not found. Check its installation and PATH.' };
  if (error?.code === 'EACCES') return { success: false, code: 'EACCES', exitCode: 126, error: 'Child program is not executable.' };
  return { success: false, code: 'CHILD_LAUNCH_FAILED', exitCode: 1, error: 'Unable to launch the child program.' };
}

function launch(context, program, args, root, options) {
  return new Promise(resolve => {
    let child;
    try {
      child = context.runChild(program, args, { cwd: root, stdio: 'inherit', shell: false });
    } catch (error) { resolve(launchFailure(error)); return; }
    const signals = options.signalSource || process;
    const forwardInt = () => child.kill('SIGINT');
    const forwardTerm = () => child.kill('SIGTERM');
    signals.on('SIGINT', forwardInt);
    signals.on('SIGTERM', forwardTerm);
    const finish = result => {
      signals.removeListener('SIGINT', forwardInt);
      signals.removeListener('SIGTERM', forwardTerm);
      resolve(result);
    };
    child.once('error', error => finish(launchFailure(error)));
    child.once('close', (code, signal) => {
      const exitCode = Number.isInteger(code) ? code : 128 + (constants.signals[signal] || 1);
      finish({ success: exitCode === 0, exitCode, signal, ...(exitCode ? { error: `Child program exited with status ${exitCode}.` } : {}) });
    });
  });
}

function githubStatusResult(projectRoot, flags, args, options) {
  const status = accountStatus(projectRoot, options);
  const json = flags.json || flags['--json'] || args.includes('--json');
  return { success: ['ready', 'unbound'].includes(status.state), status,
    output: json ? JSON.stringify(status, null, 2) : renderStatus(status),
    ...(status.error ? { error: status.error } : {}) };
}

function usageFailure() {
  return { success: false, error: `Usage: ${usage}` };
}

function writeAccountAndAuto(projectRoot, account, automatic, router, previousAccount, options) {
  if (!automatic) return writeGithubAccount(projectRoot, account, options);
  try {
    writeGithubAccount(projectRoot, account, options);
    enableGithubAuto(projectRoot, { ...options, credentialHelperValue: router.credentialHelperValue });
  } catch (error) {
    try {
      if (previousAccount) writeGithubAccount(projectRoot, previousAccount, options);
      else unsetGithubAccount(projectRoot, options);
    } catch { /* best effort rollback */ }
    try { router.rollback?.(); } catch { /* best effort rollback */ }
    throw error;
  }
  return router.commit?.();
}

function handleUse(ownArgs, delimiter, projectRoot, options) {
  if (!((ownArgs.length === 2 || (ownArgs.length === 3 && ownArgs[2] === '--auto')) && delimiter < 0)) return usageFailure();
  const enableAutomatic = ownArgs[2] === '--auto';
  if (enableAutomatic) assertGithubAutoAvailable(projectRoot, options);
  const context = prepareGithubAccount(projectRoot, ownArgs[1], options);
  repositoryAccess(context, projectRoot, options);
  const automatic = enableAutomatic || requiredGithubAutoState(projectRoot, options);
  const previousAccount = enableAutomatic ? readGithubAccount(projectRoot, options) : null;
  const registration = automatic && !enableAutomatic
    ? (options.registerRouterClone || registerGithubRouterClone)(projectRoot, options)
    : null;
  const router = enableAutomatic
    ? (options.installRouter || installGithubRouter)({ ...options, projectRoot })
    : null;
  const finalization = writeAccountAndAuto(projectRoot, ownArgs[1], enableAutomatic, router, previousAccount, options);
  const warning = finalization?.warning || registration?.warning;
  return { success: true, account: context.account, automatic,
    ...(warning ? { warning } : {}),
    output: `This clone uses GitHub account ${context.account}${automatic ? ' with automatic routing' : ''}.${warning ? ` ${warning}` : ''}` };
}

function handleAuto(ownArgs, delimiter, projectRoot, options) {
  if (!((ownArgs.length === 1 || (ownArgs.length === 2 && ownArgs[1] === '--disable')) && delimiter < 0)) return usageFailure();
  if (ownArgs[1] === '--disable') {
    disableGithubAuto(projectRoot, options);
    const cleanup = (options.unregisterRouterClone || unregisterGithubRouterClone)(projectRoot, options);
    return { success: true, automatic: false, ...(cleanup?.warning ? { warning: cleanup.warning } : {}),
      output: `Automatic GitHub routing disabled for this clone.${cleanup?.warning ? ` ${cleanup.warning}` : ''}` };
  }
  assertGithubAutoAvailable(projectRoot, options);
  const context = createGithubContext(projectRoot, options);
  if (!context.bound) throw Object.assign(new Error('No clone binding.'), { code: 'GITHUB_NOT_AUTHENTICATED' });
  repositoryAccess(context, projectRoot, options);
  const router = (options.installRouter || installGithubRouter)({ ...options, projectRoot });
  try {
    enableGithubAuto(projectRoot, { ...options, credentialHelperValue: router.credentialHelperValue });
  } catch (error) {
    try { router.rollback?.(); } catch { /* best effort rollback */ }
    throw error;
  }
  const warning = router.commit?.()?.warning;
  return { success: true, account: context.account, automatic: true,
    ...(warning ? { warning } : {}),
    output: `Automatic GitHub routing enabled for ${context.account}.${warning ? ` ${warning}` : ''}` };
}

function handleRouterUninstall(ownArgs, delimiter, projectRoot, flags, options) {
  if (ownArgs.length === 2 && ownArgs[1] === '--uninstall' && delimiter < 0 && !flags.force) {
    throw Object.assign(new Error('Explicit confirmation required.'), { code: 'GITHUB_ROUTER_CONFIRMATION' });
  }
  if (!(ownArgs.length === 2 && ownArgs[1] === '--uninstall' && delimiter < 0 && flags.force)) return usageFailure();
  const automatic = options.readAuto ? options.readAuto(projectRoot, options) : requiredGithubAutoState(projectRoot, options);
  if (automatic === null) throw Object.assign(new Error('Invalid automatic routing state.'), { code: 'GITHUB_AUTO_INVALID' });
  if (automatic) {
    throw Object.assign(new Error('Automatic routing is enabled.'), { code: 'GITHUB_ROUTER_IN_USE' });
  }
  const result = (options.uninstallRouter || uninstallGithubRouter)({ ...options, projectRoot });
  const output = result.removed.length ? `Removed ${result.removed.length} Forge GitHub router file(s).` : 'No Forge GitHub router files found.';
  return { success: true, removed: result.removed, ...(result.warning ? { warning: result.warning } : {}),
    output: `${output}${result.warning ? ` ${result.warning}` : ''}` };
}

function handleStatus(ownArgs, delimiter, projectRoot, flags, args, options) {
  if (!(ownArgs.slice(1).every(arg => arg === '--json') && delimiter < 0)) return usageFailure();
  return githubStatusResult(projectRoot, flags, args, options);
}

function handleUnset(ownArgs, delimiter, projectRoot, options) {
  if (!(ownArgs.length === 1 && delimiter < 0)) return usageFailure();
  disableGithubAuto(projectRoot, options);
  unsetGithubAccount(projectRoot, options);
  const cleanup = (options.unregisterRouterClone || unregisterGithubRouterClone)(projectRoot, options);
  return { success: true, ...(cleanup?.warning ? { warning: cleanup.warning } : {}),
    output: `Clone GitHub account binding removed; native account selection applies.${cleanup?.warning ? ` ${cleanup.warning}` : ''}` };
}

async function handleRun(ownArgs, delimiter, args, projectRoot, options) {
  if (!(ownArgs.length === 1 && delimiter >= 0 && args[delimiter + 1])) return usageFailure();
  const context = createGithubContext(projectRoot, { ...options, childRunner: options.childRunner || spawn });
  return await launch(context, args[delimiter + 1], args.slice(delimiter + 2), projectRoot, options);
}

async function handler(args = [], flags = {}, projectRoot = process.cwd(), options = {}) {
  const delimiter = args.indexOf('--');
  const ownArgs = stripGlobalFlags(delimiter < 0 ? args : args.slice(0, delimiter));
  const verb = ownArgs[0];
  if (!verb || verb === 'help' || (delimiter < 0 && (args.includes('--help') || args.includes('-h')))) {
    return { success: true, output: usage };
  }
  try {
    switch (verb) {
      case 'use': return handleUse(ownArgs, delimiter, projectRoot, options);
      case 'auto': return handleAuto(ownArgs, delimiter, projectRoot, options);
      case 'router': return handleRouterUninstall(ownArgs, delimiter, projectRoot, flags, options);
      case 'status': return handleStatus(ownArgs, delimiter, projectRoot, flags, args, options);
      case 'unset': return handleUnset(ownArgs, delimiter, projectRoot, options);
      case 'run': return await handleRun(ownArgs, delimiter, args, projectRoot, options);
      default: return usageFailure();
    }
  } catch (error) { return safeFailure(error); }
}

module.exports = {
  name: 'github',
  description: 'Optional clone-local GitHub account selection, automatic routing, and isolated launch',
  usage,
  handler,
  resolveLocalGithubTarget,
  resolveGithubRemote,
};
