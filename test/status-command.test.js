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

  test('parseStatusInputs supports --flag=value forms', () => {
    const workflowState = JSON.stringify(createWorkflowState('validate'));
    const inputs = statusCommand.parseStatusInputs([
      '--issue-id=forge-test',
      `--workflow-state=${workflowState}`,
      '--bd-comments=WorkflowState: {}',
    ], {});

    expect(inputs.issueId).toBe('forge-test');
    expect(inputs.workflowState).toBe(workflowState);
    expect(inputs.bdComments).toBe('WorkflowState: {}');
  });

  test('handler accepts --workflow-state=value syntax', async () => {
    const workflowState = JSON.stringify(createWorkflowState('validate'));

    const result = await statusCommand.handler(
      [`--workflow-state=${workflowState}`],
      {},
      process.cwd()
    );

    expect(result.authoritative).toBe(true);
    expect(result.stageId).toBe('validate');
  });

  test('handler preserves legacy standard verify as the next allowed stage from premerge', async () => {
    const workflowState = JSON.stringify({
      currentStage: 'premerge',
      completedStages: ['plan', 'dev', 'validate', 'ship', 'review'],
      skippedStages: [],
      workflowDecisions: {
        classification: 'standard',
        reason: 'legacy standard workflow',
        userOverride: false,
        overrides: [],
      },
      parallelTracks: [],
    });

    const result = await statusCommand.handler(
      [`--workflow-state=${workflowState}`],
      {},
      process.cwd()
    );

    expect(result.authoritative).toBe(true);
    expect(result.nextCommand).toBe('verify');
    expect(result.nextStages).toEqual(['verify']);
  });

  test('handler does not fall back to heuristic stage detection when state is missing', async () => {
    const result = await statusCommand.handler([], {}, process.cwd());
    expect(result.missingWorkflowState).toBe(true);
    expect(result.output).toContain('No authoritative workflow state available');
  });

  test('handler falls back gracefully when --workflow-state is malformed JSON', async () => {
    const result = await statusCommand.handler(
      ['--workflow-state', '{"currentStage":"dev"'],
      {},
      process.cwd()
    );

    expect(result.missingWorkflowState).toBe(true);
    expect(result.output).toContain('No authoritative workflow state available');
  });

  test('handler falls back gracefully when bd is unavailable', async () => {
    const originalPATH = process.env.PATH;
    const originalPath = process.env.Path;

    process.env.PATH = '';
    process.env.Path = '';

    try {
      const result = await statusCommand.handler(
        ['--issue-id', 'forge-test'],
        {},
        process.cwd()
      );

      expect(result.missingWorkflowState).toBe(true);
      expect(result.output).toContain('No authoritative workflow state available');
    } finally {
      process.env.PATH = originalPATH;
      process.env.Path = originalPath;
    }
  });
});
