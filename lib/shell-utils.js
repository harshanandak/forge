/**
 * Shell execution utility wrappers
 * Extracted from bin/forge.js for reuse and testability
 * @module lib/shell-utils
 */

const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');

// Extensions Windows can spawn directly via CreateProcess. Anything else that
// `where.exe` returns — the extensionless POSIX shim (`npm`) or the batch shim
// (`npm.cmd`) — cannot be handed to execFileSync: the former is a bash script
// (spawnSync ENOENT, kernel issue 9997d516) and patched Node refuses .cmd/.bat
// without shell:true (CVE-2024-27980).
const WINDOWS_DIRECT_SPAWN_EXTS = new Set(['.exe', '.com']);

// Conservative allowlist for tokens executed through cmd.exe. Blocks every cmd
// metacharacter (& | < > ^ % ! " ' ` ( ) ; and whitespace) so shell execution
// cannot be turned into injection even if a caller ever passes dynamic input.
const SAFE_SHELL_TOKEN = /^[A-Za-z0-9@_+=:,./\\-]+$/;

/**
 * Throw when any token is unsafe to pass through cmd.exe.
 * @param {string} command - The command name
 * @param {string[]} args - Command arguments
 */
function assertShellSafeTokens(command, args) {
  for (const token of [command, ...args]) {
    if (typeof token !== 'string' || !SAFE_SHELL_TOKEN.test(token)) {
      throw new Error(
        `Refusing to run "${command}" via shell: unsafe token ${JSON.stringify(token)}`
      );
    }
  }
}

/**
 * Decide how to spawn a command on Windows from `where.exe` candidates.
 * Prefers a directly spawnable .exe/.com; otherwise runs the BARE command name
 * through cmd.exe (shell:true), which resolves npm.cmd/npx.cmd/lefthook.cmd
 * via PATH/PATHEXT — so paths with spaces never hit shell parsing.
 *
 * @param {string} command - Original command name
 * @param {string[]} candidates - Resolved paths from `where.exe`, best first
 * @returns {{ file: string, shell: boolean }}
 */
function resolveWindowsSpawnSpec(command, candidates) {
  const direct = candidates.find(
    (candidate) => WINDOWS_DIRECT_SPAWN_EXTS.has(path.extname(candidate).toLowerCase())
  );
  if (direct) {
    return { file: direct, shell: false };
  }
  return { file: command, shell: true };
}

/**
 * Securely execute a command with PATH validation.
 * Mitigates SonarCloud S4036: Ensures executables are from trusted locations.
 * On Windows, handles npm/npx/lefthook-style cmd shims that cannot be spawned
 * directly (see resolveWindowsSpawnSpec).
 * @param {string} command - The command to execute
 * @param {string[]} [args=[]] - Command arguments
 * @param {object} [options={}] - execFileSync options
 * @returns {Buffer|string} Command output
 */
function secureExecFileSync(command, args = [], options = {}) {
  const {
    _execFileSync = execFileSync,
    _spawnSync = spawnSync,
    _platform = process.platform,
    ...execOptions
  } = options;

  const isWindows = _platform === 'win32';
  const pathResolver = isWindows ? 'where.exe' : 'which';

  let candidates = [];
  try {
    // Resolve command's full path to validate it's in a trusted location
    const result = _spawnSync(pathResolver, [command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });

    if (result.status === 0 && result.stdout) {
      // Handle both CRLF (Windows) and LF (Unix) line endings
      candidates = result.stdout
        .trim()
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    }
  } catch (_err) { // NOSONAR - S2486: Intentionally ignored; falls back to direct command execution below
  }

  if (isWindows) {
    const spec = resolveWindowsSpawnSpec(command, candidates);
    if (spec.shell) {
      assertShellSafeTokens(command, args);
      return _execFileSync(command, args, { ...execOptions, shell: true });
    }
    return _execFileSync(spec.file, args, execOptions);
  }

  // Fall back only when resolution failed. If execution of the resolved binary
  // throws, propagate that error instead of retrying with the unresolved name.
  return _execFileSync(candidates[0] || command, args, execOptions);
}

module.exports = {
  secureExecFileSync
};
