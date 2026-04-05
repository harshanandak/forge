const { describe, test, expect } = require('bun:test');

const {
  getWorkflowPath,
  getStageWorkflow,
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
