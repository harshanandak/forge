/**
 * Beads health check smoke test.
 *
 * After Beads init, runs a quick create/close/sync/cleanup cycle to verify
 * the installation is functional.
 *
 * @module beads-health-check
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/**
 * @typedef {Object} HealthCheckResult
 * @property {boolean} healthy - Whether Beads is operational
 * @property {string|null} failedStep - Which step failed: 'create'|'close'|'sync'|'cleanup', or null
 * @property {string|null} error - Error message if unhealthy, null otherwise
 * @property {string} [warning] - Non-fatal warning message (e.g. sync or cleanup issues)
 */

/**
 * Parse the issue ID from `bd create` stdout.
 *
 * Expects output like "Created issue: forge-xxxx".
 *
 * @param {string} output - stdout from `bd create`
 * @returns {string|null} The issue ID, or null if not found
 */
function parseIssueId(output) {
  const match = /Created\s+issue:\s*([\w-]+)/i.exec(output);
  return match ? match[1].trim() : null;
}

/**
 * Remove a test issue from the JSONL file by its ID.
 * Silently ignores errors (file missing, locked, malformed lines).
 *
 * @param {string} jsonlPath - Absolute path to the issues.jsonl file
 * @param {string|null} issueId - The issue ID to remove
 */
function cleanupTestIssue(jsonlPath, issueId) {
  if (!issueId) return;
  const raw = fs.readFileSync(jsonlPath, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  const filtered = lines.filter((line) => {
    try { return JSON.parse(line).id !== issueId; } catch (_e) { /* Expected: malformed JSONL line — keep it as-is */ return true; }
  });
  fs.writeFileSync(jsonlPath, filtered.length > 0 ? filtered.join('\n') + '\n' : '');
}

/**
 * Run a Beads health check smoke test.
 *
 * Creates a temporary issue, closes it, syncs, then cleans up the JSONL file.
 * Uses dependency injection for the exec function to support testing.
 *
 * @param {string} projectRoot - Absolute path to the project root
 * @param {Object} [options={}] - Options
 * @param {Function} [options._exec] - Injectable exec function (defaults to execFileSync)
 * @returns {HealthCheckResult}
 */
function beadsHealthCheck(projectRoot, options = {}) {
  const exec = options._exec || execFileSync;
  const execOpts = { cwd: projectRoot, encoding: 'utf8' };

  /** @type {string|undefined} */
  let warning;

  // Step a: Create a test issue
  /** @type {string|null} */
  let issueId;
  try {
    const createOutput = exec('bd', [
      'create',
      '--title=Setup verification',
      '--type=task',
      '--priority=4'
    ], execOpts);

    issueId = parseIssueId(createOutput);
    if (!issueId) {
      return {
        healthy: false,
        failedStep: 'create',
        error: 'Could not parse issue ID from bd create output'
      };
    }
  } catch (err) {
    return {
      healthy: false,
      failedStep: 'create',
      error: err.message
    };
  }

  // Step b: Close the test issue
  try {
    exec('bd', [
      'close',
      issueId,
      '--reason=Setup smoke test'
    ], execOpts);
  } catch (err) {
    // Best-effort cleanup: remove the test issue from JSONL so it doesn't leak
    try {
      cleanupTestIssue(path.join(projectRoot, '.beads', 'issues.jsonl'), issueId);
    } catch (_cleanupErr) {
      // Expected: JSONL cleanup may fail if file is locked or missing — nothing more we can do
    }
    return {
      healthy: false,
      failedStep: 'close',
      error: err.message
    };
  }

  // Step c: Sync (may fail without a remote -- that's OK)
  try {
    exec('bd', ['sync'], execOpts);
  } catch (syncErr) {
    // Sync failure is non-fatal (no remote configured is common)
    warning = `bd sync warning: ${syncErr.message}`;
  }

  // Step d: Remove the test issue from JSONL
  try {
    cleanupTestIssue(path.join(projectRoot, '.beads', 'issues.jsonl'), issueId);
  } catch (cleanupErr) {
    // Cleanup failure is non-fatal
    const cleanupWarning = `cleanup warning: ${cleanupErr.message}`;
    warning = warning ? `${warning}; ${cleanupWarning}` : cleanupWarning;
  }

  return {
    healthy: true,
    failedStep: null,
    error: null,
    ...(warning ? { warning } : {})
  };
}

module.exports = { beadsHealthCheck, parseIssueId };
