function createDefaultGitHubSection() {
  return {
    number: null,
    nodeId: null,
    url: null,
  };
}

function createDefaultSharedSection() {
  return {
    title: '',
    body: '',
    state: 'open',
    assignees: [],
    labels: [],
    milestone: null,
  };
}

function createDefaultForgeSection() {
  return {
    issueId: null,
    dependencies: [],
    parentId: null,
    childIds: [],
    workflowStage: null,
    acceptanceCriteria: [],
    progressNotes: [],
    stageTransitions: [],
    decisions: [],
    memory: [],
  };
}

function createDefaultCacheSection() {
  return {
    githubSnapshot: null,
    materializedIssue: null,
    legacyLinkHints: {
      mapping: null,
      githubIssue: null,
      syncComments: [],
      externalRef: null,
      descriptionUrl: null,
    },
  };
}

function createDefaultSyncSection() {
  return {
    remoteUpdatedAt: null,
    lastPulledAt: null,
    lastPushedAt: null,
    pendingOutbound: [],
    drift: [],
  };
}

function createDefaultSharedIssueRecord() {
  return {
    github: createDefaultGitHubSection(),
    shared: createDefaultSharedSection(),
    forge: createDefaultForgeSection(),
    cache: createDefaultCacheSection(),
    sync: createDefaultSyncSection(),
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneValue(value) {
  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }

  if (isPlainObject(value)) {
    const result = {};

    for (const [key, nestedValue] of Object.entries(value)) {
      result[key] = cloneValue(nestedValue);
    }

    return result;
  }

  return value;
}

function mergeRecordSections(baseValue, overrideValue) {
  if (overrideValue === undefined) {
    return cloneValue(baseValue);
  }

  if (Array.isArray(overrideValue)) {
    return overrideValue.map(cloneValue);
  }

  if (!isPlainObject(baseValue) || !isPlainObject(overrideValue)) {
    return cloneValue(overrideValue);
  }

  const merged = {};
  const keys = new Set([...Object.keys(baseValue), ...Object.keys(overrideValue)]);

  for (const key of keys) {
    merged[key] = mergeRecordSections(baseValue[key], overrideValue[key]);
  }

  return merged;
}

function buildSharedIssueRecord(overrides = {}) {
  return mergeRecordSections(createDefaultSharedIssueRecord(), overrides);
}

module.exports = {
  buildSharedIssueRecord,
  createDefaultCacheSection,
  createDefaultForgeSection,
  createDefaultGitHubSection,
  createDefaultSharedIssueRecord,
  createDefaultSharedSection,
  createDefaultSyncSection,
};
