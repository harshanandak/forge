'use strict';

const { normalizeGitHubNumber } = require('./link-store.js');

const GITHUB_OWNED_FIELD_PATHS = [
  'github.number',
  'github.nodeId',
  'github.url',
  'shared.title',
  'shared.body',
  'shared.state',
  'shared.assignees',
  'shared.labels',
  'shared.milestone',
  'sync.remoteUpdatedAt',
];

function cloneValue(value) {
  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }

  if (value && typeof value === 'object') {
    const copy = {};

    for (const [key, nestedValue] of Object.entries(value)) {
      copy[key] = cloneValue(nestedValue);
    }

    return copy;
  }

  return value;
}

function normalizeText(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function normalizeState(value) {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  return 'open';
}

function normalizeCollectionEntries(values) {
  if (Array.isArray(values)) {
    return values;
  }

  if (!values) {
    return [];
  }

  if (typeof values === 'object') {
    if (Array.isArray(values.nodes)) {
      return values.nodes;
    }

    if (Array.isArray(values.edges)) {
      return values.edges
        .map((edge) => edge?.node ?? edge)
        .filter((entry) => entry != null);
    }
  }

  return [values];
}

function normalizeNameList(values) {
  const source = normalizeCollectionEntries(values);
  const normalized = [];
  const seen = new Set();

  for (const entry of source) {
    const name = typeof entry === 'string'
      ? entry
      : entry?.login ?? entry?.name ?? entry?.title ?? null;

    if (typeof name !== 'string' || name.length === 0 || seen.has(name)) {
      continue;
    }

    seen.add(name);
    normalized.push(name);
  }

  return normalized;
}

function normalizeMilestone(milestone) {
  if (!milestone) {
    return null;
  }

  if (typeof milestone === 'string') {
    return milestone;
  }

  return milestone.title ?? milestone.name ?? null;
}

function normalizeNodeId(issue = {}) {
  if (typeof issue.node_id === 'string' && issue.node_id.length > 0) {
    return issue.node_id;
  }

  if (typeof issue.nodeId === 'string' && issue.nodeId.length > 0) {
    return issue.nodeId;
  }

  if (typeof issue.id === 'string' && issue.id.length > 0) {
    return issue.id;
  }

  return null;
}

function normalizeIssueUrl(issue = {}) {
  const candidates = [issue.html_url, issue.htmlUrl, issue.url];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) {
      continue;
    }

    if (/^https:\/\/api\.github\.com\//iu.test(candidate)) {
      continue;
    }

    return candidate;
  }

  return null;
}

function normalizeAssignees(issue = {}) {
  const assignees = normalizeNameList(issue.assignees);

  if (assignees.length > 0) {
    return assignees;
  }

  return normalizeNameList(issue.assignee);
}

function normalizeRemoteIssue(issue = {}) {
  return {
    github: {
      number: normalizeGitHubNumber(issue.number ?? issue.issue_number ?? issue.issueNumber),
      nodeId: normalizeNodeId(issue),
      url: normalizeIssueUrl(issue),
    },
    shared: {
      title: normalizeText(issue.title),
      body: normalizeText(issue.body),
      state: normalizeState(issue.state),
      assignees: normalizeAssignees(issue),
      labels: normalizeNameList(issue.labels),
      milestone: normalizeMilestone(issue.milestone),
    },
    sync: {
      remoteUpdatedAt: issue.updated_at ?? issue.updatedAt ?? null,
    },
  };
}

const normalizeGitHubIssuePayload = normalizeRemoteIssue;

module.exports = {
  GITHUB_OWNED_FIELD_PATHS,
  cloneValue,
  normalizeGitHubIssuePayload,
  normalizeAssignees,
  normalizeCollectionEntries,
  normalizeIssueUrl,
  normalizeMilestone,
  normalizeNameList,
  normalizeNodeId,
  normalizeRemoteIssue,
  normalizeState,
};
