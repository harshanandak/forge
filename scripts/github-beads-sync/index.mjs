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
import { resolveCanonicalBeadsLink, upsertCanonicalBeadsLink } from './mapping.mjs';
import { bdCreate as realBdCreate, bdClose as realBdClose, bdShow as realBdShow } from './run-bd.mjs';
import { buildComment, parseComment } from './comment.mjs';
import { createOrEditComment as realCreateOrEditComment, findSyncComment as realFindSyncComment } from './github-api.mjs';

const DEFAULT_MAPPING_PATH = '.github/beads-mapping.json';

function isBot(login) {
  if (!login) return false;
  return login.includes('[bot]') || login === 'github-actions';
}

function hasSkipLabel(labels) {
  if (!labels) return false;
  return labels.some((l) => {
    const name = typeof l === 'string' ? l : l.name;
    return name === 'skip-beads-sync';
  });
}

function getGitHubLink(issue = {}) {
  return {
    nodeId: issue.node_id ?? issue.nodeId ?? null,
    number: issue.number ?? null,
    url: issue.html_url ?? null,
  };
}

function createCanonicalLinkStore(mappingPath) {
  return {
    resolveCanonicalLink(lookup) {
      return resolveCanonicalBeadsLink(mappingPath, lookup);
    },
    upsertCanonicalLink(link) {
      return upsertCanonicalBeadsLink(mappingPath, link);
    },
  };
}

