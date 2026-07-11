/**
 * Runtime prerequisite checks for stage entry.
 *
 * This module centralizes the hard-stop decision for hooks, shell helpers,
 * and toolchain prerequisites so stage commands do not have to infer readiness.
 *
 * @module lib/runtime-health
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync: defaultExecFileSync } = require('node:child_process');

const { checkLefthookStatus } = require('./lefthook-check');
const { resolveIssueBackend } = require('./issue-backend');
const { getInstallCommand, getAddDevCommand } = require('./package-manager-remediation');

const WINDOWS_GIT_BASH_CANDIDATES = [
  String.raw`C:\Program Files\Git\bin\bash.exe`,
  String.raw`C:\Program Files (x86)\Git\bin\bash.exe`,
  `${process.env.LOCALAPPDATA ?? ''}${String.raw`\Programs\Git\bin\bash.exe`}`
].filter(Boolean);

function toText(output) {
  if (typeof output === 'string') return output;
  if (Buffer.isBuffer(output)) return output.toString('utf8');
  return output == null ? '' : String(output);
}

function normalizeHooksPath(value, platform = process.platform) {
  let normalized = toText(value).trim().replaceAll('\\', '/');

  while (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }

  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }

  if (platform === 'win32') {
    normalized = normalized.toLowerCase();
  }

  return normalized;
}

function isAbsoluteForPlatform(value, platform = process.platform) {
  const raw = toText(value).trim();
  return platform === 'win32' ? path.win32.isAbsolute(raw) : path.posix.isAbsolute(raw);
}

function resolvesToExecutableHookCommand(line, matcher) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return false;
  const firstCommand = commandName(commandTokens(trimmed)[0]);
  if (firstCommand === 'echo' || firstCommand === 'printf') {
    const chainIndex = trimmed.indexOf('&&');
    return chainIndex === -1 ? false : matcher(trimmed.slice(chainIndex + 2).trim());
  }
  return matcher(trimmed);
}

function hasExecutableHookCommand(content, matcher) {
  let heredocEnd = null;

  for (const line of toText(content).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (heredocEnd) {
      if (trimmed === heredocEnd) heredocEnd = null;
      continue;
    }

    if (resolvesToExecutableHookCommand(line, matcher)) return true;

    const delimiter = heredocDelimiter(line);
    if (delimiter) heredocEnd = delimiter;
  }

  return false;
}

function commandTokens(line) {
  return line
    .replace(/[;"'()]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function commandName(token) {
  return toText(token)
    .replaceAll('\\', '/')
    .split('/')
    .pop()
    .toLowerCase()
    .replace(/\.(?:exe|cmd)$/, '');
}

function isWhitespace(char) {
  return char === ' ' || char === '\t' || char === '\r' || char === '\n';
}

function isVariableNameStart(char) {
  return (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || char === '_';
}

function isVariableNameChar(char) {
  return isVariableNameStart(char) || (char >= '0' && char <= '9');
}

function isAssignmentToken(token) {
  const text = toText(token);
  const equalsIndex = text.indexOf('=');
  if (equalsIndex <= 0 || !isVariableNameStart(text[0])) return false;

  for (let index = 1; index < equalsIndex; index += 1) {
    if (!isVariableNameChar(text[index])) return false;
  }

  return true;
}

function heredocDelimiter(line) {
  const markerIndex = line.indexOf('<<');
  if (markerIndex === -1 || line[markerIndex + 2] === '<') return null;

  let cursor = markerIndex + 2;
  if (line[cursor] === '-') cursor += 1;
  while (cursor < line.length && isWhitespace(line[cursor])) cursor += 1;

  const quote = line[cursor];
  if (quote === '"' || quote === "'") {
    cursor += 1;
    const endQuote = line.indexOf(quote, cursor);
    return endQuote === -1 ? line.slice(cursor).trim() || null : line.slice(cursor, endQuote) || null;
  }

  const start = cursor;
  while (cursor < line.length && !isWhitespace(line[cursor])) cursor += 1;
  return line.slice(start, cursor).trim() || null;
}

function isExecutingTokenPosition(tokens, index) {
  const nonExecutingPreviousTokens = new Set(['-e', '-f', '-r', '-x', '[', 'test']);
  const executingPreviousCommands = new Set(['bash', 'bun', 'env', 'exec', 'if', 'node', 'sh', 'then', '&&']);

  let previousIndex = index - 1;
  while (previousIndex >= 0 && isAssignmentToken(tokens[previousIndex])) {
    previousIndex -= 1;
  }

  if (previousIndex < 0) return true;

  const previous = toText(tokens[previousIndex]).toLowerCase();
  if (nonExecutingPreviousTokens.has(previous)) return false;
  return executingPreviousCommands.has(commandName(previous));
}

function invokesLefthook(line) {
  return commandTokens(line).some((token) => commandName(token) === 'lefthook');
}

function invokesForgeHook(line) {
  return commandTokens(line).some((token, index, tokens) => {
    if (token.includes('=')) return false;
    const normalized = token.replaceAll('\\', '/').toLowerCase();
    if (!normalized.endsWith('.forge/hooks/check-tdd.js') && commandName(token) !== 'check-tdd.js') {
      return false;
    }

    return isExecutingTokenPosition(tokens, index);
  });
}

function invokesBeadsHook(line, hookName) {
  const tokens = commandTokens(line);
  return tokens.some((token, index) => (
    commandName(token) === 'bd'
    && toText(tokens[index + 1]).toLowerCase() === 'hooks'
    && toText(tokens[index + 2]).toLowerCase() === 'run'
    && toText(tokens[index + 3]).toLowerCase() === hookName
    && isExecutingTokenPosition(tokens, index)
  ));
}

function createDiagnostic(code, subject, message, repair, severity = 'hard-stop') {
  return {
    code,
    subject,
    severity,
    message,
    ...(repair ? { repair } : {})
  };
}

function isUsableWindowsShellCandidate(candidate, options = {}) {
  if (typeof options._canExecute === 'function') {
    try {
      return Boolean(options._canExecute(candidate));
    } catch {
      return false;
    }
  }

  try {
    defaultExecFileSync(candidate, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return true;
  } catch {
    return false;
  }
}

function checkHookInstallation(projectRoot, options = {}) {
  const exec = options._exec || defaultExecFileSync;
  const platform = options.platform || process.platform;
  const expectedRelativeHooksPaths = ['.lefthook/hooks', '.beads/hooks'];
  const requiredHooks = ['pre-commit', 'pre-push'];

  function resolveGitRoot() {
    try {
      const output = exec('git', ['rev-parse', '--show-toplevel'], {
        cwd: projectRoot,
        encoding: 'utf8'
      });
      return toText(output).trim() || projectRoot;
    } catch {
      return projectRoot;
    }
  }

  const gitRoot = resolveGitRoot();
  const expectedHooksPaths = new Set(expectedRelativeHooksPaths.flatMap((hooksPath) => [
    normalizeHooksPath(hooksPath, platform),
    normalizeHooksPath(`${gitRoot}/${normalizeHooksPath(hooksPath, platform)}`, platform)
  ]));

  function resolveGitHooksDir() {
    try {
      const output = exec('git', ['rev-parse', '--git-path', 'hooks'], {
        cwd: projectRoot,
        encoding: 'utf8'
      });
      const rawPath = toText(output).trim();
      if (!rawPath) return null;
      return path.isAbsolute(rawPath) ? rawPath : path.resolve(projectRoot, rawPath);
    } catch {
      return null;
    }
  }

  function classifyHookFile(filePath, hookName, visited = new Set()) {
    try {
      const normalizedFilePath = path.resolve(filePath);
      if (visited.has(normalizedFilePath)) {
        return { active: false, provider: 'cycle' };
      }
      visited.add(normalizedFilePath);

      const stat = fs.statSync(filePath);
      const executable = platform === 'win32'
        || (typeof options._canExecuteHook === 'function'
          ? Boolean(options._canExecuteHook(filePath, stat))
          : (stat.mode & 0o111) !== 0);
      if (!stat.isFile() || stat.size === 0 || !executable) return { active: false, provider: 'missing' };

      const content = fs.readFileSync(filePath, 'utf8');
      const runsLefthook = hasExecutableHookCommand(content, invokesLefthook);
      const runsForgeHook = hasExecutableHookCommand(content, invokesForgeHook);
      const runsBeadsHook = hasExecutableHookCommand(content, (line) => invokesBeadsHook(line, hookName));

      if (runsLefthook) return { active: true, provider: 'lefthook' };
      if (runsForgeHook) return { active: true, provider: 'forge' };

      if (runsBeadsHook) {
        const chainedHookPath = path.join(gitRoot, '.beads', 'hooks', hookName);
        if (path.resolve(chainedHookPath) !== normalizedFilePath && fs.existsSync(chainedHookPath)) {
          const chained = classifyHookFile(chainedHookPath, hookName, visited);
          if (chained.active) {
            return { active: true, provider: `beads->${chained.provider}` };
          }
        }

        return { active: false, provider: 'beads-unverified' };
      }

      return { active: false, provider: 'unknown' };
    } catch {
      return { active: false, provider: 'missing' };
    }
  }

  let hooksPath = null;
  try {
    const output = exec('git', ['config', '--get', 'core.hooksPath'], {
      cwd: projectRoot,
      encoding: 'utf8'
    });

    hooksPath = normalizeHooksPath(output, platform);
    const active = expectedHooksPaths.has(hooksPath);

    if (active) {
      const rawHooksPath = toText(output).trim();
      const hooksDir = isAbsoluteForPlatform(rawHooksPath, platform)
        ? rawHooksPath
        : path.resolve(gitRoot, normalizeHooksPath(rawHooksPath, platform));
      const hookChecks = requiredHooks.map((hook) => ({
        hook,
        ...classifyHookFile(path.join(hooksDir, hook), hook)
      }));
      const missingHooks = hookChecks.filter(check => !check.active).map(check => check.hook);
      const verifiedActive = missingHooks.length === 0;
      return {
        active: verifiedActive,
        state: verifiedActive ? 'active' : 'inactive',
        verification: 'core.hooksPath',
        hooksPath: hooksPath || null,
        hooksDir,
        providers: Object.fromEntries(hookChecks.map(check => [check.hook, check.provider])),
        missingHooks,
        message: verifiedActive
          ? ''
          : `Git hooks directory is missing required hooks: ${missingHooks.join(', ')}.`
      };
    }

    if (hooksPath) {
      return {
        active: false,
        state: 'inactive',
        verification: 'core.hooksPath',
        hooksPath,
        message: `Git core.hooksPath is set to "${hooksPath}", not ".lefthook/hooks" or ".beads/hooks".`
      };
    }
  } catch {
    // Fall through to git-path fallback for worktree-safe verification
  }

  const hooksDir = resolveGitHooksDir();
  if (hooksDir) {
    const hookChecks = requiredHooks.map((hook) => ({
      hook,
      ...classifyHookFile(path.join(hooksDir, hook), hook)
    }));
    const missingHooks = hookChecks.filter(check => !check.active).map(check => check.hook);
    const active = missingHooks.length === 0;
    return {
      active,
      state: active ? 'active' : 'inactive',
      verification: 'git-path-hooks',
      hooksPath: hooksPath || null,
      hooksDir,
      providers: Object.fromEntries(hookChecks.map(check => [check.hook, check.provider])),
      missingHooks,
      message: active
        ? ''
        : `Git hooks directory is missing required hooks: ${missingHooks.join(', ')}.`
    };
  }

  return {
    active: false,
    state: 'unverified',
    verification: 'unverified',
    hooksPath: hooksPath || null,
    message: 'Git hooks could not be verified.'
  };
}

function checkCommandAvailability(command, projectRoot, options = {}) {
  const exec = options._exec || defaultExecFileSync;

  try {
    const output = exec(command, ['--version'], {
      cwd: projectRoot,
      encoding: 'utf8'
    });

    return {
      available: true,
      state: 'available',
      command,
      output: toText(output).trim(),
      message: ''
    };
  } catch (err) {
    return {
      available: false,
      state: 'missing',
      command,
      output: '',
      message: err?.message ?? `${command} is unavailable`
    };
  }
}

function resolveShellRuntime(options = {}) {
  const platform = options.platform || process.platform;

  if (platform !== 'win32') {
    return {
      available: true,
      state: 'available',
      platform,
      policy: 'system-shell',
      command: options.command || 'sh',
      message: ''
    };
  }

  const candidates = Object.hasOwn(options, 'candidates')
    ? options.candidates
    : WINDOWS_GIT_BASH_CANDIDATES;

  const exists = options._exists || fs.existsSync;
  if (Array.isArray(candidates)) {
    let unusableCandidate = null;

    for (const candidate of candidates) {
      if (!candidate || !exists(candidate)) {
        continue;
      }

      if (isUsableWindowsShellCandidate(candidate, options)) {
        return {
          available: true,
          state: 'available',
          platform,
          policy: 'git-bash',
          command: candidate,
          message: ''
        };
      }

      unusableCandidate = candidate;
    }

    if (unusableCandidate) {
      return {
        available: false,
        state: 'unusable',
        platform,
        policy: 'git-bash',
        command: unusableCandidate,
        message: 'Git Bash candidate exists but is not executable.'
      };
    }
  }

  return {
    available: false,
    state: 'missing',
    platform,
    policy: 'git-bash',
    command: null,
    message: 'Git Bash is required on Windows for helper-backed flows.'
  };
}

function normalizeShellRuntime(shellRuntime, platform, options = {}) {
  if (shellRuntime && typeof shellRuntime === 'object') {
    const state = shellRuntime.state || (shellRuntime.available ? 'available' : 'missing');
    return {
      available: Boolean(shellRuntime.available),
      state,
      platform,
      policy: shellRuntime.policy || (platform === 'win32' ? 'git-bash' : 'system-shell'),
      command: shellRuntime.command || null,
      message: shellRuntime.message || ''
    };
  }

  return resolveShellRuntime({ ...options, platform });
}

function normalizeProjectRoot(projectRoot) {
  return typeof projectRoot === 'string' && projectRoot.trim()
    ? projectRoot
    : process.cwd();
}

// Resolve the active issue backend for the health gate. An already-normalized
// `options.issueBackend` (passed by enforce-stage) wins; otherwise fall back to the
// shared resolver (env > .forge/config.yaml > default 'kernel'). Never throws and
// never warns from the health path.
function resolveHealthIssueBackend(options, projectRoot) {
  if (options.issueBackend === 'kernel' || options.issueBackend === 'beads') {
    return options.issueBackend;
  }
  return resolveIssueBackend({
    deps: options.backendDeps || {},
    env: options.env || process.env,
    projectRoot,
    warn: () => {}
  });
}

function checkRuntimeHealth(projectRoot, options = {}) {
  const platform = options.platform || process.platform;
  const root = normalizeProjectRoot(projectRoot);

  const hooks = checkHookInstallation(root, options);
  const lefthook = checkLefthookStatus(root);
  const bd = checkCommandAvailability('bd', root, options);
  const gh = checkCommandAvailability('gh', root, options);
  const jq = checkCommandAvailability('jq', root, options);
  const shell = normalizeShellRuntime(options.shellRuntime, platform, options);

  const issueBackend = resolveHealthIssueBackend(options, root);

  const diagnostics = [];
  const advisories = [];

  const lefthookMissing = lefthook.state === 'missing-dependency'
    || lefthook.state === 'missing-binary';

  if (lefthookMissing) {
    const lefthookRepair = lefthook.state === 'missing-binary'
      ? getInstallCommand(root)
      : getAddDevCommand(root, 'lefthook');
    diagnostics.push(createDiagnostic(
      'LEFTHOOK_MISSING',
      'lefthook',
      lefthook.message || 'lefthook is required for hook installation.',
      lefthookRepair
    ));
  }

  if (!hooks.active) {
    diagnostics.push(createDiagnostic(
      'HOOKS_NOT_ACTIVE',
      'git-hooks',
      hooks.message || 'Git hooks are not installed.',
      'bunx lefthook install'
    ));
  }

  if (!bd.available) {
    if (issueBackend === 'beads') {
      // Beads is the active issue backend, so bd is a genuine hard prerequisite.
      diagnostics.push(createDiagnostic(
        'BD_MISSING',
        'bd',
        'bd is required for stage-entry workflow checks when the beads issue backend is selected.'
      ));
    } else {
      // Kernel is the default issue backend and needs no bd binary, so a missing bd
      // must NOT hard-stop stage entry (the "no Beads install required" contract).
      // Surface it as a non-blocking advisory instead.
      advisories.push(createDiagnostic(
        'BD_MISSING',
        'bd',
        'bd is not installed. The kernel issue backend does not require it; install bd only if you switch to the beads backend.',
        undefined,
        'advisory'
      ));
    }
  }

  if (!gh.available) {
    diagnostics.push(createDiagnostic(
      'GH_MISSING',
      'gh',
      'gh is required for stage-entry workflow checks.'
    ));
  }

  if (!jq.available) {
    diagnostics.push(createDiagnostic(
      'JQ_MISSING',
      'jq',
      'jq is required for stage-entry workflow checks.'
    ));
  }

  if (platform === 'win32' && !shell.available) {
    diagnostics.push(createDiagnostic(
      'SHELL_RUNTIME_MISSING',
      'shell-runtime',
      shell.message || 'Git Bash is required on Windows for helper-backed flows.'
    ));
  }

  const healthy = diagnostics.length === 0;

  return {
    healthy,
    ready: healthy,
    hardStop: !healthy,
    diagnostics,
    advisories,
    checks: {
      projectRoot: root,
      lefthook,
      hooks,
      bd,
      gh,
      jq,
      shell,
      issueBackend
    }
  };
}

module.exports = {
  checkRuntimeHealth,
  checkHookInstallation,
  checkCommandAvailability,
  resolveShellRuntime
};
