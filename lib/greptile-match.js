'use strict';

const { GreptileReviewAdapter } = require('./adapters/greptile-review-adapter');

/**
 * Match unresolved review threads to recent commits that touched the same files.
 *
 * This backward-compatible export now delegates to the Greptile review adapter
 * so existing Greptile scripts keep working while new review integrations use
 * the ReviewAdapter SPI.
 *
 * @param {Array<{file: string, line: number}>} threads - Review threads with file paths
 * @param {string} projectRoot - Absolute path to the project root (used with git -C)
 * @param {object} [opts] - Options
 * @param {Function} [opts._exec] - Injected exec function for testing
 * @param {string} [opts.sinceCommit] - Merge-base SHA to restrict log to PR commits only
 * @returns {Array<{file: string, line: number, resolved: boolean, sha?: string, reason?: string}>}
 */
function matchThreadsToCommits(threads, projectRoot, opts = {}) {
  const adapter = new GreptileReviewAdapter();
  return adapter.score(threads, { ...opts, projectRoot });
}

module.exports = { matchThreadsToCommits };
