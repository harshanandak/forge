'use strict';

const { describe, expect, test } = require('bun:test');
const path = require('node:path');

const {
  ALWAYS_RUN_RISK_TEST_TARGETS,
  DEFAULT_FULL_SUITE_TIMEOUT_MS,
  DEFAULT_TEST_COMMAND_TIMEOUT_MS,
  buildTestExecutionPlan,
  classifyPushTests,
  resolveCommandTimeoutMs,
  resolveFullSuiteTimeoutMs,
  runLocalValidationTests,
  runPrePushTests,
  runTestExecutionPlan,
  stripGitHookEnv,
} = require('../../scripts/test');

const repoRoot = path.resolve(__dirname, '../..');
const riskTargets = [...ALWAYS_RUN_RISK_TEST_TARGETS];

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
    expect(plan.testTargets).toEqual(expect.arrayContaining(riskTargets));
  });

  test('classifyPushTests marks .claude/commands/ edits as unmapped — full suite (A0d: commands surface removed)', () => {
    const plan = classifyPushTests(repoRoot, makeExecFileSync({
      changedFiles: '.claude/commands/ship.md\n',
    }));

    // .claude/commands/ is not in KNOWN_TARGETABLE_PREFIXES (removed in A0d).
    // hasUnmappedFiles → shouldRunFullSuite → testTargets is affectedTestTargets (empty).
    expect(plan.runFullSuite).toBe(true);
    expect(plan.hasUnmappedFiles).toBe(true);
    expect(plan.testTargets).toEqual([]);
  });

  test('classifyPushTests maps mirrored agent assets without forcing a full suite', () => {
    const plan = classifyPushTests(repoRoot, makeExecFileSync({
      changedFiles: '.cursor/commands/ship.md\n.forge/sync-manifest.json\n',
    }));

    expect(plan.runFullSuite).toBe(false);
    expect(plan.hasUnmappedFiles).toBe(false);
    expect(plan.testTargets).toEqual([
      'test/agent-gaps.test.js',
      'test/scripts/check-agents.test.js',
      'test/structural/skills-sync-drift.test.js',
      ...riskTargets,
    ]);
  });

  test('classifyPushTests maps skills-only changes to the skill suite without forcing a full suite', () => {
    const plan = classifyPushTests(repoRoot, makeExecFileSync({
      changedFiles: 'skills/gates/SKILL.md\nskills/coverage.json\n.agents/skills/gates/SKILL.md\n',
    }));

    // Skill sources are mapped, not "unmapped" — so a skills-only PR runs the fast
    // targeted skill suite instead of the full ~1500-test suite (which flaky-hangs).
    expect(plan.runFullSuite).toBe(false);
    expect(plan.hasUnmappedFiles).toBe(false);
    expect(plan.mode).toBe('targeted');
    expect(plan.testTargets).toContain('test/skill-coverage.test.js');
    expect(plan.testTargets).toContain('test/skills-structure.test.js');
    expect(plan.testTargets).toContain('test/structural/skills-sync-drift.test.js');
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
      ...riskTargets,
    ]);
  });

  test('classifyPushTests maps runtime health and plan doc changes without forcing a full suite', () => {
    const plan = classifyPushTests(repoRoot, makeExecFileSync({
      changedFiles: [
        '.gitignore',
        'docs/work/2026-04-26-preflight-bootstrap/plan.md',
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
      'test/docs-consistency.test.js',
      'test/lefthook-check.test.js',
      'test/runtime-health.test.js',
      'test/scripts/preflight.test.js',
      'test/scripts/test-runner.test.js',
      ...riskTargets,
    ]);
  });

  test('classifyPushTests maps CLI entrypoint setup changes without forcing a full suite', () => {
    const plan = classifyPushTests(repoRoot, makeExecFileSync({
      changedFiles: 'bin/forge.js\n',
    }));

    expect(plan.runFullSuite).toBe(false);
    expect(plan.hasUnmappedFiles).toBe(false);
    expect(plan.testTargets).toEqual([
      'test/cli-flags.test.js',
      'test/forge-cli-registry.test.js',
      'test/setup-github-sync.test.js',
      'test/setup-runtime-flags.test.js',
      ...riskTargets,
    ]);
  });

  // Regression: bin/forge-cmd.js matched neither the lib//scripts/ arm nor the
  // explicit bin/forge.js entry, so touching it silently forced the 10-minute
  // full-suite lane. Slice B2's push hit exactly that and never reached the remote.
  test('classifyPushTests maps the forge-cmd CLI surface without forcing a full suite', () => {
    const plan = classifyPushTests(repoRoot, makeExecFileSync({
      changedFiles: 'bin/forge-cmd.js\n',
    }));

    expect(plan.runFullSuite).toBe(false);
    expect(plan.hasUnmappedFiles).toBe(false);
    expect(plan.testTargets).toEqual([
      'test/cli/forge-cmd.test.js',
      'test/forge-cmd-shepherd.test.js',
      ...riskTargets,
    ]);
  });

  test('classifyPushTests maps the forge-preflight CLI surface without forcing a full suite', () => {
    const plan = classifyPushTests(repoRoot, makeExecFileSync({
      changedFiles: 'bin/forge-preflight.js\n',
    }));

    expect(plan.runFullSuite).toBe(false);
    expect(plan.hasUnmappedFiles).toBe(false);
    expect(plan.testTargets).toEqual([
      'test/bin/forge-preflight.test.js',
      ...riskTargets,
    ]);
  });

  test('classifyPushTests maps upgrade safety docs and support modules without forcing a full suite', () => {
    const plan = classifyPushTests(repoRoot, makeExecFileSync({
      changedFiles: [
        'docs/INDEX.md',
        'docs/reference/upgrade-safety.md',
        'lib/upgrade-safety.js',
        'lib/commands/upgrade.js',
      ].join('\n'),
    }));

    expect(plan.runFullSuite).toBe(false);
    expect(plan.hasUnmappedFiles).toBe(false);
    expect(plan.testTargets).toEqual([
      'test/commands/upgrade.test.js',
      'test/docs-consistency.test.js',
      ...riskTargets,
    ]);
  });

  test('classifyPushTests maps canonical docs without forcing shell-heavy full suite tests', () => {
    const plan = classifyPushTests(repoRoot, makeExecFileSync({
      changedFiles: [
        'README.md',
        'QUICKSTART.md',
        'CHANGELOG.md',
        'AGENTS.md',
        'docs/guides/SUPPORT.md',
        'docs/forge/TOOLCHAIN.md',
        'docs/work/README.md',
      ].join('\n'),
    }));

    expect(plan.runFullSuite).toBe(false);
    expect(plan.hasUnmappedFiles).toBe(false);
    expect(plan.testTargets).toEqual([
      'test/docs-consistency.test.js',
      ...riskTargets,
    ]);
  });

  test('classifyPushTests maps codex assets outside skills/ to parity tests in targeted mode', () => {
    const plan = classifyPushTests(repoRoot, makeExecFileSync({
      changedFiles: '.codex/AGENTS.md\n',
    }));

    expect(plan.runFullSuite).toBe(false);
    expect(plan.hasUnmappedFiles).toBe(false);
    expect(plan.testTargets).toEqual([
      'test/agent-gaps.test.js',
      'test/scripts/check-agents.test.js',
      'test/structural/skills-sync-drift.test.js',
      ...riskTargets,
    ]);
  });

  test('classifyPushTests keeps top-level design docs in targeted mode', () => {
    const plan = classifyPushTests(repoRoot, makeExecFileSync({
      changedFiles: [
        'docs/PROJECT_DESIGN.md',
        'DEVELOPMENT.md',
      ].join('\n'),
    }));

    expect(plan.runFullSuite).toBe(false);
    expect(plan.hasUnmappedFiles).toBe(false);
    expect(plan.testTargets).toEqual([
      'test/docs-consistency.test.js',
      ...riskTargets,
    ]);
  });

  test('buildTestExecutionPlan always includes curated risk tests in targeted mode', () => {
    const plan = buildTestExecutionPlan(repoRoot, makeExecFileSync({
      changedFiles: 'scripts/behavioral-judge.sh\n',
    }), { sinceUpstream: true });

    expect(plan.mode).toBe('targeted');
    expect(plan.testTargets).toEqual(expect.arrayContaining([
      'test/scripts/behavioral-judge.test.js',
      'test/project-memory.test.js',
    ]));
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

  test('buildTestExecutionPlan preserves zero-target full fallback before adding risk tests', () => {
    const plan = buildTestExecutionPlan(repoRoot, makeExecFileSync({
      changedFiles: 'scripts/new-maintenance-task.sh\n',
    }), { sinceUpstream: true });

    expect(plan.hasZeroResolvedTests).toBe(true);
    expect(plan.mode).toBe('full');
    expect(plan.runFullSuite).toBe(true);
    expect(plan.testTargets).toEqual([]);
  });

  test('buildTestExecutionPlan keeps e2e-only helper changes in targeted mode', () => {
    const plan = buildTestExecutionPlan(repoRoot, makeExecFileSync({
      changedFiles: 'test/e2e/helpers/scaffold.js\n',
    }), { sinceUpstream: true });

    expect(plan.hasZeroResolvedTests).toBe(false);
    expect(plan.mode).toBe('targeted');
    expect(plan.runFullSuite).toBe(false);
    expect(plan.runE2E).toBe(true);
    expect(plan.testTargets).toEqual(riskTargets);
  });

  test('buildTestExecutionPlan preserves e2e lane for mixed zero-target changes', () => {
    const plan = buildTestExecutionPlan(repoRoot, makeExecFileSync({
      changedFiles: 'test/e2e/helpers/scaffold.js\nscripts/new-maintenance-task.sh\n',
    }), { sinceUpstream: true });

    expect(plan.hasZeroResolvedTests).toBe(true);
    expect(plan.mode).toBe('full');
    expect(plan.runFullSuite).toBe(true);
    expect(plan.runE2E).toBe(true);
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
    expect(spawnSync.calls[0].args).toEqual([
      'run',
      'test',
      'test/commands/ship.test.js',
      ...riskTargets,
    ]);
    expect(spawnSync.calls[1].command).toBe('bun');
    expect(spawnSync.calls[1].args).toEqual(['test', '--timeout', '15000', 'test-env/']);
  });

  test('runPrePushTests runs full suite when only .claude/commands/ docs changed (A0d: commands surface removed)', () => {
    const spawnSync = makeSpawnSync(0);
    const status = runPrePushTests(repoRoot, {
      env: { PATH: process.env.PATH || '' },
      execFileSync: makeExecFileSync({
        changedFiles: '.claude/commands/review.md\n',
      }),
      pkgManager: 'bun',
      spawnSync,
    });

    // .claude/commands/ is unmapped (removed in A0d) → hasUnmappedFiles → full suite via test-full-suite.js.
    expect(status).toBe(0);
    expect(spawnSync.calls).toHaveLength(1);
    expect(spawnSync.calls[0].command).toBe('node');
    expect(spawnSync.calls[0].args).toEqual(['scripts/test-full-suite.js']);
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

  test('runPrePushTests runs e2e lane after full suite for mixed zero-target e2e changes', () => {
    const spawnSync = makeSpawnSync(0);
    const status = runPrePushTests(repoRoot, {
      env: { PATH: process.env.PATH || '' },
      execFileSync: makeExecFileSync({
        changedFiles: 'test/e2e/helpers/scaffold.js\nscripts/new-maintenance-task.sh\n',
      }),
      pkgManager: 'bun',
      spawnSync,
    });

    expect(status).toBe(0);
    expect(spawnSync.calls).toHaveLength(2);
    expect(spawnSync.calls[0].command).toBe('node');
    expect(spawnSync.calls[0].args).toEqual(['scripts/test-full-suite.js']);
    expect(spawnSync.calls[1].command).toBe('bun');
    expect(spawnSync.calls[1].args).toEqual(['test', '--timeout', '15000', 'test/e2e/']);
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
      ...riskTargets,
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

  test('every spawned test lane carries a wall-clock timeout so a hung test cannot block the push forever', () => {
    const spawnSync = makeSpawnSync(0);
    runPrePushTests(repoRoot, {
      env: { PATH: process.env.PATH || '' },
      execFileSync: makeExecFileSync({
        changedFiles: 'lib/commands/ship.js\n',
      }),
      pkgManager: 'bun',
      spawnSync,
    });

    expect(spawnSync.calls.length).toBeGreaterThan(0);
    for (const call of spawnSync.calls) {
      expect(call.options.timeout).toBe(DEFAULT_TEST_COMMAND_TIMEOUT_MS);
      expect(call.options.killSignal).toBe('SIGKILL');
    }
  });

  test('FORGE_TEST_TIMEOUT_MS overrides the wall-clock lane timeout', () => {
    const spawnSync = makeSpawnSync(0);
    runPrePushTests(repoRoot, {
      env: { FORGE_TEST_TIMEOUT_MS: '5000', PATH: process.env.PATH || '' },
      execFileSync: makeExecFileSync({
        changedFiles: 'lib/commands/ship.js\n',
      }),
      pkgManager: 'bun',
      spawnSync,
    });

    expect(spawnSync.calls.length).toBeGreaterThan(0);
    for (const call of spawnSync.calls) {
      expect(call.options.timeout).toBe(5000);
    }
  });

  test('resolveCommandTimeoutMs ignores invalid overrides and falls back to the default', () => {
    expect(resolveCommandTimeoutMs({})).toBe(DEFAULT_TEST_COMMAND_TIMEOUT_MS);
    expect(resolveCommandTimeoutMs({ FORGE_TEST_TIMEOUT_MS: 'nonsense' })).toBe(DEFAULT_TEST_COMMAND_TIMEOUT_MS);
    expect(resolveCommandTimeoutMs({ FORGE_TEST_TIMEOUT_MS: '-1' })).toBe(DEFAULT_TEST_COMMAND_TIMEOUT_MS);
    expect(resolveCommandTimeoutMs({ FORGE_TEST_TIMEOUT_MS: '20000' })).toBe(20000);
  });

  test('the full-suite fallback lane uses the larger validation-aligned budget, not the fail-fast ceiling', () => {
    const spawnSync = makeSpawnSync(0);
    runPrePushTests(repoRoot, {
      env: { PATH: process.env.PATH || '' },
      // Unmapped pushed file → hasUnmappedFiles → full-suite fallback lane.
      execFileSync: makeExecFileSync({ changedFiles: 'docs/random-spec.md\n' }),
      pkgManager: 'bun',
      spawnSync,
    });

    const fullSuiteCall = spawnSync.calls.find(
      (call) => call.command === 'node' && call.args[0] === 'scripts/test-full-suite.js'
    );
    expect(fullSuiteCall).toBeTruthy();
    expect(fullSuiteCall.options.timeout).toBe(DEFAULT_FULL_SUITE_TIMEOUT_MS);
    expect(fullSuiteCall.options.timeout).toBeGreaterThan(DEFAULT_TEST_COMMAND_TIMEOUT_MS);
    expect(fullSuiteCall.options.killSignal).toBe('SIGKILL');
  });

  test('resolveFullSuiteTimeoutMs defaults to the validation-aligned budget and honors valid overrides', () => {
    expect(resolveFullSuiteTimeoutMs({})).toBe(DEFAULT_FULL_SUITE_TIMEOUT_MS);
    expect(resolveFullSuiteTimeoutMs({ FORGE_TEST_TIMEOUT_MS: 'nonsense' })).toBe(DEFAULT_FULL_SUITE_TIMEOUT_MS);
    expect(resolveFullSuiteTimeoutMs({ FORGE_TEST_TIMEOUT_MS: '-1' })).toBe(DEFAULT_FULL_SUITE_TIMEOUT_MS);
    expect(resolveFullSuiteTimeoutMs({ FORGE_TEST_TIMEOUT_MS: '7000' })).toBe(7000);
    // The full-suite default must clear the targeted-lane fail-fast ceiling.
    expect(DEFAULT_FULL_SUITE_TIMEOUT_MS).toBeGreaterThan(DEFAULT_TEST_COMMAND_TIMEOUT_MS);
  });

  test('a lane that times out fails fast with a non-zero status instead of hanging', () => {
    const timedOutSpawnSync = () => ({
      error: Object.assign(new Error('spawnSync bun ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      signal: 'SIGKILL',
      status: null,
    });

    const status = runTestExecutionPlan({
      changedFiles: ['lib/commands/ship.js'],
      mode: 'targeted',
      reason: 'known changes mapped to targeted tests',
      runE2E: false,
      runFullSuite: false,
      runTestEnv: false,
      testTargets: ['test/commands/ship.test.js'],
    }, {
      env: { PATH: process.env.PATH || '' },
      pkgManager: 'bun',
      spawnSync: timedOutSpawnSync,
    });

    expect(status).not.toBe(0);
  });
});
