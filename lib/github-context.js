'use strict';

const { execFileSync } = require('node:child_process');

const ACCOUNT_KEY = 'github.account';
const HOST = 'github.com';
const LOGIN_RE = /^(?=.{1,39}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const GITHUB_ENV_NAMES = new Set(['gh_token', 'github_token', 'gh_host']);
const GITHUB_SECRET_ENV_NAMES = new Set(['gh_token', 'github_token']);

class GithubContextError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GithubContextError';
    this.code = code;
  }

  toJSON() {
    return { code: this.code, message: this.message };
  }
}

function validateGithubLogin(login) {
  return typeof login === 'string' && LOGIN_RE.test(login);
}

function safeLogin(login) {
  return validateGithubLogin(login) ? login : null;
}

function runnerFor(options) {
  return options.runner || options._runner || options._exec || options.execFileSync || defaultRunner;
}

function defaultRunner(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...options,
  });
}

function errorText(error) {
  return [error?.message, error?.stderr?.toString?.(), error?.stdout?.toString?.()]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function isUnsupportedTokenCapability(error) {
  const text = errorText(error);
  return /unknown (?:flag|option)|invalid (?:flag|option)|unexpected argument|does not support/.test(text)
    && /user|hostname/.test(text);
}

function safeCommandFailure(code, message) {
  return new GithubContextError(code, message);
}

function safeGithubCommandFailure(error) {
  const text = errorText(error);
  const failure = safeCommandFailure(
    'GITHUB_COMMAND_FAILED',
    /rate limit|secondary rate/.test(text)
      ? 'The GitHub CLI command was rate limited.'
      : 'The GitHub CLI command failed without exposing its output.',
  );
  const matchedStatus = text.match(/\bhttp\s+(401|403)\b/)?.[1];
  const httpStatus = [401, 403].includes(error?.httpStatus)
    ? error.httpStatus
    : [401, 403].includes(error?.status) ? error.status : Number(matchedStatus) || undefined;
  const retryAfter = Number(error?.retryAfter);
  if (httpStatus) failure.httpStatus = httpStatus;
  if (Number.isFinite(retryAfter) && retryAfter > 0) failure.retryAfter = retryAfter;
  return failure;
}

function gitConfig(projectRoot, args, options, absentIsOkay = false) {
  try {
    return runnerFor(options)('git', ['config', '--local', ...args], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    if (absentIsOkay && (error?.status === 1 || /key does not contain|not found|no such key/i.test(errorText(error)))) {
      return '';
    }
    throw safeCommandFailure('GIT_CONFIG_FAILED', 'Unable to read this clone-local GitHub account binding.');
  }
}

function readGithubAccount(projectRoot, options = {}) {
  const output = gitConfig(projectRoot, ['--get', ACCOUNT_KEY], options, true);
  const value = output == null ? '' : output.toString().trim();
  return value || null;
}

function writeGithubAccount(projectRoot, login, options = {}) {
  if (!validateGithubLogin(login)) {
    throw safeCommandFailure('INVALID_GITHUB_LOGIN', 'GitHub login must be 1-39 letters, numbers, or internal hyphens.');
  }
  try {
    runnerFor(options)('git', ['config', '--local', ACCOUNT_KEY, login], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (_error) {
    throw safeCommandFailure('GIT_CONFIG_FAILED', 'Unable to write the clone-local GitHub account binding.');
  }
}

function unsetGithubAccount(projectRoot, options = {}) {
  try {
    runnerFor(options)('git', ['config', '--local', '--unset-all', ACCOUNT_KEY], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    if (error?.status === 5 || /key does not contain|not found|no such key/i.test(errorText(error))) return;
    throw safeCommandFailure('GIT_CONFIG_FAILED', 'Unable to remove the clone-local GitHub account binding.');
  }
}

function withoutGithubEnvironment(environment) {
  const result = {};
  for (const [key, value] of Object.entries(environment || {})) {
    if (!GITHUB_ENV_NAMES.has(key.toLowerCase())) result[key] = value;
  }
  return result;
}

function selectedEnvironment(baseEnv, token, additions = {}) {
  const result = withoutGithubEnvironment(baseEnv);
  Object.assign(result, withoutGithubEnvironment(additions));
  result.GH_TOKEN = token;
  result.GITHUB_TOKEN = token;
  result.GH_HOST = HOST;
  return result;
}

function passthroughEnvironment(baseEnv, additions = {}) {
  return { ...baseEnv, ...additions };
}

function retrieveGithubToken(login, options) {
  if (!validateGithubLogin(login)) {
    throw safeCommandFailure('INVALID_GITHUB_LOGIN', 'GitHub login must be 1-39 letters, numbers, or internal hyphens.');
  }
  const baseEnv = options.baseEnv || options.env || process.env;
  let output;
  try {
    output = runnerFor(options)('gh', ['auth', 'token', '--hostname', HOST, '--user', login], {
      env: withoutGithubEnvironment(baseEnv),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    if (isUnsupportedTokenCapability(error)) {
      throw safeCommandFailure('GITHUB_CLI_UNSUPPORTED', 'Upgrade GitHub CLI, then authenticate the account with gh auth login.');
    }
    throw safeCommandFailure('GITHUB_NOT_AUTHENTICATED', 'GitHub account is not authenticated; run gh auth login for this account.');
  }

  const token = output == null ? '' : output.toString().trim();
  if (!token) {
    throw safeCommandFailure('GITHUB_NOT_AUTHENTICATED', 'GitHub account is not authenticated; run gh auth login for this account.');
  }
  return token;
}

function loginFromOutput(output) {
  const text = output == null ? '' : output.toString().trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return safeLogin(parsed?.login);
  } catch (_error) {
    return safeLogin(text.split(/\r?\n/, 1)[0].trim());
  }
}

function resolveGithubLogin(token, baseEnv, options) {
  try {
    const output = runnerFor(options)('gh', ['api', '--hostname', HOST, 'user', '--jq', '.login'], {
      env: selectedEnvironment(baseEnv, token),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const login = loginFromOutput(output);
    if (!login) throw new Error('missing login');
    return login;
  } catch (_error) {
    throw safeCommandFailure('GITHUB_AUTH_FAILED', 'Unable to verify the selected GitHub account; run gh auth login and try again.');
  }
}

function prepareGithubAccount(_projectRoot, account, options = {}) {
  if (!validateGithubLogin(account)) {
    throw safeCommandFailure('INVALID_GITHUB_LOGIN', 'GitHub login must be 1-39 letters, numbers, or internal hyphens.');
  }
  const baseEnv = { ...(options.baseEnv || options.env || process.env) };
  const token = retrieveGithubToken(account, { ...options, baseEnv });
  const login = resolveGithubLogin(token, baseEnv, options);
  if (login.toLowerCase() !== account.toLowerCase()) {
    throw safeCommandFailure('GITHUB_ACCOUNT_MISMATCH', `GitHub account mismatch: expected ${account}, received ${login}.`);
  }
  return createPublicContext(publicStatus('ready', account, login), token, baseEnv, options);
}

function publicStatus(state, account, login) {
  return Object.freeze({ state, account: account || null, login: login || null });
}

function createPublicContext(status, token, baseEnv, options) {
  const context = {
    status,
    bound: status.state !== 'unbound',
    account: status.account,
    login: status.login,
  };
  const secrets = [token, ...Object.entries(baseEnv)
    .filter(([key]) => GITHUB_SECRET_ENV_NAMES.has(key.toLowerCase()))
    .map(([, value]) => value)]
    .filter((value) => typeof value === 'string' && value);
  const environmentForChild = (additions = {}) => status.state === 'unbound'
    ? passthroughEnvironment(baseEnv, additions)
    : selectedEnvironment(baseEnv, token, additions);
  const childRunner = options.childRunner || options._childRunner || runnerFor(options);
  const runChild = (command, args, runOptions = {}) => {
    if (typeof command !== 'string' || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      throw safeCommandFailure('INVALID_GH_ARGUMENTS', 'GitHub CLI arguments must be an array of strings.');
    }
    try {
      return childRunner(command, args, {
        ...runOptions,
        env: environmentForChild(runOptions.env),
      });
    } catch (_error) {
      throw safeCommandFailure('GITHUB_COMMAND_FAILED', 'The GitHub CLI command failed without exposing its output.');
    }
  };
  const runGh = (args, runOptions = {}) => {
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      throw safeCommandFailure('INVALID_GH_ARGUMENTS', 'GitHub CLI arguments must be an array of strings.');
    }
    try {
      const output = runnerFor(options)('gh', args, {
        ...runOptions,
        env: environmentForChild(runOptions.env),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      return redactTokens(output, secrets);
    } catch (error) {
      throw safeGithubCommandFailure(error);
    }
  };
  Object.defineProperties(context, {
    runChild: { value: runChild, enumerable: false },
    runGh: { value: runGh, enumerable: false },
    getStatus: { value: () => ({ ...status }), enumerable: false },
  });
  return context;
}

function redactTokens(value, tokens) {
  if (value == null) return value;
  return tokens.reduce((redacted, token) => redacted.split(token).join('[REDACTED]'), value.toString());
}

function createGithubContext(projectRoot, options = {}) {
  const baseEnv = { ...(options.baseEnv || options.env || process.env) };
  const account = readGithubAccount(projectRoot, options);
  if (!account) return createPublicContext(publicStatus('unbound', null, null), null, baseEnv, options);
  if (!validateGithubLogin(account)) {
    throw safeCommandFailure('INVALID_GITHUB_LOGIN', 'The clone-local github.account value is not a valid GitHub login.');
  }
  return prepareGithubAccount(projectRoot, account, { ...options, baseEnv });
}

module.exports = {
  ACCOUNT_KEY,
  GithubContextError,
  createGithubContext,
  prepareGithubAccount,
  prepareGithubContext: createGithubContext,
  readGithubAccount,
  resolveGithubLogin,
  unsetGithubAccount,
  validateGithubLogin,
  writeGithubAccount,
};
