'use strict';

const { execFileSync } = require('node:child_process');
const { constants } = require('node:os');
const spawn = require('cross-spawn');
const {
  createGithubContext, prepareGithubAccount, readGithubAccount,
  writeGithubAccount, unsetGithubAccount, validateGithubLogin,
} = require('../github-context');
const { stripGlobalFlags } = require('../global-flags');
const { defaultResolveLocalRepository } = require('./merge');

const usage = 'forge github use <login> | status [--json] | unset | run -- <program> [args...]';
const ERROR_MESSAGES = {
  INVALID_GITHUB_LOGIN: 'GitHub login must be 1-39 letters, numbers, or internal hyphens.',
  GIT_CONFIG_FAILED: 'Unable to access this clone-local GitHub account binding.',
  GITHUB_NOT_AUTHENTICATED: 'Account is not authenticated. Run gh auth login --hostname github.com for the account, then retry.',
  GITHUB_AUTH_FAILED: 'Unable to verify the account. Run gh auth login --hostname github.com, then retry.',
  GITHUB_CLI_UNSUPPORTED: 'Upgrade GitHub CLI to support gh auth token --hostname github.com --user <login>.',
  GITHUB_ACCOUNT_MISMATCH: 'The authenticated GitHub account does not match this clone binding.',
  GITHUB_COMMAND_FAILED: 'The selected account cannot view this repository. Check repository permissions and organization SSO.',
  GITHUB_REPOSITORY_INVALID: 'Origin must identify a GitHub.com repository. Check its URL and SSH alias configuration.',
};

function safeFailure(error) {
  const code = Object.hasOwn(ERROR_MESSAGES, error?.code) ? error.code : 'GITHUB_OPERATION_FAILED';
  return { success: false, code, error: ERROR_MESSAGES[code] || 'GitHub account operation failed. Run forge github status for diagnostics.' };
}

function isGithubOrigin(remote, root, options) {
  try {
    const scpHost = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):/.exec(remote);
    const parsed = scpHost ? null : new URL(remote);
    const host = scpHost ? scpHost[1] : parsed.hostname;
    if (host.toLowerCase() === 'github.com') return true;
    if ((!scpHost && parsed.protocol !== 'ssh:') || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host)) return false;
    // Resolve configured SSH aliases locally; -G does not open a connection.
    const run = options.runner || execFileSync;
    const config = String(run('ssh', ['-G', host], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 3000,
    }));
    return /^hostname\s+github\.com\s*$/im.test(config);
  } catch { return false; }
}

function repositoryAccess(context, root, options) {
  const remote = readGit(root, ['remote', 'get-url', 'origin'], options);
  const repository = defaultResolveLocalRepository({ projectRoot: root, git: () => remote });
  if (!repository || !isGithubOrigin(remote, root, options)) {
    throw Object.assign(new Error(ERROR_MESSAGES.GITHUB_REPOSITORY_INVALID), { code: 'GITHUB_REPOSITORY_INVALID' });
  }
  context.runGh(['repo', 'view', `github.com/${repository}`, '--json', 'nameWithOwner'], { cwd: root, timeout: 30000 });
}

