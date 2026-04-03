const { describe, test, expect } = require('bun:test');

const statusCommand = require('../lib/commands/status.js');

function createWorkflowState(currentStage = 'dev') {
  return {
    currentStage,
    completedStages: ['plan'],
    skippedStages: [],
    workflowDecisions: {
      classification: 'standard',
      reason: 'fixture',
      userOverride: false,
      overrides: [],
    },
    parallelTracks: [],
  };
}

describe('status command authoritative workflow state', () => {
  test('handler prefers explicit workflow state over heuristic context', async () => {
    const workflowState = JSON.stringify(createWorkflowState('validate'));

    const result = await statusCommand.handler(
      ['--workflow-state', workflowState],
      {},
      process.cwd()
    );

    expect(result.authoritative).toBe(true);
    expect(result.stageId).toBe('validate');
    expect(result.runCommand).toBe('validate');
    expect(result.nextCommand).toBe('ship');
    expect(result.output).toContain('authoritative workflow state');
  });

  test('extractWorkflowStateFromComments reads the latest structured state payload', () => {
    const comments = [
      'Stage: plan complete → ready for dev',
      'WorkflowState: {"currentStage":"dev","completedStages":["plan"],"skippedStages":[],"workflowDecisions":{"classification":"standard","reason":"first","userOverride":false,"overrides":[]},"parallelTracks":[]}',
      'Stage: dev complete → ready for validate',
      'WorkflowState: {"currentStage":"validate","completedStages":["plan","dev"],"skippedStages":[],"workflowDecisions":{"classification":"standard","reason":"second","userOverride":false,"overrides":[]},"parallelTracks":[]}',
    ].join('\n');

    const result = statusCommand.extractWorkflowStateFromComments(comments);
    expect(result.currentStage).toBe('validate');
    expect(result.completedStages).toEqual(['plan', 'dev']);
  });

  test('handler resolves authoritative state from Beads comments when issue id is provided', async () => {
    const comments =
      'Stage: plan complete → ready for dev\n' +
      `WorkflowState: ${JSON.stringify(createWorkflowState('dev'))}`;

    const result = await statusCommand.handler(
      ['--issue-id', 'forge-test', '--bd-comments', comments],
      {},
      process.cwd()
    );

    expect(result.authoritative).toBe(true);
    expect(result.stageId).toBe('dev');
    expect(result.output).toContain('Run now: /dev');
    expect(result.output).toContain('Next after this: /validate');
  });

  test('handler does not fall back to heuristic stage detection when state is missing', async () => {
    const result = await statusCommand.handler([], {}, process.cwd());
    expect(result.missingWorkflowState).toBe(true);
    expect(result.output).toContain('No authoritative workflow state available');
  });
});
