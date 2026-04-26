'use strict';

const { describe, expect, test } = require('bun:test');
const path = require('node:path');

const {
  buildTestExecutionPlan,
  classifyPushTests,
  runLocalValidationTests,
  runPrePushTests,
  stripGitHookEnv,
} = require('../../scripts/test');

const repoRoot = path.resolve(__dirname, '../..');

function makeExecFileSync({
  changedFiles = '',
  upstream = 'origin/fix/t3-worktree-guardrails',
  useUpstream = true,
} = {}) {
  return (cmd, args, _opts) => {
    if (cmd !== 'git') {
      throw new Error(`Unexpected command: ${cmd}`);
    }

    if (args[0] === 'rev-parse' && args.includes('@{upstream}')) {
      if (!useUpstream) {
        throw new Error('no upstream');
      }
      return upstream;
    }

    if (args[0] === 'diff') {
      return changedFiles;
    }

    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
      return 'origin/master';
    }

    if (args[0] === 'merge-base') {
      return 'abc123';
    }

    return '';
  };
}

function makeSpawnSync(exitCode = 0) {
  const calls = [];
  const fn = (command, args, options) => {
    calls.push({ args, command, options });
    return { status: exitCode };
  };
  fn.calls = calls;
  return fn;
}

describe('scripts/test pre-push runner', () => {
  test('stripGitHookEnv removes git hook environment variables', () => {
    const env = stripGitHookEnv({
      GIT_DIR: '.git',
      GIT_WORK_TREE: '.',
      GIT_INDEX_FILE: 'index',
      PATH: '/bin',
    });

    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_INDEX_FILE).toBeUndefined();
    expect(env.PATH).toBe('/bin');
  });

  test('classifyPushTests selects targeted unit tests and edge-case suite for lib changes', () => {
    const plan = classifyPushTests(repoRoot, makeExecFileSync({
      changedFiles: 'lib/commands/ship.js\n',
    }));

    expect(plan.runFullSuite).toBe(false);
    expect(plan.runTestEnv).toBe(true);
    expect(plan.runE2E).toBe(false);
    expect(plan.testTargets).toContain('test/commands/ship.test.js');
  });

  test('classifyPushTests maps canonical command edits to command sync checks', () => {
    const plan = classifyPushTests(repoRoot, makeExecFileSync({
      changedFiles: '.claude/commands/ship.md\n',
    }));

    expect(plan.testTargets).toEqual([
      'test/command-sync-check.test.js',
      'test/structural/command-sync.test.js',
    ]);
  });

  test('classifyPushTests maps mirrored agent assets without forcing a full suite', () => {
    const plan = classifyPushTests(repoRoot, makeExecFileSync({
      changedFiles: '.cursor/commands/ship.md\n.forge/sync-manifest.json\n',
    }));

    expect(plan.runFullSuite).toBe(false);
    expect(plan.hasUnmappedFiles).toBe(false);
    expect(plan.testTargets).toEqual([
      'test/agent-gaps.test.js',
      'test/command-sync-check.test.js',
      'test/scripts/check-agents.test.js',
      'test/structural/command-sync.test.js',
    ]);
  });

  test('buildTestExecutionPlan marks workflow-oriented targets explicitly', () => {
    const plan = buildTestExecutionPlan(repoRoot, makeExecFileSync({
      changedFiles: '.github/agentic-workflows/behavioral-test.md\n',
    }), { sinceUpstream: true });

    expect(plan.runWorkflowTests).toBe(true);
    expect(plan.mode).toBe('targeted');
    expect(plan.reason).toBe('known changes mapped to targeted tests');
    expect(plan.testTargets).toEqual([
      'test/scripts/behavioral-judge.test.js',
      'test/structural/agentic-workflow-sync.test.js',
    ]);
  });

  test('classifyPushTests maps runtime health and plan doc changes without forcing a full suite', () => {
    const plan = classifyPushTests(repoRoot, makeExecFileSync({
      changedFiles: [
        '.gitignore',
        'docs/plans/2026-04-26-preflight-bootstrap-design.md',
        'lib/lefthook-check.js',
        'scripts/preflight.sh',
        'scripts/test.js',
        'test/runtime-health.test.js',
        'test/scripts/preflight.test.js',
      ].join('\n'),
    }));

    expect(plan.runFullSuite).toBe(false);
    expect(plan.hasUnmappedFiles).toBe(false);
    expect(plan.testTargets).toEqual([
      'test/lefthook-check.test.js',
      'test/runtime-health.test.js',
      'test/scripts/preflight.test.js',
      'test/scripts/test-runner.test.js',
    ]);
  });

  test('classifyPushTests falls back to full suite for package-level changes', () => {
    const plan = classifyPushTests(repoRoot, makeExecFileSync({
      changedFiles: 'package.json\n',
    }));

    expect(plan.runFullSuite).toBe(true);
    expect(plan.runTestEnv).toBe(true);
    expect(plan.runE2E).toBe(true);
  });

  test('classifyPushTests falls back to full suite for unmapped pushed files', () => {
    const plan = classifyPushTests(repoRoot, makeExecFileSync({
      changedFiles: 'docs/random-spec.md\n',
    }));

    expect(plan.hasUnmappedFiles).toBe(true);
    expect(plan.runFullSuite).toBe(true);
    expect(plan.runTestEnv).toBe(false);
    expect(plan.runE2E).toBe(false);
    expect(plan.testTargets).toEqual([]);
  });

  test('buildTestExecutionPlan falls back to the full suite when known changes resolve zero runnable tests', () => {
    const plan = buildTestExecutionPlan(repoRoot, makeExecFileSync({
      changedFiles: 'test/scripts/smart-status.helpers.js\n',
    }), { sinceUpstream: true });

    expect(plan.hasUnmappedFiles).toBe(false);
    expect(plan.hasZeroResolvedTests).toBe(true);
    expect(plan.mode).toBe('full');
    expect(plan.runFullSuite).toBe(true);
    expect(plan.reason).toBe('known changes did not resolve runnable tests');
    expect(plan.testTargets).toEqual([]);
  });

  test('classifyPushTests falls back to full suite when changed files cannot be resolved', () => {
    const plan = classifyPushTests(repoRoot, makeExecFileSync({
      changedFiles: '',
      useUpstream: false,
    }));

    expect(plan.hasUnknownChangedFiles).toBe(true);
    expect(plan.runFullSuite).toBe(true);
    expect(plan.testTargets).toEqual([]);
  });

  test('runPrePushTests runs targeted tests instead of the full suite when possible', () => {
    const spawnSync = makeSpawnSync(0);
    const status = runPrePushTests(repoRoot, {
      env: { PATH: process.env.PATH || '' },
      execFileSync: makeExecFileSync({
        changedFiles: 'lib/commands/ship.js\n',
      }),
      pkgManager: 'bun',
      spawnSync,
    });

    expect(status).toBe(0);
    expect(spawnSync.calls[0].command).toBe('bun');
    expect(spawnSync.calls[0].args).toEqual(['run', 'test', 'test/commands/ship.test.js']);
    expect(spawnSync.calls[1].command).toBe('bun');
    expect(spawnSync.calls[1].args).toEqual(['test', 'test-env/']);
  });

  test('runPrePushTests skips broad unit tests when only canonical command docs changed', () => {
    const spawnSync = makeSpawnSync(0);
    const status = runPrePushTests(repoRoot, {
      env: { PATH: process.env.PATH || '' },
      execFileSync: makeExecFileSync({
        changedFiles: '.claude/commands/review.md\n',
      }),
      pkgManager: 'bun',
      spawnSync,
    });

    expect(status).toBe(0);
    expect(spawnSync.calls).toHaveLength(1);
    expect(spawnSync.calls[0].args).toEqual([
      'run',
      'test',
      'test/command-sync-check.test.js',
      'test/structural/command-sync.test.js',
    ]);
  });

  test('runPrePushTests falls back to the full unit suite for unmapped pushed files', () => {
    const spawnSync = makeSpawnSync(0);
    const status = runPrePushTests(repoRoot, {
      env: { PATH: process.env.PATH || '' },
      execFileSync: makeExecFileSync({
        changedFiles: 'docs/random-spec.md\n',
      }),
      pkgManager: 'bun',
      spawnSync,
    });

    expect(status).toBe(0);
    expect(spawnSync.calls).toHaveLength(1);
    expect(spawnSync.calls[0].command).toBe('node');
    expect(spawnSync.calls[0].args).toEqual(['scripts/test-full-suite.js']);
  });

  test('runLocalValidationTests reuses the same targeted runner path', () => {
    const spawnSync = makeSpawnSync(0);
    const status = runLocalValidationTests(repoRoot, {
      env: { PATH: process.env.PATH || '' },
      execFileSync: makeExecFileSync({
        changedFiles: '.github/agentic-workflows/behavioral-test.md\n',
      }),
      pkgManager: 'bun',
      spawnSync,
    });

    expect(status).toBe(0);
    expect(spawnSync.calls).toHaveLength(1);
    expect(spawnSync.calls[0].args).toEqual([
      'run',
      'test',
      'test/scripts/behavioral-judge.test.js',
      'test/structural/agentic-workflow-sync.test.js',
    ]);
  });

  test('runLocalValidationTests falls back to the full suite when no runnable tests are selected', () => {
    const spawnSync = makeSpawnSync(0);
    const status = runLocalValidationTests(repoRoot, {
      env: { PATH: process.env.PATH || '' },
      execFileSync: makeExecFileSync({
        changedFiles: 'test/scripts/smart-status.helpers.js\n',
      }),
      pkgManager: 'bun',
      spawnSync,
    });

    expect(status).toBe(0);
    expect(spawnSync.calls).toHaveLength(1);
    expect(spawnSync.calls[0].command).toBe('node');
    expect(spawnSync.calls[0].args).toEqual(['scripts/test-full-suite.js']);
  });

  test('runPrePushTests falls back to the full unit suite when diff-base resolution yields no changed files', () => {
    const spawnSync = makeSpawnSync(0);
    const status = runPrePushTests(repoRoot, {
      env: { PATH: process.env.PATH || '' },
      execFileSync: makeExecFileSync({
        changedFiles: '',
        useUpstream: false,
      }),
      pkgManager: 'bun',
      spawnSync,
    });

    expect(status).toBe(0);
    expect(spawnSync.calls).toHaveLength(1);
    expect(spawnSync.calls[0].command).toBe('node');
    expect(spawnSync.calls[0].args).toEqual(['scripts/test-full-suite.js']);
  });
});
