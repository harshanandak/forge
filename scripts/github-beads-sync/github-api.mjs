/**
 * GitHub API caller module using `gh api` CLI.
 * Builds argument arrays for execFileSync('gh', args) — no shell invocation.
 * @module github-api
 */

import { execFileSync } from 'node:child_process';

const SYNC_MARKER = '<!-- beads-sync:';

/**
 * Builds args for listing all comments on a GitHub issue.
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number|string} issueNumber - Issue number
 * @returns {string[]} Args array for execFileSync('gh', args)
 */
export function buildFindCommentsArgs(owner, repo, issueNumber) {
  return [
    'api',
    `repos/${owner}/${repo}/issues/${issueNumber}/comments`,
  ];
}

/**
 * Finds the beads-sync comment in a list of comment objects.
 * @param {Array<{id: number, body: string}>} comments - Array of GitHub comment objects
 * @returns {{id: number, body: string}|null} The sync comment or null
 */
export function parseFindSyncComment(comments) {
  const match = comments.find((c) => c.body && c.body.includes(SYNC_MARKER));
  if (!match) return null;
  return { id: match.id, body: match.body };
}

/**
 * Builds args for creating a comment on a GitHub issue.
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number|string} issueNumber - Issue number
 * @param {string} body - Comment body
 * @returns {string[]} Args array for execFileSync('gh', args)
 */
export function buildCreateCommentArgs(owner, repo, issueNumber, body) {
  return [
    'api',
    `repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    '-f',
    `body=${body}`,
  ];
}

/**
 * Builds args for editing an existing comment.
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number|string} commentId - Comment ID
 * @param {string} body - Updated comment body
 * @returns {string[]} Args array for execFileSync('gh', args)
 */
export function buildEditCommentArgs(owner, repo, commentId, body) {
  return [
    'api',
    `repos/${owner}/${repo}/issues/comments/${commentId}`,
    '-X',
    'PATCH',
    '-f',
    `body=${body}`,
  ];
}

/**
 * Builds args for closing a GitHub issue.
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number|string} issueNumber - Issue number
 * @returns {string[]} Args array for execFileSync('gh', args)
 */
export function buildCloseIssueArgs(owner, repo, issueNumber) {
  return [
    'api',
    `repos/${owner}/${repo}/issues/${issueNumber}`,
    '-X',
    'PATCH',
    '-f',
    'state=closed',
  ];
}

/**
 * Finds the existing beads-sync comment on an issue, or returns null.
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number|string} issueNumber - Issue number
 * @returns {{id: number, body: string}|null}
 */
export function findSyncComment(owner, repo, issueNumber) {
  const args = buildFindCommentsArgs(owner, repo, issueNumber);
  const raw = execFileSync('gh', args, { encoding: 'utf-8' });
  const comments = JSON.parse(raw);
  return parseFindSyncComment(comments);
}

/**
 * Creates or edits the beads-sync comment on an issue.
 * If a sync comment already exists, edits it; otherwise creates a new one.
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number|string} issueNumber - Issue number
 * @param {string} body - Comment body (should contain the beads-sync marker)
 * @returns {void}
 */
export function createOrEditComment(owner, repo, issueNumber, body) {
  const existing = findSyncComment(owner, repo, issueNumber);
  const args = existing
    ? buildEditCommentArgs(owner, repo, existing.id, body)
    : buildCreateCommentArgs(owner, repo, issueNumber, body);
  execFileSync('gh', args, { encoding: 'utf-8' });
}

/**
 * Closes a GitHub issue.
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number|string} issueNumber - Issue number
 * @returns {void}
 */
export function closeIssue(owner, repo, issueNumber) {
  const args = buildCloseIssueArgs(owner, repo, issueNumber);
  execFileSync('gh', args, { encoding: 'utf-8' });
}
