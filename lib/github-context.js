'use strict';

const { execFileSync } = require('node:child_process');
const { helperPathFromValue, isOwnedCredentialHelperValue } = require('./github-router');

const ACCOUNT_KEY = 'github.account';
const AUTO_KEY = 'github.auto';
const CREDENTIAL_HELPER_KEY = 'credential.https://github.com.helper';
const HOST = 'github.com';
const LOGIN_RE = /^(?=.{1,39}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const GITHUB_ENV_NAMES = new Set(['gh_token', 'github_token', 'gh_enterprise_token', 'github_enterprise_token', 'gh_host', 'gh_repo']);
const GITHUB_SECRET_ENV_NAMES = new Set(['gh_token', 'github_token', 'gh_enterprise_token', 'github_enterprise_token']);

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
  const matchedStatus = /\bhttp\s+(401|403|429)\b/.exec(text)?.[1];
  let httpStatus;
  if ([401, 403, 429].includes(error?.httpStatus)) httpStatus = error.httpStatus;
  else if ([401, 403, 429].includes(error?.status)) httpStatus = error.status;
  else httpStatus = Number(matchedStatus) || undefined;
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
    if (absentIsOkay && (error?.status === 1 || /key does not contain|not found|no such key|not a git repository|--local can only be used/i.test(errorText(error)))) {
      return '';
    }
    throw safeCommandFailure('GIT_CONFIG_FAILED', 'Unable to read this clone-local GitHub account binding.');
  }
}

function readLocalValues(projectRoot, key, options = {}) {
  const output = gitConfig(projectRoot, ['--get-all', key], options, true);
  const text = output == null ? '' : output.toString().trimEnd();
  return text ? text.split(/\r?\n/) : [];
}

