const { describe, test, expect } = require('bun:test');

const {
  STAGE_IDS,
  WORKFLOW_GATES,
  getWorkflowPath,
  getStageWorkflow,
  getGatesForClassification,
  assertTransitionAllowed,
} = require('../../lib/workflow/stages');

describe('workflow stages', () => {
  test('docs workflow keeps the lightweight verify-to-ship path', () => {
    expect(getWorkflowPath('docs')).toEqual(['verify', 'ship']);
    expect(getStageWorkflow('verify', 'docs')).toEqual(
      expect.objectContaining({
        classification: 'docs',
        order: 1,
        nextStages: ['ship'],
        terminal: false,
      })
    );
  });

  test('assertTransitionAllowed rejects docs transitions outside the documented path', () => {
    expect(() => assertTransitionAllowed('verify', 'review', 'docs')).toThrow(/Invalid workflow transition/i);
  });
});

describe('workflow gates', () => {
  test('pre-merge is modeled as a task-type gate, not a workflow stage', () => {
    // The gate id is hyphenated so it never re-enters the canonical stage model.
    expect(STAGE_IDS).not.toContain('premerge');
    expect(STAGE_IDS).not.toContain('pre-merge');
    expect(WORKFLOW_GATES['pre-merge']).toEqual({
      embeddedIn: ['ship', 'review'],
      enabledFor: ['critical', 'standard', 'refactor'],
    });
  });

  test('getGatesForClassification reports the pre-merge gate only where it is enabled', () => {
    expect(getGatesForClassification('critical')).toEqual(['pre-merge']);
    expect(getGatesForClassification('standard')).toEqual(['pre-merge']);
    expect(getGatesForClassification('refactor')).toEqual(['pre-merge']);
    expect(getGatesForClassification('simple')).toEqual([]);
    expect(getGatesForClassification('hotfix')).toEqual([]);
    expect(getGatesForClassification('docs')).toEqual([]);
    expect(getGatesForClassification('bogus')).toEqual([]);
  });
});
