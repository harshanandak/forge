const { describe, test, expect } = require('bun:test');

const { enforceStageEntry, parseOverride } = require('../../lib/workflow/enforce-stage');
const { readWorkflowState } = require('../../lib/workflow/state');

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
  test('parseOverride reads override payloads from raw CLI args', () => {
    const result = parseOverride({}, [
      '--override-stage',
      JSON.stringify({
        fromStage: 'plan',
        toStage: 'ship',
        reason: 'user override',
        actor: 'user',
        userOverride: true
      })
    ]);

    expect(result).toEqual(expect.objectContaining({
      fromStage: 'plan',
      toStage: 'ship',
      actor: 'user',
      userOverride: true
    }));
  });

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

  test('enforceStageEntry reads workflow-state and override payloads from raw CLI args', async () => {
    const result = await enforceStageEntry({
      commandName: 'ship',
      args: [
        '--workflow-state',
        JSON.stringify(createWorkflowState('plan', 'standard')),
        '--override-stage',
        JSON.stringify({
          fromStage: 'plan',
          toStage: 'ship',
          reason: 'user approved emergency bypass',
          actor: 'user',
          userOverride: true
        })
      ],
      flags: {},
      projectRoot: process.cwd(),
      health: { healthy: true, hardStop: false, diagnostics: [] }
    });

    expect(result.allowed).toBe(true);
    expect(result.workflowState).toEqual(expect.objectContaining({ currentStage: 'plan' }));
    expect(result.override).toEqual(expect.objectContaining({
      fromStage: 'plan',
      toStage: 'ship'
    }));
  });

  test('enforceStageEntry allows legacy standard workflows to enter verify from premerge', async () => {
    const legacyStandardState = readWorkflowState(JSON.stringify({
      currentStage: 'premerge',
      completedStages: ['plan', 'dev', 'validate', 'ship', 'review'],
      skippedStages: [],
      workflowDecisions: {
        classification: 'standard',
        reason: 'legacy standard workflow',
        userOverride: false,
        overrides: []
      },
      parallelTracks: []
    }));

    const result = await enforceStageEntry({
      commandName: 'verify',
      flags: {},
      projectRoot: process.cwd(),
      workflowState: legacyStandardState,
      health: { healthy: true, hardStop: false, diagnostics: [] }
    });

    expect(result.allowed).toBe(true);
    expect(result.stage).toBe('verify');
  });
});
