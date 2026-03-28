'use strict';

const { execFileSync } = require('node:child_process');

/**
 * Match unresolved review threads to recent commits that touched the same files.
 *
 * For each thread, runs `git log --oneline --follow -- <file>` to find
 * recent commits. If a commit exists, the thread is considered resolved
 * (the file was modified after the review comment).
 *
 * Uses execFileSync (not exec) to prevent shell injection (OWASP A03).
 *
 * @param {Array<{file: string, line: number}>} threads - Review threads with file paths
 * @param {string} projectRoot - Absolute path to the project root (used with git -C)
 * @param {object} [opts] - Options
 * @param {Function} [opts._exec] - Injected exec function for testing (defaults to execFileSync)
 * @param {string} [opts.sinceCommit] - Merge-base SHA to restrict log to PR commits only
 * @returns {Array<{file: string, line: number, resolved: boolean, sha?: string, reason?: string}>}
 */
function matchThreadsToCommits(threads, projectRoot, opts = {}) {
  if (!threads || threads.length === 0) {
    return [];
  }

  const exec = opts._exec || ((cmd, args) => {
    return execFileSync(cmd, args, { encoding: 'utf8' });
  });

  // Determine commit range — restrict to PR commits when sinceCommit provided
  let sinceCommit = opts.sinceCommit;
  if (!sinceCommit) {
    try {
      sinceCommit = exec('git', ['-C', projectRoot, 'merge-base', 'HEAD', 'main']).trim();
    } catch (_e) {
      /* intentional: main branch not found, try master instead */
      try {
        sinceCommit = exec('git', ['-C', projectRoot, 'merge-base', 'HEAD', 'master']).trim();
      } catch (_e2) { /* intentional: no merge-base available, fall back to unbounded log */
        sinceCommit = null;
      }
    }
  }

  return threads.map((thread) => {
    const { file, line } = thread;

    try {
      const logArgs = [
        '-C', projectRoot,
        'log',
        '--oneline',
        '--follow',
      ];
      if (sinceCommit) {
        logArgs.push(`${sinceCommit}..HEAD`);
      }
      logArgs.push('--', file);

      const output = exec('git', logArgs);

      const trimmed = (output || '').trim();

      if (!trimmed) {
        return { file, line, resolved: false, reason: 'no matching commit' };
      }

      // git log --oneline format: "<sha> <message>"
      // Take the first (most recent) line
      const firstLine = trimmed.split('\n')[0];
      const sha = firstLine.split(' ')[0];

      return { file, line, resolved: true, sha };
    } catch (_err) { /* intentional: git log failed (file missing or git unavailable), mark unresolved */
      return { file, line, resolved: false, reason: 'no matching commit' };
    }
  });
}

module.exports = { matchThreadsToCommits };
