/**
 * Runtime prerequisite checks for stage entry.
 *
 * This module centralizes the hard-stop decision for hooks, shell helpers,
 * and toolchain prerequisites so stage commands do not have to infer readiness.
 *
 * @module lib/runtime-health
 */

const fs = require('node:fs');
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
  const expectedRelativeHooksPath = '.lefthook/hooks';
  const expectedAbsoluteHooksPath = `${projectRoot}/${expectedRelativeHooksPath}`.replaceAll('\\', '/');

  try {
    const output = exec('git', ['config', '--get', 'core.hooksPath'], {
      cwd: projectRoot,
      encoding: 'utf8'
    });

    const hooksPath = toText(output).trim().replaceAll('\\', '/');
    const active = hooksPath === expectedRelativeHooksPath || hooksPath === expectedAbsoluteHooksPath;

    return {
      active,
      state: active ? 'active' : 'inactive',
      hooksPath: hooksPath || null,
      message: active ? '' : 'Git hooks are not pointed at .lefthook/hooks.'
    };
  } catch {
    return {
      active: false,
      state: 'unverified',
      hooksPath: null,
      message: 'Git hooks could not be verified.'
    };
  }
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

  const lefthook = checkLefthookStatus(root);
  const hooks = checkHookInstallation(root, options);
  const bd = checkCommandAvailability('bd', root, options);
  const gh = checkCommandAvailability('gh', root, options);
  const jq = checkCommandAvailability('jq', root, options);
  const shell = normalizeShellRuntime(options.shellRuntime, platform, options);

  const diagnostics = [];

  if (lefthook.state !== 'installed') {
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
