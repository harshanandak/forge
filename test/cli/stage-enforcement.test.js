const { describe, test, expect } = require('bun:test');

const { STAGE_IDS } = require('../../lib/workflow/stages');
const { executeCommand } = require('../../lib/commands/_registry');
const { enforceStageEntry } = require('../../lib/workflow/enforce-stage');

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

describe('stage enforcement middleware', () => {
  test('all seven workflow stages route through shared enforcement before handlers run', async () => {
    const commands = new Map();
    const invoked = [];
    const enforced = [];

    for (const stage of STAGE_IDS) {
      commands.set(stage, {
        name: stage,
        description: `${stage} command`,
        handler: async () => {
          invoked.push(stage);
          return { success: true, message: stage };
        }
      });
    }

    for (const stage of STAGE_IDS) {
      const result = await executeCommand(commands, stage, [], {}, process.cwd(), {
        enforceStage: async (context) => {
          enforced.push(context.commandName);
          return { allowed: true };
        }
      });

      expect(result.success).toBe(true);
    }

    expect(enforced).toEqual(STAGE_IDS);
    expect(invoked).toEqual(STAGE_IDS);
  });

  test('blocked stage entry exits before the handler runs', async () => {
    const handler = async () => {
      throw new Error('handler should not run');
    };

    const commands = new Map([
      ['ship', { name: 'ship', description: 'ship', handler }]
    ]);

    const result = await executeCommand(commands, 'ship', [], {}, process.cwd(), {
      enforceStage: async () => ({ allowed: false, error: 'stage blocked' })
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('stage blocked');
  });

  test('stage entry requires an explicit override payload when skipping ahead', async () => {
    await expect(enforceStageEntry({
      commandName: 'ship',
      flags: {},
      projectRoot: process.cwd(),
      workflowState: createWorkflowState('plan', 'standard'),
      health: { healthy: true, hardStop: false, diagnostics: [] }
    })).rejects.toThrow(/override/i);
  });

  test('valid override payload allows a blocked stage to proceed', async () => {
    const result = await enforceStageEntry({
      commandName: 'ship',
      flags: {
        overrideStage: JSON.stringify({
          fromStage: 'plan',
          toStage: 'ship',
          reason: 'user approved emergency bypass',
          actor: 'user',
          userOverride: true
        })
      },
      projectRoot: process.cwd(),
      workflowState: createWorkflowState('plan', 'standard'),
      health: { healthy: true, hardStop: false, diagnostics: [] }
    });

    expect(result.allowed).toBe(true);
    expect(result.override).toEqual(expect.objectContaining({
      fromStage: 'plan',
      toStage: 'ship'
    }));
  });

  test('runtime hard-stop diagnostics block stage entry before workflow checks', async () => {
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
