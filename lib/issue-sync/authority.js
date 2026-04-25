const GITHUB_OWNED_FIELDS = new Set([
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
]);

const FORGE_OWNED_FIELDS = new Set([
  'forge.issueId',
  'forge.dependencies',
  'forge.parentId',
  'forge.childIds',
  'forge.workflowStage',
  'forge.acceptanceCriteria',
  'forge.progressNotes',
  'forge.stageTransitions',
  'forge.decisions',
  'forge.memory',
  'sync.lastPulledAt',
  'sync.lastPushedAt',
  'sync.pendingOutbound',
  'sync.drift',
]);

const CACHE_FIELDS = new Set([
  'cache.githubSnapshot',
  'cache.materializedIssue',
  'cache.legacyLinkHints.mapping',
  'cache.legacyLinkHints.githubIssue',
  'cache.legacyLinkHints.syncComments',
  'cache.legacyLinkHints.externalRef',
  'cache.legacyLinkHints.descriptionUrl',
]);

function matchesFieldPath(fieldPath, knownFieldPath) {
  return fieldPath === knownFieldPath || fieldPath.startsWith(`${knownFieldPath}.`);
}

function hasFieldPath(fieldPath, fieldSet) {
  if (typeof fieldPath !== 'string' || fieldPath.length === 0) {
    return false;
  }

  for (const knownFieldPath of fieldSet) {
    if (matchesFieldPath(fieldPath, knownFieldPath)) {
      return true;
    }
  }

  return false;
}

function getFieldAuthority(fieldPath) {
  if (hasFieldPath(fieldPath, GITHUB_OWNED_FIELDS)) {
    return 'github';
  }

  if (hasFieldPath(fieldPath, FORGE_OWNED_FIELDS)) {
    return 'forge';
  }

  if (hasFieldPath(fieldPath, CACHE_FIELDS)) {
    return 'cache';
  }

  return null;
}

function isGitHubOwnedField(fieldPath) {
  return getFieldAuthority(fieldPath) === 'github';
}

function isForgeOwnedField(fieldPath) {
  return getFieldAuthority(fieldPath) === 'forge';
}

function isCacheField(fieldPath) {
  return getFieldAuthority(fieldPath) === 'cache';
}

function isSharedField(fieldPath) {
  return typeof fieldPath === 'string' && fieldPath.startsWith('shared.') && isGitHubOwnedField(fieldPath);
}

module.exports = {
  CACHE_FIELDS,
  FORGE_OWNED_FIELDS,
  GITHUB_OWNED_FIELDS,
  getFieldAuthority,
  isCacheField,
  isForgeOwnedField,
  isGitHubOwnedField,
  isSharedField,
};
