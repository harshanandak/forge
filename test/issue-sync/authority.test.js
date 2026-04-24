const { describe, expect, test } = require('bun:test');

const {
  getFieldAuthority,
  isCacheField,
  isForgeOwnedField,
  isGitHubOwnedField,
  isSharedField,
} = require('../../lib/issue-sync/authority.js');

describe('shared issue authority', () => {
  test('maps shared identity and state fields to GitHub authority', () => {
    expect(getFieldAuthority('github.number')).toBe('github');
    expect(getFieldAuthority('github.nodeId')).toBe('github');
    expect(getFieldAuthority('github.url')).toBe('github');
    expect(getFieldAuthority('shared.title')).toBe('github');
    expect(getFieldAuthority('shared.body')).toBe('github');
    expect(getFieldAuthority('shared.state')).toBe('github');
    expect(getFieldAuthority('shared.assignees')).toBe('github');
    expect(getFieldAuthority('shared.labels')).toBe('github');
    expect(getFieldAuthority('shared.milestone')).toBe('github');
    expect(isGitHubOwnedField('shared.title')).toBe(true);
    expect(isSharedField('shared.labels')).toBe(true);
  });

  test('maps workflow and bookkeeping fields to Forge authority', () => {
    expect(getFieldAuthority('forge.issueId')).toBe('forge');
    expect(getFieldAuthority('forge.dependencies')).toBe('forge');
    expect(getFieldAuthority('forge.parentId')).toBe('forge');
    expect(getFieldAuthority('forge.childIds')).toBe('forge');
    expect(getFieldAuthority('forge.workflowStage')).toBe('forge');
    expect(getFieldAuthority('forge.acceptanceCriteria')).toBe('forge');
    expect(getFieldAuthority('forge.progressNotes')).toBe('forge');
    expect(getFieldAuthority('forge.stageTransitions')).toBe('forge');
    expect(getFieldAuthority('forge.decisions')).toBe('forge');
    expect(getFieldAuthority('forge.memory')).toBe('forge');
    expect(getFieldAuthority('sync.remoteUpdatedAt')).toBe('forge');
    expect(getFieldAuthority('sync.pendingOutbound')).toBe('forge');
    expect(getFieldAuthority('sync.drift')).toBe('forge');
    expect(isForgeOwnedField('forge.dependencies')).toBe(true);
    expect(isForgeOwnedField('sync.pendingOutbound')).toBe(true);
  });

  test('maps cache sections separately and returns null for unknown paths', () => {
    expect(getFieldAuthority('cache.githubSnapshot')).toBe('cache');
    expect(getFieldAuthority('cache.materializedIssue')).toBe('cache');
    expect(getFieldAuthority('cache.legacyLinkHints.mapping')).toBe('cache');
    expect(getFieldAuthority('cache.legacyLinkHints.githubIssue')).toBe('cache');
    expect(getFieldAuthority('cache.legacyLinkHints.syncComments')).toBe('cache');
    expect(getFieldAuthority('cache.legacyLinkHints.externalRef')).toBe('cache');
    expect(getFieldAuthority('cache.legacyLinkHints.descriptionUrl')).toBe('cache');
    expect(isCacheField('cache.legacyLinkHints.externalRef')).toBe(true);
    expect(getFieldAuthority('shared.unknown')).toBeNull();
    expect(getFieldAuthority('unknown.path')).toBeNull();
  });
});
