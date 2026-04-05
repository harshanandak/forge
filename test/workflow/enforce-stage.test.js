const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { enforceStageEntry, parseOverride } = require('../../lib/workflow/enforce-stage');
const { readWorkflowState, writeWorkflowState } = require('../../lib/workflow/state');

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

  test('enforceStageEntry requires workflow state for non-plan stages', async () => {
    await expect(enforceStageEntry({
      commandName: 'ship',
      flags: {},
      projectRoot: process.cwd(),
      health: { healthy: true, hardStop: false, diagnostics: [] }
    })).rejects.toThrow(/requires authoritative workflow state/i);
  });

  test('enforceStageEntry reads workflow state from .forge-state.json when present', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-workflow-state-'));
    try {
      fs.writeFileSync(path.join(tmpDir, '.forge-state.json'), writeWorkflowState(createWorkflowState('dev', 'standard')));

      const result = await enforceStageEntry({
        commandName: 'validate',
        flags: {},
        projectRoot: tmpDir,
        health: { healthy: true, hardStop: false, diagnostics: [] }
      });

      expect(result.allowed).toBe(true);
      expect(result.workflowState).toEqual(expect.objectContaining({ currentStage: 'dev' }));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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
