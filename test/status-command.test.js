const { describe, test, expect } = require('bun:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readBeadsSnapshot } = require('../lib/status/beads-snapshot.js');
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

function createTempBeadsRepo(entries, options = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-status-beads-'));
  const beadsDir = path.join(repoRoot, '.beads');
  fs.mkdirSync(beadsDir, { recursive: true });
  fs.writeFileSync(
    path.join(beadsDir, 'issues.jsonl'),
    `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`,
    'utf8'
  );

  execFileSync('git', ['init'], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.email', options.email || 'harshanandak@users.noreply.github.com'], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  execFileSync('git', ['config', 'user.name', options.name || 'Harsha Nanda'], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (options.branch) {
    execFileSync('git', ['checkout', '-b', options.branch], {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
  if (options.workflowState) {
    fs.writeFileSync(
      path.join(repoRoot, '.forge-state.json'),
      JSON.stringify(options.workflowState, null, 2),
      'utf8'
    );
  }
  if (options.clean) {
    execFileSync('git', ['add', '.'], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] });
    execFileSync('git', ['commit', '--no-verify', '--no-gpg-sign', '-m', 'fixture'], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] });
  }

  return repoRoot;
}

describe('status command authoritative workflow state', () => {
  test('handler reports repo context for zero-arg status calls', async () => {
    const projectRoot = path.resolve(__dirname, '..');

    const result = await statusCommand.handler([], {}, projectRoot);

    expect(result.success).toBe(true);
    expect(result.output).toContain('You are here');
    expect(result.output).toContain('Context');
    expect(result.output).toContain('—');
    expect(result.output).not.toContain('Provide --workflow-state or --issue-id');
  });

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

  test('extractWorkflowStateFromComments tolerates relaxed WorkflowState comment payloads', () => {
    const comments = 'WorkflowState: {currentStage:dev,completedStages:[plan],skippedStages:[],workflowDecisions:{classification:standard,reason:zero-arg';

    const result = statusCommand.extractWorkflowStateFromComments(comments);

    expect(result.currentStage).toBe('dev');
    expect(result.completedStages).toEqual(['plan']);
    expect(result.workflowDecisions.classification).toBe('standard');
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

  test('parseStatusInputs supports runtime option flags', () => {
    const inputs = statusCommand.parseStatusInputs([
      '--json',
      '--now=2026-05-18T08:00:00Z',
      '--stale-after-days',
      '10',
    ], {});

    expect(inputs.json).toBe(true);
    expect(inputs.now).toBe('2026-05-18T08:00:00Z');
    expect(inputs.staleAfterDays).toBe('10');
  });

  test('parseStatusInputs does not swallow adjacent flags and preserves zero values', () => {
    const inputs = statusCommand.parseStatusInputs([
      '--now',
      '--json',
      '--stale-after-days',
      '0',
    ], {});

    expect(inputs.json).toBe(true);
    expect(inputs.now).toBeUndefined();
    expect(inputs.staleAfterDays).toBe('0');

    const flagInputs = statusCommand.parseStatusInputs([], {
      staleAfterDays: 0,
    });
    expect(flagInputs.staleAfterDays).toBe(0);
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
    const repoRoot = createTempBeadsRepo([]);
    const result = await statusCommand.handler([], {}, repoRoot);
    expect(result.missingWorkflowState).toBe(true);
    expect(result.output).toContain('Context');
    expect(result.output).toContain('You are here');
    expect(result.output).toContain('No active workflow and no ready issues');
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
    const repoRoot = createTempBeadsRepo([]);

    process.env.PATH = '';
    process.env.Path = '';

    try {
      const result = await statusCommand.handler(
        ['--issue-id', 'forge-test'],
        {},
        repoRoot
      );

      expect(result.missingWorkflowState).toBe(true);
      expect(result.output).toContain('No authoritative workflow state available');
    } finally {
      process.env.PATH = originalPATH;
      process.env.Path = originalPath;
    }
  });
});

describe('status command beads snapshot helpers', () => {
  test('readBeadsSnapshot filters active assigned issues for the current developer', () => {
    const repoRoot = createTempBeadsRepo([
      { id: 'forge-a', title: 'Mine active', status: 'in_progress', owner: 'harshanandak@users.noreply.github.com', updated_at: '2026-04-10T08:00:00Z' },
      { id: 'forge-b', title: 'Other active', status: 'in_progress', owner: 'other@example.com', updated_at: '2026-04-10T07:00:00Z' },
      { id: 'forge-c', title: 'Mine open', status: 'open', owner: 'harshanandak@users.noreply.github.com', updated_at: '2026-04-10T06:00:00Z' },
    ], {
      clean: true,
    });

    const snapshot = readBeadsSnapshot(repoRoot);

    expect(snapshot.developer.email).toBe('harshanandak@users.noreply.github.com');
    expect(snapshot.activeAssigned.map(issue => issue.id)).toEqual(['forge-a']);
  });

  test('readBeadsSnapshot matches owner email case-insensitively for active assignment', () => {
    const repoRoot = createTempBeadsRepo([
      { id: 'forge-a', title: 'Mine active', status: 'in_progress', owner: 'HarshaNandak@Users.Noreply.GitHub.com' },
    ], {
      email: 'harshanandak@users.noreply.github.com',
    });

    const snapshot = readBeadsSnapshot(repoRoot);

    expect(snapshot.activeAssigned.map(issue => issue.id)).toEqual(['forge-a']);
  });

  test('readBeadsSnapshot filters ready issues to open work with no unresolved dependencies', () => {
    const repoRoot = createTempBeadsRepo([
      { id: 'forge-ready', title: 'Ready', status: 'open', dependency_count: 0, updated_at: '2026-04-10T08:00:00Z' },
      { id: 'forge-blocked', title: 'Blocked', status: 'open', dependency_count: 2, updated_at: '2026-04-10T07:00:00Z' },
      { id: 'forge-active', title: 'Active', status: 'in_progress', dependency_count: 0, updated_at: '2026-04-10T06:00:00Z' },
    ]);

    const snapshot = readBeadsSnapshot(repoRoot);

    expect(snapshot.ready.map(issue => issue.id)).toEqual(['forge-ready']);
  });

  test('readBeadsSnapshot exposes blocked and stale issue categories', () => {
    const repoRoot = createTempBeadsRepo([
      { id: 'forge-active-old', title: 'Old active', status: 'in_progress', owner: 'harshanandak@users.noreply.github.com', updated_at: '2026-04-01T08:00:00Z' },
      { id: 'forge-blocked', title: 'Blocked', status: 'open', owner: 'harshanandak@users.noreply.github.com', dependency_count: 2, updated_at: '2026-04-17T08:00:00Z' },
      { id: 'forge-ready', title: 'Ready', status: 'open', dependency_count: 0, updated_at: '2026-04-18T08:00:00Z' },
    ]);

    const snapshot = readBeadsSnapshot(repoRoot, {
      now: new Date('2026-05-18T08:00:00Z'),
      staleAfterDays: 14,
    });

    expect(snapshot.blocked.map(issue => issue.id)).toEqual(['forge-blocked']);
    expect(snapshot.stale.map(issue => issue.id)).toEqual(['forge-ready', 'forge-blocked', 'forge-active-old']);
  });

  test('readBeadsSnapshot accepts string runtime options for stale classification', () => {
    const repoRoot = createTempBeadsRepo([
      { id: 'forge-stale', title: 'Stale', status: 'open', dependency_count: 0, updated_at: '2026-04-01T08:00:00Z' },
    ]);

    const snapshot = readBeadsSnapshot(repoRoot, {
      now: '2026-05-18T08:00:00Z',
      staleAfterDays: '14',
    });

    expect(snapshot.stale.map(issue => issue.id)).toEqual(['forge-stale']);
  });

  test('readBeadsSnapshot sorts recent completions by updated_at descending', () => {
    const repoRoot = createTempBeadsRepo([
      { id: 'forge-old', title: 'Older completion', status: 'closed', updated_at: '2026-04-07T08:00:00Z' },
      { id: 'forge-new', title: 'Newer completion', status: 'closed', updated_at: '2026-04-10T08:00:00Z' },
      { id: 'forge-open', title: 'Still open', status: 'open', updated_at: '2026-04-09T08:00:00Z' },
    ], {
      clean: true,
    });

    const snapshot = readBeadsSnapshot(repoRoot);

    expect(snapshot.recentCompleted.map(issue => issue.id)).toEqual(['forge-new', 'forge-old']);
  });

  test('readBeadsSnapshot treats missing completion timestamps as the oldest entries', () => {
    const repoRoot = createTempBeadsRepo([
      { id: 'forge-undated', title: 'Undated completion', status: 'closed' },
      { id: 'forge-dated', title: 'Dated completion', status: 'closed', updated_at: '2026-04-10T08:00:00Z' },
    ]);

    const snapshot = readBeadsSnapshot(repoRoot);

    expect(snapshot.recentCompleted.map(issue => issue.id)).toEqual(['forge-dated', 'forge-undated']);
  });

  test('readBeadsSnapshot treats invalid completion timestamps as the oldest entries', () => {
    const repoRoot = createTempBeadsRepo([
      { id: 'forge-invalid', title: 'Invalid completion', status: 'closed', updated_at: 'not-a-date' },
      { id: 'forge-dated', title: 'Dated completion', status: 'closed', updated_at: '2026-04-10T08:00:00Z' },
    ]);

    const snapshot = readBeadsSnapshot(repoRoot);

    expect(snapshot.recentCompleted.map(issue => issue.id)).toEqual(['forge-dated', 'forge-invalid']);
  });

  test('readBeadsSnapshot ignores malformed JSONL rows and keeps the latest issue record', () => {
    const repoRoot = createTempBeadsRepo([]);
    fs.writeFileSync(
      path.join(repoRoot, '.beads', 'issues.jsonl'),
      [
        '{"id":"forge-a","title":"Old","status":"open","updated_at":"2026-04-09T08:00:00Z"}',
        'not-json',
        '{"id":"forge-a","title":"New","status":"in_progress","owner":"harshanandak@users.noreply.github.com","updated_at":"2026-04-10T08:00:00Z"}',
      ].join('\n'),
      'utf8'
    );

    const snapshot = readBeadsSnapshot(repoRoot);

    expect(snapshot.issues.map(issue => issue.title)).toEqual(['New']);
    expect(snapshot.activeAssigned.map(issue => issue.id)).toEqual(['forge-a']);
  });
});

describe('status command workflow discovery', () => {
  test('zero-arg status prefers .forge-state.json over discovered issue context', async () => {
    const repoRoot = createTempBeadsRepo([
      {
        id: 'forge-a',
        title: 'Discovered issue',
        status: 'in_progress',
        owner: 'harshanandak@users.noreply.github.com',
        design: '5 tasks | docs/plans/2026-04-10-other-feature-tasks.md',
        comments: [{ text: `WorkflowState: ${JSON.stringify(createWorkflowState('dev'))}` }],
        updated_at: '2026-04-10T08:00:00Z',
      },
    ], {
      workflowState: createWorkflowState('validate'),
    });

    const result = await statusCommand.handler([], {}, repoRoot);

    expect(result.stageId).toBe('validate');
    expect(result.output).toContain('Stage 3 of 5 — Validate (standard workflow)');
  });

  test('zero-arg status discovers workflow from a slug-matched active issue', async () => {
    const repoRoot = createTempBeadsRepo([
      {
        id: 'forge-match',
        title: 'Matched issue',
        status: 'in_progress',
        owner: 'harshanandak@users.noreply.github.com',
        design: '5 tasks | docs/plans/2026-04-10-forge-status-personal-focus-tasks.md',
        comments: [{ text: `WorkflowState: ${JSON.stringify(createWorkflowState('dev'))}` }],
        updated_at: '2026-04-10T08:00:00Z',
      },
      {
        id: 'forge-other',
        title: 'Other issue',
        status: 'in_progress',
        owner: 'harshanandak@users.noreply.github.com',
        design: '5 tasks | docs/plans/2026-04-10-unrelated-feature-tasks.md',
        comments: [{ text: `WorkflowState: ${JSON.stringify(createWorkflowState('ship'))}` }],
        updated_at: '2026-04-10T07:00:00Z',
      },
    ], {
      branch: 'feat/forge-status-personal-focus',
    });

    const result = await statusCommand.handler([], {}, repoRoot);

    expect(result.stageId).toBe('dev');
    expect(result.output).toContain('Stage 2 of 5 — Dev (standard workflow)');
  });

  test('zero-arg status matches branch slug against exact design-path slugs only', async () => {
    const repoRoot = createTempBeadsRepo([
      {
        id: 'forge-plan',
        title: 'Exact slug match',
        status: 'in_progress',
        owner: 'harshanandak@users.noreply.github.com',
        design: '5 tasks | docs/plans/2026-04-10-plan-tasks.md',
        comments: [{ text: `WorkflowState: ${JSON.stringify(createWorkflowState('dev'))}` }],
        updated_at: '2026-04-10T08:00:00Z',
      },
      {
        id: 'forge-planning',
        title: 'Substring-only match',
        status: 'in_progress',
        owner: 'harshanandak@users.noreply.github.com',
        design: '5 tasks | docs/plans/2026-04-10-task-planning-tasks.md',
        comments: [{ text: `WorkflowState: ${JSON.stringify(createWorkflowState('validate'))}` }],
        updated_at: '2026-04-10T07:00:00Z',
      },
    ], {
      branch: 'feat/plan',
    });

    const result = await statusCommand.handler([], {}, repoRoot);

    expect(result.stageId).toBe('dev');
    expect(result.output).toContain('Stage 2 of 5 — Dev (standard workflow)');
    expect(result.output).not.toContain('Validate (standard workflow)');
  });

  test('zero-arg status falls back to the single active assigned issue when no slug match exists', async () => {
    const repoRoot = createTempBeadsRepo([
      {
        id: 'forge-only',
        title: 'Only active issue',
        status: 'in_progress',
        owner: 'harshanandak@users.noreply.github.com',
        comments: [{ text: `WorkflowState: ${JSON.stringify(createWorkflowState('ship'))}` }],
        updated_at: '2026-04-10T08:00:00Z',
      },
    ], {
      branch: 'feat/no-design-match',
    });

    const result = await statusCommand.handler([], {}, repoRoot);

    expect(result.stageId).toBe('ship');
    expect(result.output).toContain('Stage 4 of 5 — Ship (standard workflow)');
  });

  test('zero-arg status leaves workflow unresolved when multiple active issues are ambiguous', async () => {
    const repoRoot = createTempBeadsRepo([
      {
        id: 'forge-a',
        title: 'First active issue',
        status: 'in_progress',
        owner: 'harshanandak@users.noreply.github.com',
        comments: [{ text: `WorkflowState: ${JSON.stringify(createWorkflowState('dev'))}` }],
        updated_at: '2026-04-10T08:00:00Z',
      },
      {
        id: 'forge-b',
        title: 'Second active issue',
        status: 'in_progress',
        owner: 'harshanandak@users.noreply.github.com',
        comments: [{ text: `WorkflowState: ${JSON.stringify(createWorkflowState('validate'))}` }],
        updated_at: '2026-04-10T07:00:00Z',
      },
    ], {
      branch: 'feat/ambiguous-work',
    });

    const result = await statusCommand.handler([], {}, repoRoot);

    expect(result.missingWorkflowState).toBe(true);
    expect(result.output).toContain('No active workflow and no ready issues');
    expect(result.stageId).toBeUndefined();
  });
});

describe('status command zero-arg presentation', () => {
  test('zero-arg status renders all personal status sections in order', async () => {
    const repoRoot = createTempBeadsRepo([
      {
        id: 'forge-active',
        title: 'Active issue',
        status: 'in_progress',
        owner: 'harshanandak@users.noreply.github.com',
        design: '5 tasks | docs/plans/2026-04-10-forge-status-personal-focus-tasks.md',
        comments: [{ text: `WorkflowState: ${JSON.stringify(createWorkflowState('validate'))}` }],
        updated_at: '2026-04-10T08:00:00Z',
      },
      {
        id: 'forge-ready',
        title: 'Ready issue',
        status: 'open',
        dependency_count: 0,
        updated_at: '2026-04-09T08:00:00Z',
      },
      {
        id: 'forge-done',
        title: 'Completed issue',
        status: 'closed',
        updated_at: '2026-04-10T09:00:00Z',
      },
    ], {
      branch: 'feat/forge-status-personal-focus',
    });

    const result = await statusCommand.handler([], {}, repoRoot);

    // One-glance order: You are here → Context → Your work → newcomer footer.
    const blocks = ['You are here', 'Context', 'Your work', 'New here?'];
    for (const block of blocks) {
      expect(result.output).toContain(block);
    }

    expect(result.output.indexOf('You are here')).toBeLessThan(result.output.indexOf('Context'));
    expect(result.output.indexOf('Context')).toBeLessThan(result.output.indexOf('Your work'));
    expect(result.output.indexOf('Your work')).toBeLessThan(result.output.indexOf('New here?'));
    // Canonical per-classification stage heading (validate = stage 3 of 5 for standard).
    expect(result.output).toContain('Stage 3 of 5 — Validate (standard workflow)');
    expect(result.output).toContain('Run now: /validate');
    expect(result.output).toContain('forge-active');
    expect(result.output).toContain('Ready: 1 more');
    // Ready ids and recent completions are detail — hidden unless --full.
    expect(result.output).not.toContain('Recent Completions');
  });

  test('zero-arg status prints explicit empty-state lines for your-work', async () => {
    const repoRoot = createTempBeadsRepo([], {
      branch: 'feat/empty-status',
    });

    const result = await statusCommand.handler([], {}, repoRoot);

    expect(result.output).toContain('You are here');
    expect(result.output).toContain('Your work');
    expect(result.output).toContain('Active: none');
    expect(result.output).toContain('Ready: none');
  });

  test('zero-arg status includes blocked and stale personal focus sections', async () => {
    const repoRoot = createTempBeadsRepo([
      {
        id: 'forge-active-old',
        title: 'Old active issue',
        status: 'in_progress',
        owner: 'harshanandak@users.noreply.github.com',
        comments: [{ text: `WorkflowState: ${JSON.stringify(createWorkflowState('dev'))}` }],
        updated_at: '2026-04-01T08:00:00Z',
      },
      {
        id: 'forge-blocked',
        title: 'Blocked issue',
        status: 'open',
        owner: 'harshanandak@users.noreply.github.com',
        dependency_count: 1,
        updated_at: '2026-04-17T08:00:00Z',
      },
    ], {
      branch: 'feat/status-blocked-stale',
    });

    const result = await statusCommand.handler(['--full'], {
      now: new Date('2026-05-18T08:00:00Z'),
      staleAfterDays: 14,
    }, repoRoot);

    // Blocked/Stale are detail sections, surfaced only under --full.
    expect(result.output).toContain('Blocked');
    expect(result.output).toContain('Stale');
    expect(result.output).toContain('forge-blocked');
    expect(result.output).toContain('forge-active-old');
  });

  test('zero-arg status hides blocked/stale detail sections without --full', async () => {
    const repoRoot = createTempBeadsRepo([
      {
        id: 'forge-blocked',
        title: 'Blocked issue',
        status: 'open',
        owner: 'harshanandak@users.noreply.github.com',
        dependency_count: 1,
        updated_at: '2026-04-17T08:00:00Z',
      },
    ], {
      branch: 'feat/status-hidden-detail',
    });

    const result = await statusCommand.handler([], {
      now: new Date('2026-05-18T08:00:00Z'),
      staleAfterDays: 14,
    }, repoRoot);

    expect(result.output).not.toContain('Blocked');
    expect(result.output).not.toContain('Stale');
  });

  test('zero-arg status returns JSON for the same personal focus state', async () => {
    const repoRoot = createTempBeadsRepo([
      { id: 'forge-active', title: 'Active issue', status: 'in_progress', owner: 'harshanandak@users.noreply.github.com', updated_at: '2026-05-18T08:00:00Z' },
      { id: 'forge-blocked', title: 'Blocked issue', status: 'open', dependency_count: 1, updated_at: '2026-05-17T08:00:00Z' },
    ], {
      clean: true,
    });

    const result = await statusCommand.handler(['--json'], {}, repoRoot);
    const parsed = JSON.parse(result.output);

    expect(parsed.context.workingTree.clean).toBe(true);
    expect(parsed.personal.activeAssigned.map(issue => issue.id)).toEqual(['forge-active']);
    expect(parsed.personal.blocked.map(issue => issue.id)).toEqual(['forge-blocked']);
    expect(parsed.personal.ready).toEqual([]);
  });

  test('zero-arg status caps ready and completion sections for readability', async () => {
    const readyIssues = Array.from({ length: 6 }, (_value, index) => ({
      id: `forge-ready-${index + 1}`,
      title: `Ready ${index + 1}`,
      status: 'open',
      dependency_count: 0,
      updated_at: `2026-04-0${Math.min(index + 1, 9)}T08:00:00Z`,
    }));
    const completedIssues = Array.from({ length: 6 }, (_value, index) => ({
      id: `forge-done-${index + 1}`,
      title: `Done ${index + 1}`,
      status: 'closed',
      updated_at: `2026-04-1${Math.min(index, 9)}T08:00:00Z`,
    }));
    const repoRoot = createTempBeadsRepo([
      {
        id: 'forge-active',
        title: 'Active issue',
        status: 'in_progress',
        owner: 'harshanandak@users.noreply.github.com',
        design: '5 tasks | docs/plans/2026-04-10-forge-status-personal-focus-tasks.md',
        comments: [{ text: `WorkflowState: ${JSON.stringify(createWorkflowState('dev'))}` }],
        updated_at: '2026-04-10T08:00:00Z',
      },
      ...readyIssues,
      ...completedIssues,
    ], {
      branch: 'feat/forge-status-personal-focus',
    });

    // Default one-glance view: Ready is a count + hint, not a list of ids.
    const result = await statusCommand.handler([], {}, repoRoot);
    expect(result.output).toContain('Ready: 6 more (forge issue ready)');
    expect(result.output).not.toContain('forge-ready-1');
    expect(result.output).not.toContain('Recent Completions');

    // --full surfaces Recent Completions, still capped at 5 with an overflow note.
    const fullResult = await statusCommand.handler(['--full'], {}, repoRoot);
    expect(fullResult.output).toContain('Recent Completions');
    expect(fullResult.output).toContain('...and 1 more');
  });

  test('explicit workflow-state output preserves the authoritative stage-only format', async () => {
    const workflowState = JSON.stringify(createWorkflowState('validate'));

    const result = await statusCommand.handler(['--workflow-state', workflowState], {}, process.cwd());

    expect(result.output).toContain('Current Stage: validate - Validation');
    expect(result.output).not.toContain('Context');
    expect(result.output).not.toContain('Active Issues');
  });
});
