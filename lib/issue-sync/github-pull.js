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

function normalizeNameList(values) {
  const source = Array.isArray(values) ? values : values ? [values] : [];
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

function normalizeRemoteIssue(issue = {}) {
  const assignees = normalizeNameList(
    Array.isArray(issue.assignees) && issue.assignees.length > 0
      ? issue.assignees
      : issue.assignee,
  );

  return {
    github: {
      number: normalizeGitHubNumber(issue.number ?? issue.issue_number ?? issue.issueNumber),
      nodeId: issue.node_id ?? issue.nodeId ?? null,
      url: issue.html_url ?? issue.htmlUrl ?? null,
    },
    shared: {
      title: normalizeText(issue.title),
      body: normalizeText(issue.body),
      state: normalizeState(issue.state),
      assignees,
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
  normalizeMilestone,
  normalizeNameList,
  normalizeRemoteIssue,
  normalizeState,
};
