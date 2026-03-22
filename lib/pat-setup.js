/**
 * Guided PAT (Personal Access Token) setup for Beads GitHub sync.
 *
 * Walks the user through creating a fine-grained PAT and saving it
 * as a repository secret via the `gh` CLI. Token values are never
 * printed to stdout — they are piped to `gh secret set` via stdin.
 *
 * @module pat-setup
 */

const { execFileSync: defaultExecFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// checkGhAuth
// ---------------------------------------------------------------------------

/**
 * Check whether the user is authenticated to GitHub via `gh auth status`.
 *
 * @param {object} [options={}]
 * @param {Function} [options._exec] - DI override for execFileSync
 * @returns {{ authenticated: boolean, user: string|null }}
 */
function checkGhAuth(options = {}) {
  const exec = options._exec || defaultExecFileSync;
  try {
    const output = exec('gh', ['auth', 'status'], { encoding: 'utf8' });
    const str = typeof output === 'string' ? output : output.toString('utf8');
    const match = str.match(/account\s+(\S+)/);
    return {
      authenticated: true,
      user: match ? match[1] : null
    };
  } catch (_err) {
    return { authenticated: false, user: null };
  }
}

// ---------------------------------------------------------------------------
// validateToken
// ---------------------------------------------------------------------------

/**
 * Validate that a string looks like a GitHub PAT.
 *
 * Accepts tokens starting with `ghp_` or `github_pat_` followed by at
 * least one additional character.
 *
 * @param {string|undefined} token
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateToken(token) {
  if (!token || typeof token !== 'string' || token.trim() === '') {
    return { valid: false, reason: 'Token is empty or not provided.' };
  }

  const trimmed = token.trim();

  // Must start with a known prefix AND have content after the prefix
  const ghpValid = trimmed.startsWith('ghp_') && trimmed.length > 'ghp_'.length;
  const patValid = trimmed.startsWith('github_pat_') && trimmed.length > 'github_pat_'.length;

  if (!ghpValid && !patValid) {
    return {
      valid: false,
      reason: 'Token must start with "ghp_" or "github_pat_" followed by additional characters.'
    };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// saveSecret
// ---------------------------------------------------------------------------

/**
 * Save a token as a GitHub repository secret via `gh secret set`.
 *
 * The token is piped to stdin (via the `input` option of execFileSync)
 * so that it never appears in process arguments or stdout.
 *
 * @param {string} secretName - Name of the repository secret
 * @param {string} token - The PAT value (piped via stdin, never logged)
 * @param {object} [options={}]
 * @param {Function} [options._exec] - DI override for execFileSync
 * @returns {{ success: boolean, error: string|null }}
 */
function saveSecret(secretName, token, options = {}) {
  const exec = options._exec || defaultExecFileSync;
  try {
    exec('gh', ['secret', 'set', secretName], {
      input: token,
      encoding: 'utf8'
    });
    return { success: true, error: null };
  } catch (err) {
    const msg = err.stderr
      ? (typeof err.stderr === 'string' ? err.stderr : err.stderr.toString('utf8'))
      : err.message;
    return { success: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// setupPAT
// ---------------------------------------------------------------------------

/**
 * Orchestrate the full PAT setup flow.
 *
 * In non-interactive mode the step is skipped entirely. When `gh` is not
 * authenticated the user receives manual instructions. Otherwise the
 * function prompts for a token, validates it, and saves it as the
 * `BEADS_SYNC_TOKEN` repository secret.
 *
 * @param {string} _projectRoot - Absolute path to the project root
 * @param {object} [options={}]
 * @param {boolean} [options.interactive=true] - Whether prompts are allowed
 * @param {Function} [options._exec] - DI override for execFileSync
 * @param {Function} [options._prompt] - DI override for user input prompt
 * @returns {{ success: boolean, method: string, error?: string, reminder?: string, instructions?: string }}
 */
function setupPAT(_projectRoot, options = {}) {
  const { interactive = true, _prompt } = options;

  // Non-interactive: skip entirely
  if (!interactive) {
    return {
      success: false,
      method: 'skipped',
      reminder: 'Run "forge setup" interactively to configure the Beads sync PAT, or manually set the BEADS_SYNC_TOKEN repository secret.'
    };
  }

  // Check gh authentication
  const auth = checkGhAuth(options);

  if (!auth.authenticated) {
    const instructions = [
      'GitHub CLI is not authenticated. To set up the Beads sync token manually:',
      '1. Go to https://github.com/settings/tokens?type=beta',
      '2. Create a fine-grained PAT with "repo" scope',
      '3. Run: gh secret set BEADS_SYNC_TOKEN',
      '   (or add it via your repo Settings > Secrets > Actions)'
    ].join('\n');
    console.log(`  ${instructions.replace(/\n/g, '\n  ')}`);
    return {
      success: false,
      method: 'manual',
      instructions
    };
  }

  // Prompt for token
  if (!_prompt) {
    console.log('  No prompt function provided — skipping PAT setup.');
    console.log('  Run "gh secret set BEADS_SYNC_TOKEN" manually to configure.');
    return {
      success: false,
      method: 'manual',
      error: 'No prompt function available for interactive token input'
    };
  }

  const token = _prompt();

  // Validate
  const validation = validateToken(token);
  if (!validation.valid) {
    console.log(`  Invalid token: ${validation.reason}`);
    return {
      success: false,
      method: 'automated',
      error: validation.reason
    };
  }

  // Save the secret — token is piped via stdin, never logged
  const saveResult = saveSecret('BEADS_SYNC_TOKEN', token, options);

  if (!saveResult.success) {
    console.log(`  Failed to save secret: ${saveResult.error}`);
    return {
      success: false,
      method: 'automated',
      error: saveResult.error
    };
  }

  console.log('  PAT saved as BEADS_SYNC_TOKEN repository secret.');
  return {
    success: true,
    method: 'automated'
  };
}

module.exports = {
  checkGhAuth,
  validateToken,
  saveSecret,
  setupPAT
};
