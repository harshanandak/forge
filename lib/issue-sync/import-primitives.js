'use strict';

const { cloneValue, normalizeRemoteIssue: normalizeSharedRemoteIssue } = require('./github-pull.js');
const { reconcileSharedIssueRecord } = require('./reconcile.js');
const { resolveCanonicalLink } = require('./link-store.js');

function toIssueArray(page = {}) {
  if (Array.isArray(page)) {
    return page;
  }

  if (!page || typeof page !== 'object') {
    return [];
  }

  if (Array.isArray(page.nodes)) {
    return page.nodes;
  }

  if (Array.isArray(page.items)) {
    return page.items;
  }

  if (Array.isArray(page.issues)) {
    return page.issues;
  }

  if (Array.isArray(page.edges)) {
    return page.edges.map((edge) => edge?.node).filter(Boolean);
  }

  const nestedNodes = page.data?.repository?.issues?.nodes;
  if (Array.isArray(nestedNodes)) {
    return nestedNodes;
  }

  const nestedEdges = page.data?.repository?.issues?.edges;
  if (Array.isArray(nestedEdges)) {
    return nestedEdges.map((edge) => edge?.node).filter(Boolean);
  }

  return [];
}

function listRemoteIssues(page = {}) {
  return toIssueArray(page).map(cloneValue);
}

function normalizeRemoteIssue(issue = {}) {
  return normalizeSharedRemoteIssue(issue);
}

function resolveSharedLink(linkStore, remoteIssue = {}) {
  if (!linkStore) {
    return null;
  }

  const lookup = {
    githubNodeId: remoteIssue.github?.nodeId ?? remoteIssue.node_id ?? remoteIssue.nodeId ?? null,
    githubNumber: remoteIssue.github?.number ?? remoteIssue.number ?? remoteIssue.issue_number ?? remoteIssue.issueNumber ?? null,
  };

  if (typeof linkStore.resolveCanonicalLink === 'function') {
    return linkStore.resolveCanonicalLink(lookup);
  }

  if (typeof linkStore === 'object' && typeof linkStore.byGitHubNumber?.get === 'function') {
    return resolveCanonicalLink(linkStore, lookup);
  }

  return null;
}

function materializeLocalIssue(localRecord = {}, remoteIssue = {}, linkStore, options = {}) {
  const normalizedRemoteIssue = remoteIssue?.github && remoteIssue?.shared && remoteIssue?.sync
    ? cloneValue(remoteIssue)
    : normalizeRemoteIssue(remoteIssue);

  const link = resolveSharedLink(linkStore, normalizedRemoteIssue);
  const { record, diagnostics } = reconcileSharedIssueRecord(
    localRecord,
    normalizedRemoteIssue,
    options.reconcileOptions ?? {},
  );

  return {
    link,
    diagnostics,
    record,
  };
}

module.exports = {
  listRemoteIssues,
  materializeLocalIssue,
  normalizeRemoteIssue,
  resolveSharedLink,
};
