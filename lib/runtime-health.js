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

function createDiagnostic(code, subject, message, repair) {
  return {
    code,
    subject,
    severity: 'hard-stop',
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
  const expectedRelativeHooksPath = normalizeHooksPath('.lefthook/hooks', platform);
  const expectedAbsoluteHooksPath = normalizeHooksPath(`${projectRoot}/${expectedRelativeHooksPath}`, platform);
  const requiredHooks = ['pre-commit', 'pre-push'];

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

  function fileLooksLikeActiveHook(filePath) {
    try {
      const stat = fs.statSync(filePath);
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  }

  let hooksPath = null;
  try {
    const output = exec('git', ['config', '--get', 'core.hooksPath'], {
      cwd: projectRoot,
      encoding: 'utf8'
    });

    hooksPath = normalizeHooksPath(output, platform);
    const active = hooksPath === expectedRelativeHooksPath || hooksPath === expectedAbsoluteHooksPath;

    if (active) {
      return {
        active,
        state: 'active',
        verification: 'core.hooksPath',
        hooksPath: hooksPath || null,
        message: ''
      };
    }
  } catch {
    // Fall through to git-path fallback for worktree-safe verification
  }

  const hooksDir = resolveGitHooksDir();
  if (hooksDir) {
    const missingHooks = requiredHooks.filter(hook => !fileLooksLikeActiveHook(path.join(hooksDir, hook)));
    const active = missingHooks.length === 0;
    return {
      active,
      state: active ? 'active' : 'inactive',
      verification: 'git-path-hooks',
      hooksPath: hooksPath || null,
      hooksDir,
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

function checkRuntimeHealth(projectRoot, options = {}) {
  const platform = options.platform || process.platform;
  const root = normalizeProjectRoot(projectRoot);

  const hooks = checkHookInstallation(root, options);
  const lefthook = checkLefthookStatus(root);
  const bd = checkCommandAvailability('bd', root, options);
  const gh = checkCommandAvailability('gh', root, options);
  const jq = checkCommandAvailability('jq', root, options);
  const shell = normalizeShellRuntime(options.shellRuntime, platform, options);

  const diagnostics = [];

  const lefthookMissing = lefthook.state === 'missing-dependency'
    || lefthook.state === 'missing-binary';

  if (lefthookMissing) {
    diagnostics.push(createDiagnostic(
      'LEFTHOOK_MISSING',
      'lefthook',
      lefthook.message || 'lefthook is required for hook installation.',
      'bun add -D lefthook && bun install'
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
    diagnostics.push(createDiagnostic(
      'BD_MISSING',
      'bd',
      'bd is required for stage-entry workflow checks.'
    ));
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
    checks: {
      projectRoot: root,
      lefthook,
      hooks,
      bd,
      gh,
      jq,
      shell
    }
  };
}

module.exports = {
  checkRuntimeHealth,
  checkHookInstallation,
  checkCommandAvailability,
  resolveShellRuntime
};