function getCanonicalLinkStore(options = {}) {
  const defaultStore = createCanonicalLinkStore(options.mappingPath ?? DEFAULT_MAPPING_PATH);

  if (
    options.linkStore &&
    typeof options.linkStore.resolveCanonicalLink === 'function' &&
    typeof options.linkStore.upsertCanonicalLink === 'function'
  ) {
    return options.linkStore;
  }

  return defaultStore;
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
 * @param {object} [options.linkStore] - Dependency injection for canonical link store
 * @param {object} [options.configOverride] - Merge into loaded config (for testing)
 * @returns {object} Result object
 */
export function handleOpened(event, options = {}) {
  const {
    configPath,
    owner,
    repo,
    bd = {},
    github = {},
    configOverride,
  } = options;

  const bdCreate = bd.bdCreate ?? realBdCreate;
  const createOrEditComment = github.createOrEditComment ?? realCreateOrEditComment;
  const findSyncComment = github.findSyncComment ?? realFindSyncComment;
  const canonicalLinkStore = getCanonicalLinkStore(options);

  let config = loadConfig(configPath);
  if (configOverride) {
    config = { ...config, ...configOverride };
  }

  const issue = event.issue;
  const issueNumber = issue.number;
  const rawTitle = issue.title;
  const labels = issue.labels || [];
  const assignee = config.mapAssignee ? issue.assignee?.login : undefined;
  const htmlUrl = issue.html_url;
  const body = issue.body ?? '';
  const authorAssociation = issue.author_association;
  const rawLabelNames = labels.map((l) => (typeof l === 'string' ? l : l.name));
  const { type, priority } = mapLabels(rawLabelNames, config);
  const externalRef = `gh-${issueNumber}`;

  if (isBot(event.sender?.login)) {
    return { skipped: true, reason: 'bot actor' };
  }

  if (hasSkipLabel(labels)) {
    return { skipped: true, reason: 'skip label' };
  }

  if (body.includes('no-beads')) {
    return { skipped: true, reason: 'no-beads in body' };
  }

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

  const canonicalLink = canonicalLinkStore.resolveCanonicalLink({
    githubNodeId: issue.node_id ?? issue.nodeId ?? null,
    githubNumber: issue.number,
  });
  if (canonicalLink) {
    const commentBody = buildComment(canonicalLink.forgeIssueId, issueNumber, {
      type,
      priority,
      externalRef,
    });
    createOrEditComment(owner, repo, issueNumber, commentBody);
    return {
      skipped: true,
      reason: 'already synced (canonical link)',
      beadsId: canonicalLink.forgeIssueId,
    };
  }

  const existingSyncComment = parseComment(findSyncComment(owner, repo, issueNumber)?.body);
  if (existingSyncComment?.beadsId) {
    canonicalLinkStore.upsertCanonicalLink({
      forgeIssueId: existingSyncComment.beadsId,
      github: getGitHubLink(issue),
      sources: [
        {
          source: 'syncComment',
          forgeIssueId: existingSyncComment.beadsId,
          githubNumber: issueNumber,
          url: htmlUrl,
        },
      ],
      diagnostics: [],
    });
    const commentBody = buildComment(existingSyncComment.beadsId, issueNumber, {
      type,
      priority,
      externalRef,
    });
    createOrEditComment(owner, repo, issueNumber, commentBody);
    return {
      skipped: true,
      reason: 'already synced (sync comment)',
      beadsId: existingSyncComment.beadsId,
    };
  }

  const { sanitized: sanitizedTitle, warnings: titleWarnings } = sanitizeTitle(rawTitle);
  if (titleWarnings.length) console.warn('sanitize:', titleWarnings);
  const beadsId = bdCreate({
    title: sanitizedTitle,
    type,
    priority,
    assignee,
    description: htmlUrl,
    externalRef,
  });

  if (!beadsId) {
    return { success: false, reason: 'bd create failed - no beads ID returned', issueNumber };
  }

  canonicalLinkStore.upsertCanonicalLink({
    forgeIssueId: beadsId,
    github: getGitHubLink(issue),
    sources: [
      {
        source: 'externalRef',
        forgeIssueId: beadsId,
        githubNumber: issueNumber,
        url: htmlUrl,
      },
    ],
    diagnostics: [],
  });

  const commentBody = buildComment(beadsId, issueNumber, { type, priority, externalRef });
  createOrEditComment(owner, repo, issueNumber, commentBody);

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
 * @param {object} [options.linkStore] - Dependency injection for canonical link store
 * @returns {object} Result object
 */
export function handleClosed(event, options = {}) {
  const {
    bd = {},
  } = options;

  const bdClose = bd.bdClose ?? realBdClose;
  const bdShow = bd.bdShow ?? realBdShow;
  const canonicalLinkStore = getCanonicalLinkStore(options);

  const issue = event.issue;
  const issueNumber = issue.number;
  const labels = issue.labels || [];
  const stateReason = issue.state_reason;

  if (isBot(event.sender?.login)) {
    return { skipped: true, reason: 'bot actor' };
  }

  if (hasSkipLabel(labels)) {
    return { skipped: true, reason: 'skip label' };
  }

  if (stateReason && stateReason !== 'completed') {
    return { skipped: true, reason: `closed as ${stateReason}` };
  }

  const canonicalLink = canonicalLinkStore.resolveCanonicalLink({
    githubNodeId: issue.node_id ?? issue.nodeId ?? null,
    githubNumber: issue.number,
  });
  let beadsId = canonicalLink?.forgeIssueId ?? null;

  if (!beadsId) {
    return { skipped: true, reason: 'no beads link found' };
  }

  const status = bdShow(beadsId);
  if (status === null) {
    return { skipped: true, reason: 'could not determine beads status' };
  }
  if (status === 'closed') {
    return { skipped: true, reason: 'already closed' };
  }

  bdClose(beadsId, `Closed via GitHub issue #${issueNumber}`);

  return { success: true, beadsId, issueNumber };
}

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
    mappingPath: process.env.BEADS_SYNC_MAPPING || DEFAULT_MAPPING_PATH,
    owner,
    repo,
  };

  const VALID_ACTIONS = ['opened', 'closed'];
  if (!VALID_ACTIONS.includes(action)) {
    console.error(`Unknown action: "${action}". Expected one of: ${VALID_ACTIONS.join(', ')}`);
    process.exit(1);
  }

  const handler = action === 'opened' ? handleOpened : handleClosed;

  Promise.resolve(handler(event, options))
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));

      if (result.success === false) {
        console.error(`Sync failed: ${result.reason || 'unknown'}`);
        process.exit(1);
      }

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