function readGit(root, args, options) {
  try {
    const run = options.runner || execFileSync;
    return String(run('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 3000 }) || '').trim();
  } catch { return ''; }
}

function boundedText(value) {
  // Author fields are display data, never terminal control sequences.
  return value.replace(/\p{Cc}/gu, '').slice(0, 160) || null;
}

function transportOf(remote) {
  if (!remote) return 'missing';
  if (/^https:\/\//i.test(remote)) return 'https';
  if (/^http:\/\//i.test(remote)) return 'http';
  if (/^ssh:\/\//i.test(remote) || /^[^\s/:]+@[^\s/:]+:/.test(remote)) return 'ssh';
  return 'other';
}

function helperOf(helper) {
  if (!helper) return 'none';
  if (/\bgh(?:\.exe)?\s+auth\s+git-credential\b/i.test(helper)) return 'github-cli';
  if (/\bmanager(?:-core)?\b/i.test(helper)) return 'credential-manager';
  return 'other';
}

function localDiagnostics(root, options) {
  return {
    author: {
      name: boundedText(readGit(root, ['config', '--get', 'user.name'], options)),
      email: boundedText(readGit(root, ['config', '--get', 'user.email'], options)),
    },
    transport: transportOf(readGit(root, ['remote', 'get-url', 'origin'], options)),
    credentialHelper: helperOf(readGit(root, ['config', '--get-all', 'credential.helper'], options)),
  };
}

function renderStatus(status) {
  const lines = [
    `GitHub: ${status.state}`,
    `Clone account: ${status.account || 'not selected'}`,
    `Verified login: ${status.login || 'unavailable'}`,
    `Commit author: ${status.author.name || 'unset'} <${status.author.email || 'unset'}>`,
    `Origin transport: ${status.transport}; credential helper: ${status.credentialHelper}`,
  ];
  if (status.error) lines.push(status.error);
  if (status.state === 'unbound') lines.push('Optional: authenticate with gh auth login, then select an account with forge github use <login>.');
  if (status.transport === 'ssh') lines.push('SSH key selection is controlled by your SSH configuration.');
  if (status.transport === 'https' && status.credentialHelper === 'github-cli') {
    lines.push('HTTPS uses the GitHub CLI helper; a launched session may also use its selected token for Git transport.');
  } else if (status.transport === 'https') {
    lines.push('HTTPS Git credentials are selected separately by your credential helper.');
  }
  return lines.join('\n');
}

function accountStatus(root, options) {
  const status = { state: 'unbound', account: null, source: null, login: null, repositoryAccess: null, ...localDiagnostics(root, options) };
  try {
    const account = readGithubAccount(root, options);
    if (!account) return status;
    status.source = 'clone-local';
    status.account = validateGithubLogin(account) ? account : null;
    const context = prepareGithubAccount(root, account, options);
    status.login = context.login;
    status.repositoryAccess = false;
    repositoryAccess(context, root, options);
    status.repositoryAccess = true;
    status.state = 'ready';
  } catch (error) {
    const failure = safeFailure(error);
    status.state = status.login ? 'no_repository_access' : 'unauthenticated';
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

async function handler(args = [], flags = {}, projectRoot = process.cwd(), options = {}) {
  const delimiter = args.indexOf('--');
  const ownArgs = stripGlobalFlags(delimiter < 0 ? args : args.slice(0, delimiter));
  const verb = ownArgs[0];
  if (!verb || verb === 'help' || (delimiter < 0 && (args.includes('--help') || args.includes('-h')))) {
    return { success: true, output: usage };
  }
  try {
    if (verb === 'use' && ownArgs.length === 2 && delimiter < 0) {
      const context = prepareGithubAccount(projectRoot, ownArgs[1], options);
      repositoryAccess(context, projectRoot, options);
      writeGithubAccount(projectRoot, ownArgs[1], options);
      return { success: true, account: context.account, output: `This clone uses GitHub account ${context.account}.` };
    }
    if (verb === 'status' && ownArgs.slice(1).every(arg => arg === '--json') && delimiter < 0) {
      const status = accountStatus(projectRoot, options);
      const json = flags.json || flags['--json'] || args.includes('--json');
      return { success: ['ready', 'unbound'].includes(status.state), status,
        output: json ? JSON.stringify(status, null, 2) : renderStatus(status),
        ...(status.error ? { error: status.error } : {}) };
    }
    if (verb === 'unset' && ownArgs.length === 1 && delimiter < 0) {
      unsetGithubAccount(projectRoot, options);
      return { success: true, output: 'Clone GitHub account binding removed; native account selection applies.' };
    }
    if (verb === 'run' && ownArgs.length === 1 && delimiter >= 0 && args[delimiter + 1]) {
      const context = createGithubContext(projectRoot, { ...options, childRunner: options.childRunner || spawn });
      return await launch(context, args[delimiter + 1], args.slice(delimiter + 2), projectRoot, options);
    }
    return { success: false, error: `Usage: ${usage}` };
  } catch (error) { return safeFailure(error); }
}

module.exports = {
  name: 'github',
  description: 'Optional clone-local GitHub account selection and isolated session launch',
  usage,
  handler,
};
