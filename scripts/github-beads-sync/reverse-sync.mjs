/**
 * Reverse sync: Beads → GitHub.
 * When a Beads issue is closed (via git push updating exported issue snapshots),
 * close the linked GitHub issue.
 *
 * @module scripts/github-beads-sync/reverse-sync
 */

import { execFileSync } from 'node:child_process';

/**
 * Parse JSONL lines into an array of objects, skipping empty/malformed lines.
 * @param {string[]} lines - Array of JSONL strings
 * @returns {Array<{id: string, status: string, description?: string}>}
 */
function parseJsonlLines(lines) {
  const results = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && obj.id) results.push(obj);
    } catch (_err) {
      // Skip malformed lines
    }
  }
  return results;
}

function extractCanonicalGitHubLink(issue = {}) {
  const github = issue.github ?? {};
  if (typeof github.url === 'string' && github.url.length > 0) {
    const match = github.url.match(
      /https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/,
    );
    if (match) {
      return {
        owner: match[1],
        repo: match[2],
        issueNumber: parseInt(match[3], 10),
      };
    }
  }
  return null;
}

function extractPreferredGitHubLink(issue = {}) {
  return extractCanonicalGitHubLink(issue) ?? extractGitHubUrl(issue.description);
}

/**
 * Detect Beads issues that transitioned to "closed" status.
 * Only detects transitions: issue must exist in oldLines as non-closed,
 * and appear in newLines as "closed".
 *
 * @param {string[]} oldLines - JSONL lines from a previous exported issue snapshot
 * @param {string[]} newLines - JSONL lines from a current exported issue snapshot
 * @returns {Array<{id: string, description: string}>} Issues that transitioned to closed
 */
export function detectClosedIssues(oldLines, newLines) {
  const oldMap = new Map();
  for (const issue of parseJsonlLines(oldLines)) {
    oldMap.set(issue.id, issue.status);
  }

  const closed = [];
  for (const issue of parseJsonlLines(newLines)) {
    if (issue.status !== 'closed') continue;
    const oldStatus = oldMap.get(issue.id);
    // Must have existed before and not been closed already
    if (oldStatus == null || oldStatus === 'closed') continue;
    closed.push({ id: issue.id, description: issue.description || '' });
  }
  return closed;
}

/**
 * Extract GitHub owner, repo, and issue number from a description string
 * containing a GitHub issue URL.
 *
 * @param {string|null|undefined} description - Text that may contain a GitHub issue URL
 * @returns {{owner: string, repo: string, issueNumber: number}|null}
 */
export function extractGitHubUrl(description) {
  if (!description) return null;
  const match = description.match(
    /https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/,
  );
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2],
    issueNumber: parseInt(match[3], 10),
  };
}

/**
 * Close a GitHub issue using the `gh api` CLI.
 * Uses execFileSync with array args (no shell).
 *
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number|string} issueNumber - Issue number
 */
export function closeGitHubIssue(owner, repo, issueNumber) {
  execFileSync('gh', [
    'api',
    `repos/${owner}/${repo}/issues/${issueNumber}`,
    '-X', 'PATCH',
    '-f', 'state=closed',
  ], { encoding: 'utf-8' });
}

/**
 * Handle Beads-to-GitHub reverse sync.
 * Detects issues that transitioned to closed in exported issue snapshot JSONL
 * and closes the linked GitHub issues.
 *
 * @param {string} oldContent - Previous exported issue snapshot content
 * @param {string} newContent - Current exported issue snapshot content
 * @param {object} [deps] - Dependency injection
 * @param {Function} [deps.closeGitHubIssue] - Override for testing
 * @returns {{closed: Array, skipped: Array, errors: Array}}
 */
export function handleBeadsClosed(oldContent, newContent, deps = {}) {
  const closeFn = deps.closeGitHubIssue ?? closeGitHubIssue;

  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  const transitions = detectClosedIssues(oldLines, newLines);
  const latestIssues = new Map(
    parseJsonlLines(newLines).map((issue) => [issue.id, issue]),
  );

  const closed = [];
  const skipped = [];
  const errors = [];

  for (const issue of transitions) {
    const parsed = extractPreferredGitHubLink(latestIssues.get(issue.id) ?? issue);
    if (!parsed) {
      skipped.push({ beadsId: issue.id, reason: 'no GitHub URL' });
      continue;
    }

    try {
      closeFn(parsed.owner, parsed.repo, parsed.issueNumber);
      closed.push({
        beadsId: issue.id,
        owner: parsed.owner,
        repo: parsed.repo,
        issueNumber: parsed.issueNumber,
      });
    } catch (err) {
      errors.push({ beadsId: issue.id, error: err.message });
    }
  }

  return { closed, skipped, errors };
}
