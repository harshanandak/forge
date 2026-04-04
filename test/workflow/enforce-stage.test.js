const { describe, test, expect } = require('bun:test');

const { enforceStageEntry, parseOverride } = require('../../lib/workflow/enforce-stage');

function createWorkflowState(currentStage = 'plan', classification = 'standard') {
  return {
    currentStage,
    completedStages: [],
    skippedStages: [],
    workflowDecisions: {
      classification,
      reason: 'fixture',
      userOverride: false,
      overrides: []
    },
    parallelTracks: []
  };
}

describe('workflow enforce-stage', () => {
  test('parseOverride normalizes explicit override payloads', () => {
    const result = parseOverride({
      overrideStage: JSON.stringify({
        fromStage: 'plan',
        toStage: 'ship',
        reason: 'user override',
        actor: 'user',
        userOverride: true
      })
    });

    expect(result).toEqual(expect.objectContaining({
      fromStage: 'plan',
      toStage: 'ship',
      actor: 'user',
      userOverride: true
    }));
  });

  test('parseOverride raises a contextual error for malformed JSON', () => {
    expect(() => parseOverride({
      overrideStage: '{"fromStage":"plan"'
    })).toThrow(/override-stage flag/i);
  });

  test('enforceStageEntry blocks skipped transitions without an override', async () => {
    await expect(enforceStageEntry({
      commandName: 'ship',
      flags: {},
      projectRoot: process.cwd(),
      workflowState: createWorkflowState('plan', 'standard'),
      health: { healthy: true, hardStop: false, diagnostics: [] }
    })).rejects.toThrow(/override/i);
  });

  test('enforceStageEntry surfaces runtime prerequisite diagnostics', async () => {
    await expect(enforceStageEntry({
      commandName: 'dev',
      flags: {},
      projectRoot: process.cwd(),
      workflowState: createWorkflowState('plan', 'standard'),
      health: {
        healthy: false,
        hardStop: true,
        diagnostics: [{ code: 'BD_MISSING', message: 'bd missing' }]
      }
    })).rejects.toThrow(/BD_MISSING/);
  });
});
