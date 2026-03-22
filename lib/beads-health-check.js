/**
 * Beads health check smoke test.
 *
 * After Beads init, runs a quick create/close/sync/cleanup cycle to verify
 * the installation is functional.
 *
 * @module beads-health-check
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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
  const match = output.match(/Created\s+issue:\s*([\w-]+)/i);
  return match ? match[1].trim() : null;
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

  /** @type {string|null} */
  let issueId = null;
  /** @type {string|undefined} */
  let warning;

  // Step a: Create a test issue
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
    const jsonlPath = path.join(projectRoot, '.beads', 'issues.jsonl');
    const content = fs.readFileSync(jsonlPath, 'utf8');
    const lines = content.split('\n').filter(Boolean);

    const filtered = lines.filter((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed.id !== issueId;
      } catch (_parseErr) {
        // Keep unparseable lines as-is
        return true;
      }
    });

    fs.writeFileSync(jsonlPath, filtered.length > 0 ? filtered.join('\n') + '\n' : '');
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