function runGitConfig(projectRoot, args, options, message) {
  try {
    return runnerFor(options)('git', ['config', '--local', ...args], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch {
    throw safeCommandFailure('GIT_CONFIG_FAILED', message);
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
    runnerFor(options)('git', ['config', '--local', '--replace-all', ACCOUNT_KEY, login], {
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

function readGithubAuto(projectRoot, options = {}) {
  const values = readLocalValues(projectRoot, AUTO_KEY, options);
  return values.length === 1 && values[0].toLowerCase() === 'true';
}

function ownsCredentialHelper(value, options) {
  return (options.isOwnedCredentialHelper || isOwnedCredentialHelperValue)(value);
}

function hasForgeHelperShape(helpers) {
  return helpers.length === 2 && helpers[0] === '' && Boolean(helperPathFromValue(helpers[1]));
}

function assertGithubAutoAvailable(projectRoot, options = {}) {
  const helpers = readLocalValues(projectRoot, CREDENTIAL_HELPER_KEY, options);
  const owned = helpers.length === 2 && helpers[0] === '' && ownsCredentialHelper(helpers[1], options);
  const recoverable = !owned && hasForgeHelperShape(helpers) && readGithubAuto(projectRoot, options);
  if (helpers.length && !owned && !recoverable) {
    throw safeCommandFailure('GIT_CREDENTIAL_HELPER_CONFLICT', 'A clone-local GitHub credential helper is already configured.');
  }
}

function enableGithubAuto(projectRoot, options = {}) {
  assertGithubAutoAvailable(projectRoot, options);
  const helperValue = options.credentialHelperValue;
  if (!ownsCredentialHelper(helperValue || '', options)) {
    throw safeCommandFailure('GIT_CONFIG_FAILED', 'Forge did not provide a valid credential helper command.');
  }
  const previousHelpers = readLocalValues(projectRoot, CREDENTIAL_HELPER_KEY, options);
  const previousAuto = readLocalValues(projectRoot, AUTO_KEY, options);
  try {
    runGitConfig(projectRoot, ['--replace-all', CREDENTIAL_HELPER_KEY, ''], options, 'Unable to enable automatic GitHub routing.');
    runGitConfig(projectRoot, ['--add', CREDENTIAL_HELPER_KEY, helperValue], options, 'Unable to enable automatic GitHub routing.');
    runGitConfig(projectRoot, ['--replace-all', AUTO_KEY, 'true'], options, 'Unable to enable automatic GitHub routing.');
  } catch (error) {
    for (const [key, values] of [[CREDENTIAL_HELPER_KEY, previousHelpers], [AUTO_KEY, previousAuto]]) {
      try {
        runnerFor(options)('git', ['config', '--local', '--unset-all', key], { cwd: projectRoot, stdio: 'ignore' });
        for (const value of values) runnerFor(options)('git', ['config', '--local', '--add', key, value], { cwd: projectRoot, stdio: 'ignore' });
      } catch { /* best effort rollback */ }
    }
    throw error;
  }
}

function disableGithubAuto(projectRoot, options = {}) {
  const helpers = readLocalValues(projectRoot, CREDENTIAL_HELPER_KEY, options);
  const previousAuto = readLocalValues(projectRoot, AUTO_KEY, options);
  const autoEnabled = previousAuto.length === 1 && previousAuto[0].toLowerCase() === 'true';
  const owned = helpers.length === 2 && helpers[0] === '' && ownsCredentialHelper(helpers[1], options);
  const recoverable = !owned && autoEnabled && hasForgeHelperShape(helpers);
  const keys = [AUTO_KEY, ...((owned || recoverable) ? [CREDENTIAL_HELPER_KEY] : [])];
  try {
    for (const key of keys) {
      try {
        runnerFor(options)('git', ['config', '--local', '--unset-all', key], {
          cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        });
      } catch (error) {
        if (error?.status === 5 || error?.status === 1 || /key does not contain|not found|no such key/i.test(errorText(error))) continue;
        throw error;
      }
    }
  } catch {
    for (const [key, values] of [[AUTO_KEY, previousAuto], [CREDENTIAL_HELPER_KEY, helpers]]) {
      try {
        runnerFor(options)('git', ['config', '--local', '--unset-all', key], { cwd: projectRoot, stdio: 'ignore' });
        for (const value of values) runnerFor(options)('git', ['config', '--local', '--add', key, value], { cwd: projectRoot, stdio: 'ignore' });
      } catch { /* best effort rollback */ }
    }
    throw safeCommandFailure('GIT_CONFIG_FAILED', 'Unable to disable automatic GitHub routing.');
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
  } catch {
    // `gh --jq` normally returns plain text; JSON is only a compatibility path.
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
  } catch {
    // Provider errors may contain response bodies or credentials; expose only a safe diagnosis.
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
  const secrets = (status.state === 'unbound'
    ? Object.entries(baseEnv)
      .filter(([key]) => GITHUB_SECRET_ENV_NAMES.has(key.toLowerCase()))
      .map(([, value]) => value)
    : [token])
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
  const writeCredential = (write) => {
    if (status.state === 'unbound' || typeof write !== 'function') {
      throw safeCommandFailure('GITHUB_NOT_AUTHENTICATED', 'No selected GitHub account is available.');
    }
    write(`username=${status.account}\npassword=${token}\n\n`);
  };
  Object.defineProperties(context, {
    runChild: { value: runChild, enumerable: false },
    runGh: { value: runGh, enumerable: false },
    writeCredential: { value: writeCredential, enumerable: false },
    getStatus: { value: () => ({ ...status }), enumerable: false },
  });
  return context;
}

function redactTokens(value, tokens) {
  if (value == null) return value;
  return tokens.slice().sort((left, right) => right.length - left.length)
    .reduce((redacted, token) => redacted.split(token).join('[REDACTED]'), value.toString());
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
  AUTO_KEY,
  CREDENTIAL_HELPER_KEY,
  GithubContextError,
  assertGithubAutoAvailable,
  createGithubContext,
  disableGithubAuto,
  enableGithubAuto,
  prepareGithubAccount,
  prepareGithubContext: createGithubContext,
  readGithubAccount,
  readGithubAuto,
  resolveGithubLogin,
  unsetGithubAccount,
  validateGithubLogin,
  writeGithubAccount,
};
