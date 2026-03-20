/**
 * Bot comment parser/builder for GitHub-Beads sync.
 *
 * Produces and parses Vercel-inspired sync comments that use an
 * edit-don't-create pattern with a stable HTML comment tag.
 *
 * @module comment
 */

/** HTML comment prefix used to identify sync comments. */
export const SYNC_TAG_PREFIX = '<!-- beads-sync:';

/**
 * Build a markdown sync comment for a GitHub issue.
 *
 * @param {string} beadsId   - The Beads issue ID (e.g. "forge-abc").
 * @param {number} issueNumber - The GitHub issue number.
 * @param {object} [metadata]  - Optional metadata fields.
 * @param {string} [metadata.type]        - Issue type (feature, bug, etc.).
 * @param {string} [metadata.priority]    - Priority label (P0-P4).
 * @param {string} [metadata.externalRef] - External reference string.
 * @returns {string} Markdown comment body.
 */
export function buildComment(beadsId, issueNumber, metadata = {}) {
  const timestamp = new Date().toISOString();

  const detailLines = [];
  if (metadata.type) detailLines.push(`- Type: ${metadata.type}`);
  if (metadata.priority) detailLines.push(`- Priority: ${metadata.priority}`);
  if (metadata.externalRef) detailLines.push(`- External ref: ${metadata.externalRef}`);
  detailLines.push(`- Synced: ${timestamp}`);

  return [
    `${SYNC_TAG_PREFIX}${issueNumber} -->`,
    `**Beads:** \`${beadsId}\``,
    '<details>',
    '<summary>Sync details</summary>',
    '',
    ...detailLines,
    '</details>',
  ].join('\n');
}

/**
 * Parse a comment body and extract sync metadata.
 *
 * @param {string|null|undefined} commentBody - Raw comment markdown.
 * @returns {{ beadsId: string, issueNumber: number } | null}
 *   Extracted IDs, or `null` if the comment is not a sync comment.
 */
export function parseComment(commentBody) {
  if (!commentBody) return null;

  const tagMatch = commentBody.match(/<!--\s*beads-sync:(\d+)\s*-->/);
  if (!tagMatch) return null;

  const beadsMatch = commentBody.match(/\*\*Beads:\*\*\s*`(forge-[a-z0-9]+)`/);
  if (!beadsMatch) return null;

  return {
    beadsId: beadsMatch[1],
    issueNumber: Number(tagMatch[1]),
  };
}
