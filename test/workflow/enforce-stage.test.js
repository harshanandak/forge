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

  test('enforceStageEntry resolves the kernel backend (default) and allows stage entry when bd is absent', async () => {
    const prev = process.env.FORGE_ISSUE_BACKEND;
    delete process.env.FORGE_ISSUE_BACKEND;
    try {
      let seenOptions = null;
      const result = await enforceStageEntry({
        commandName: 'validate',
        flags: {},
        projectRoot: process.cwd(),
        workflowState: createWorkflowState('validate', 'standard'),
        // Injected health check (same style as the `health`/`repairRuntime` seams):
        // simulates the kernel-native gate where a missing bd is advisory-only.
        checkHealth: (_root, options) => {
          seenOptions = options;
          return {
            healthy: true,
            hardStop: false,
            diagnostics: [],
            advisories: [{ code: 'BD_MISSING', severity: 'advisory' }]
          };
        }
      });

      expect(seenOptions).not.toBeNull();
      expect(seenOptions.issueBackend).toBe('kernel');
      expect(result.allowed).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.FORGE_ISSUE_BACKEND;
      else process.env.FORGE_ISSUE_BACKEND = prev;
    }
  });

  test('enforceStageEntry still blocks stage entry when beads is selected and bd is missing', async () => {
    const prev = process.env.FORGE_ISSUE_BACKEND;
    process.env.FORGE_ISSUE_BACKEND = 'beads';
    try {
      let seenOptions = null;
      await expect(enforceStageEntry({
        commandName: 'validate',
        flags: {},
        projectRoot: process.cwd(),
        workflowState: createWorkflowState('validate', 'standard'),
        checkHealth: (_root, options) => {
          seenOptions = options;
          // With beads selected, checkRuntimeHealth still hard-stops on missing bd.
          return {
            healthy: false,
            hardStop: true,
            diagnostics: [{ code: 'BD_MISSING', message: 'bd required for the beads backend' }]
          };
        }
      })).rejects.toThrow(/BD_MISSING/);

      expect(seenOptions).not.toBeNull();
      expect(seenOptions.issueBackend).toBe('beads');
    } finally {
      if (prev === undefined) delete process.env.FORGE_ISSUE_BACKEND;
      else process.env.FORGE_ISSUE_BACKEND = prev;
    }
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

  test('enforceStageEntry allows ship with no state and no kernel context, with a warning', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-missing-state-'));
    try {
      const warnings = [];
      const result = await enforceStageEntry({
        commandName: 'ship',
        flags: {},
        projectRoot: tmpDir,
        health: { healthy: true, hardStop: false, diagnostics: [] },
        warn: (m) => warnings.push(m)
      });

      expect(result.allowed).toBe(true);
      expect(result.stage).toBe('ship');
      expect(result.degradedGate).toBe('no-kernel-context');
      expect(warnings.some(w => /stage gate skipped/i.test(w))).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('enforceStageEntry with FORGE_STAGE_GATE=strict restores the authoritative-state error for ship', async () => {
    const prev = process.env.FORGE_STAGE_GATE;
    process.env.FORGE_STAGE_GATE = 'strict';
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-strict-ship-'));
    try {
      await expect(enforceStageEntry({
        commandName: 'ship',
        flags: {},
        projectRoot: tmpDir,
        health: { healthy: true, hardStop: false, diagnostics: [] }
      })).rejects.toThrow(/requires authoritative workflow state/i);
    } finally {
      if (prev === undefined) delete process.env.FORGE_STAGE_GATE;
      else process.env.FORGE_STAGE_GATE = prev;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('enforceStageEntry allows verify without workflow state for post-merge checks', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-verify-missing-state-'));
    try {
      const result = await enforceStageEntry({
        commandName: 'verify',
        flags: {},
        projectRoot: tmpDir,
        health: { healthy: true, hardStop: false, diagnostics: [] }
      });

      expect(result).toEqual({
        allowed: true,
        stage: 'verify',
        workflowState: null
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('enforceStageEntry allows validate without workflow state for direct hotfix gates', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-validate-missing-state-'));
    try {
      const result = await enforceStageEntry({
        commandName: 'validate',
        flags: {},
        projectRoot: tmpDir,
        health: { healthy: true, hardStop: false, diagnostics: [] }
      });

      expect(result).toEqual({
        allowed: true,
        stage: 'validate',
        workflowState: null
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('enforceStageEntry allows review with no state and no kernel context, with a warning', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-review-missing-state-'));
    try {
      const warnings = [];
      const result = await enforceStageEntry({
        commandName: 'review',
        flags: {},
        projectRoot: tmpDir,
        health: { healthy: true, hardStop: false, diagnostics: [] },
        warn: (m) => warnings.push(m)
      });

      expect(result.allowed).toBe(true);
      expect(result.stage).toBe('review');
      expect(result.degradedGate).toBe('no-kernel-context');
      expect(warnings.some(w => /stage gate skipped/i.test(w))).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('enforceStageEntry with FORGE_STAGE_GATE=strict restores the authoritative-state error for review', async () => {
    const prev = process.env.FORGE_STAGE_GATE;
    process.env.FORGE_STAGE_GATE = 'strict';
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-strict-review-'));
    try {
      await expect(enforceStageEntry({
        commandName: 'review',
        flags: {},
        projectRoot: tmpDir,
        health: { healthy: true, hardStop: false, diagnostics: [] }
      })).rejects.toThrow(/requires authoritative workflow state/i);
    } finally {
      if (prev === undefined) delete process.env.FORGE_STAGE_GATE;
      else process.env.FORGE_STAGE_GATE = prev;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('enforceStageEntry allows dev without workflow state for simple and hotfix starts', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-dev-missing-state-'));
    try {
      const result = await enforceStageEntry({
        commandName: 'dev',
        flags: {},
        projectRoot: tmpDir,
        health: { healthy: true, hardStop: false, diagnostics: [] }
      });

      expect(result).toEqual({
        allowed: true,
        stage: 'dev',
        workflowState: null
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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

  test('enforceStageEntry uses loadState to read .forge-state.json when no flags or inline state provided', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-loadstate-'));
    try {
      fs.writeFileSync(path.join(tmpDir, '.forge-state.json'), writeWorkflowState(createWorkflowState('dev', 'standard')));

      const result = await enforceStageEntry({
        commandName: 'validate',
        args: [],
        flags: {},
        projectRoot: tmpDir,
        health: { healthy: true, hardStop: false, diagnostics: [] }
      });

      expect(result.allowed).toBe(true);
      expect(result.stage).toBe('validate');
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
