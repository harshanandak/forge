/**
 * Main entry point for GitHub-Beads issue sync.
 * Orchestrates all Wave 1 modules to handle GitHub webhook events.
 *
 * @module scripts/github-beads-sync/index
 */

import { readFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { sanitizeTitle } from './sanitize.mjs';
import { mapLabels } from './label-mapper.mjs';
import { bdCreate as realBdCreate, bdClose as realBdClose, bdShow as realBdShow } from './run-bd.mjs';
import { getBeadsId as realGetBeadsId, setBeadsId as realSetBeadsId } from './mapping.mjs';
import { buildComment, parseComment } from './comment.mjs';
import {
  findSyncComment as realFindSyncComment,
  createOrEditComment as realCreateOrEditComment,
} from './github-api.mjs';

/**
 * Check if a sender login matches known bot patterns.
 * @param {string} login - GitHub sender login
 * @returns {boolean}
 */
function isBot(login) {
  if (!login) return false;
  return login.includes('[bot]') || login === 'github-actions';
}

/**
 * Check if an issue has the skip-beads-sync label.
 * @param {Array<{name: string}|string>} labels
 * @returns {boolean}
 */
function hasSkipLabel(labels) {
  if (!labels) return false;
  return labels.some((l) => {
    const name = typeof l === 'string' ? l : l.name;
    return name === 'skip-beads-sync';
  });
}

/**
 * Handle a GitHub issue "opened" event.
 *
 * @param {object} event - Parsed GitHub webhook payload
 * @param {object} options
 * @param {string} [options.configPath] - Path to config JSON
 * @param {string} options.mappingPath - Path to mapping JSON
 * @param {string} options.owner - Repository owner
 * @param {string} options.repo - Repository name
 * @param {object} [options.bd] - Dependency injection for bd functions
 * @param {object} [options.github] - Dependency injection for github-api functions
 * @param {object} [options.mapping] - Dependency injection for mapping functions
 * @param {object} [options.configOverride] - Merge into loaded config (for testing)
 * @returns {object} Result object
 */
export function handleOpened(event, options = {}) {
  const {
    configPath,
    mappingPath,
    owner,
    repo,
    bd = {},
    github = {},
    mapping = {},
    configOverride,
  } = options;

  const bdCreate = bd.bdCreate ?? realBdCreate;
  const findSyncComment = github.findSyncComment ?? realFindSyncComment;
  const createOrEditComment = github.createOrEditComment ?? realCreateOrEditComment;
  const getBeadsId = mapping.getBeadsId ?? realGetBeadsId;
  const setBeadsId = mapping.setBeadsId ?? realSetBeadsId;

  // 1. Load config
  let config = loadConfig(configPath);
  if (configOverride) {
    config = { ...config, ...configOverride };
  }

  // 2. Extract event data
  const issue = event.issue;
  const issueNumber = issue.number;
  const rawTitle = issue.title;
  const labels = issue.labels || [];
  const assignee = config.mapAssignee ? issue.assignee?.login : undefined;
  const htmlUrl = issue.html_url;
  const body = issue.body ?? '';
  const authorAssociation = issue.author_association;

  // 3. Guard: bot actor
  if (isBot(event.sender?.login)) {
    return { skipped: true, reason: 'bot actor' };
  }

  // 4. Guard: skip label
  if (hasSkipLabel(labels)) {
    return { skipped: true, reason: 'skip label' };
  }

  // 5. Guard: no-beads body
  if (body.includes('no-beads')) {
    return { skipped: true, reason: 'no-beads in body' };
  }

  // 6. Guard: public repo gate
  if (config.publicRepoGate === 'author_association') {
    const allowed = config.gateAssociations || [];
    if (!allowed.includes(authorAssociation)) {
      return { skipped: true, reason: 'author not authorized' };
    }
  } else if (config.publicRepoGate === 'label') {
    const gateLabelName = config.gateLabelName || 'beads-track';
    const hasGateLabel = labels.some((l) => {
      const name = typeof l === 'string' ? l : l.name;
      return name === gateLabelName;
    });
    if (!hasGateLabel) {
      return { skipped: true, reason: `missing required label: ${gateLabelName}` };
    }
  }

  // 7. Idempotency — check mapping file first (fast, survives comment deletion)
  const existingBeadsId = getBeadsId(mappingPath, issueNumber);
  if (existingBeadsId) {
    // Mapping exists — ensure the GitHub comment is present (repair if deleted)
    const existingComment = findSyncComment(owner, repo, issueNumber);
    if (!existingComment) {
      const externalRef = `gh-${issueNumber}`;
      const commentBody = buildComment(existingBeadsId, issueNumber, { externalRef, repaired: true });
      createOrEditComment(owner, repo, issueNumber, commentBody);
    }
    return {
      skipped: true,
      reason: 'already synced (mapping file)',
      beadsId: existingBeadsId,
    };
  }

  // 7b. Fallback idempotency — check for existing sync comment
  const existingComment = findSyncComment(owner, repo, issueNumber);
  if (existingComment) {
    const parsed = parseComment(existingComment.body);
    // Repair mapping file from comment
    if (parsed?.beadsId) {
      setBeadsId(mappingPath, issueNumber, parsed.beadsId);
    }
    return {
      skipped: true,
      reason: 'already synced (comment)',
      beadsId: parsed?.beadsId ?? null,
    };
  }

  // 8. Sanitize title (labels mapped from raw names — sanitization only needed for CLI args)
  const { sanitized: sanitizedTitle, warnings: titleWarnings } = sanitizeTitle(rawTitle);
  if (titleWarnings.length) console.warn('sanitize:', titleWarnings);

  // 9. Map labels using raw names (case-insensitive matching in mapLabels handles normalization)
  const rawLabelNames = labels.map((l) => (typeof l === 'string' ? l : l.name));
  const { type, priority } = mapLabels(rawLabelNames, config);

  // 10. Create beads issue
  const externalRef = `gh-${issueNumber}`;
  const beadsId = bdCreate({
    title: sanitizedTitle,
    type,
    priority,
    assignee,
    description: htmlUrl,
    externalRef,
  });

  if (!beadsId) {
    return { success: false, reason: 'bd create failed — no beads ID returned', issueNumber };
  }

  // 11. Update mapping
  setBeadsId(mappingPath, issueNumber, beadsId);

  // 12. Build and post comment
  const commentBody = buildComment(beadsId, issueNumber, { type, priority, externalRef });
  createOrEditComment(owner, repo, issueNumber, commentBody);

  // 13. Return success
  return { success: true, beadsId, issueNumber };
}

/**
 * Handle a GitHub issue "closed" event.
 *
 * @param {object} event - Parsed GitHub webhook payload
 * @param {object} options
 * @param {string} options.mappingPath - Path to mapping JSON
 * @param {string} options.owner - Repository owner
 * @param {string} options.repo - Repository name
 * @param {object} [options.bd] - Dependency injection for bd functions
 * @param {object} [options.github] - Dependency injection for github-api functions
 * @param {object} [options.mapping] - Dependency injection for mapping functions
 * @returns {object} Result object
 */
export function handleClosed(event, options = {}) {
  const {
    mappingPath,
    owner,
    repo,
    bd = {},
    github = {},
    mapping = {},
  } = options;

  const bdClose = bd.bdClose ?? realBdClose;
  const bdShow = bd.bdShow ?? realBdShow;
  const getBeadsId = mapping.getBeadsId ?? realGetBeadsId;
  const findSyncComment = github.findSyncComment ?? realFindSyncComment;

  // 1. Extract issue number, labels, and state reason
  const issueNumber = event.issue.number;
  const labels = event.issue.labels || [];
  const stateReason = event.issue.state_reason;

  // 2. Guard: bot actor
  if (isBot(event.sender?.login)) {
    return { skipped: true, reason: 'bot actor' };
  }

  // 3. Guard: skip label
  if (hasSkipLabel(labels)) {
    return { skipped: true, reason: 'skip label' };
  }

  // 4. Guard: skip "not planned" closures (only close on "completed")
  if (stateReason && stateReason !== 'completed') {
    return { skipped: true, reason: `closed as ${stateReason}` };
  }

  // 4. Read mapping
  let beadsId = getBeadsId(mappingPath, issueNumber);

  // 5. Fallback: find via sync comment
  if (!beadsId) {
    const comment = findSyncComment(owner, repo, issueNumber);
    if (comment) {
      const parsed = parseComment(comment.body);
      // Verify the comment's tagged issue number matches current issue (prevents cross-issue close)
      if (parsed && parsed.issueNumber === issueNumber) {
        beadsId = parsed.beadsId;
      }
    }
  }

  // 6. No beads link found
  if (!beadsId) {
    return { skipped: true, reason: 'no beads link found' };
  }

  // 7. Check if already closed
  const status = bdShow(beadsId);
  if (status === null) {
    return { skipped: true, reason: 'could not determine beads status' };
  }
  if (status === 'closed') {
    return { skipped: true, reason: 'already closed' };
  }

  // 8. Close beads issue
  bdClose(beadsId, `Closed via GitHub issue #${issueNumber}`);

  // 9. Return success
  return { success: true, beadsId, issueNumber };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  const action = process.argv[2];
  const eventPath = process.env.GITHUB_EVENT_PATH || process.argv[3];

  if (!action || !eventPath) {
    console.error('Usage: node index.mjs <opened|closed> [event-path]');
    console.error('  GITHUB_EVENT_PATH env var is used if event-path arg is omitted.');
    process.exit(1);
  }

  const event = JSON.parse(readFileSync(eventPath, 'utf-8'));
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || 'unknown/unknown').split('/');

  const options = {
    configPath: process.env.BEADS_SYNC_CONFIG || undefined,
    mappingPath: process.env.BEADS_SYNC_MAPPING || '.github/beads-mapping.json',
    owner,
    repo,
  };

  // Validate action explicitly — only allow known actions
  const VALID_ACTIONS = ['opened', 'closed'];
  if (!VALID_ACTIONS.includes(action)) {
    console.error(`Unknown action: "${action}". Expected one of: ${VALID_ACTIONS.join(', ')}`);
    process.exit(1);
  }

  const handler = action === 'opened' ? handleOpened : handleClosed;

  Promise.resolve(handler(event, options))
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));

      // Exit non-zero on logical failure (e.g., bdCreate returned null)
      if (result.success === false) {
        console.error(`Sync failed: ${result.reason || 'unknown'}`);
        process.exit(1);
      }

      // Write to GITHUB_OUTPUT if available
      const outputPath = process.env.GITHUB_OUTPUT;
      if (outputPath) {
        for (const [key, value] of Object.entries(result)) {
          if (value != null) {
            appendFileSync(outputPath, `${key}=${value}\n`);
          }
        }
      }
    })
    .catch((err) => {
      console.error('Fatal:', err.message);
      process.exit(1);
    });
}
