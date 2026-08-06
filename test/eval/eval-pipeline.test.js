const { describe, test, expect } = require('bun:test');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('node:child_process');
const { runEvalPipeline, parseArgs } = require('../../scripts/run-command-eval');
const { createEvalEvidence, buildEvalEvidenceHashes } = require('../../scripts/lib/eval-evidence');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temporary directory for test eval logs. */
function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eval-pipeline-'));
}

/** Create a temporary eval set JSON file and return its path. */
function writeTmpEvalSet(data) {
  const dir = makeTmpDir();
  const filePath = path.join(dir, 'test.eval.json');
  fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
  return filePath;
}

/** Minimal valid eval set. */
function minimalEvalSet() {
  return {
    command: '/status',
    description: 'Test eval set',
    queries: [
      {
        name: 'basic-status',
        prompt: 'Run /status and show current work',
        assertions: [
          { type: 'standard', check: 'shows current branch' },
        ],
      },
    ],
  };
}

/** Multi-query eval set for averaging tests. */
function multiQueryEvalSet() {
  return {
    command: '/status',
    description: 'Multi query eval set',
    queries: [
      {
        name: 'query-a',
        prompt: 'Run /status query A',
        assertions: [
          { type: 'standard', check: 'check A' },
        ],
      },
      {
        name: 'query-b',
        prompt: 'Run /status query B',
        assertions: [
          { type: 'standard', check: 'check B' },
        ],
      },
    ],
  };
}

/** Fake executeCommand override — returns valid NDJSON. */
const fakeExecute = async (_cmd, _prompt, _path, _timeout) => ({
  stdout: '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Here are the beads issues..."}]}}\n{"type":"result","result":{"cost_usd":0.01}}',
  stderr: '',
  exitCode: 0,
  timedOut: false,
});

/** Fake grader that passes all assertions with score 1.0. */
const fakeGraderPass = async (_transcript, assertions, _opts) => ({
  assertions: assertions.map((a) => ({ ...a, pass: true, reasoning: 'Looks good' })),
  score: 1.0,
});

/** Fake grader that fails all assertions with score 0.0. */
const fakeGraderFail = async (_transcript, assertions, _opts) => ({
  assertions: assertions.map((a) => ({ ...a, pass: false, reasoning: 'Not found' })),
  score: 0.0,
});

/** Fake grader with configurable per-query scores (cycles through array). */
function fakeGraderSequence(scores) {
  let index = 0;
  return async (_transcript, assertions, _opts) => {
    const score = scores[index % scores.length];
    index++;
    return {
      assertions: assertions.map((a) => ({
        ...a,
        pass: score >= 0.5,
        reasoning: `Score: ${score}`,
      })),
      score,
    };
  };
}

function validReplay(evalSet) {
  const inputs = { skill: 'recorded skill', tool: 'recorded tool' };
  return {
    envelope: createEvalEvidence({
      issue_id: '02f5ea90-4a1a-462f-9b22-54eb5d37f6b3',
      pr: 484,
      head_sha: execSync('git rev-parse HEAD', {
        cwd: path.resolve(__dirname, '..', '..'),
        encoding: 'utf-8',
      }).trim(),
      model: 'model-a',
      effort: 'high',
      role: 'implementation',
      hashes: buildEvalEvidenceHashes({ evalSet, skill: inputs.skill, tool: inputs.tool }),
      started_at: '2026-08-05T10:00:00.000Z',
      ended_at: '2026-08-05T10:00:03.000Z',
      active_ms: 2000,
      passive_ms: 1000,
      tokens: { input: 100, output: 25, cached: 5 },
      retries: 0,
      compactions: 0,
      gates: [{ name: 'tests', passed: true }],
    }),
    inputs,
  };
}

// ---------------------------------------------------------------------------
// runEvalPipeline — returns result object
// ---------------------------------------------------------------------------

describe('runEvalPipeline', () => {
  test('rejects a valid replay when worktree verification is skipped', async () => {
    const evalSet = minimalEvalSet();
    const evalSetPath = writeTmpEvalSet(evalSet);
    const tmpDir = makeTmpDir();
    let executed = false;

    await expect(runEvalPipeline(evalSetPath, {
      replay: validReplay(evalSet),
      _skipWorktree: true,
      _executeOverride: async (...args) => {
        executed = true;
        return fakeExecute(...args);
      },
      _invokeGrader: fakeGraderPass,
      _basePath: tmpDir,
    })).rejects.toThrow(/replay.*worktree.*cannot be skipped/i);

    expect(executed).toBe(false);
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  test('rejects malformed replay values by property presence before execution', async () => {
    const evalSetPath = writeTmpEvalSet(minimalEvalSet());

    for (const replay of [false, null, 0, '']) {
      let executed = false;
      await expect(runEvalPipeline(evalSetPath, {
        replay,
        _skipWorktree: true,
        _executeOverride: async (...args) => {
          executed = true;
          return fakeExecute(...args);
        },
        _invokeGrader: fakeGraderPass,
        _basePath: makeTmpDir(),
      })).rejects.toThrow(/replay must be an object/i);
      expect(executed).toBe(false);
    }
  });

  test('rejects command and query execution/scoring drift before worktree or command', async () => {
    const drifts = [
      (evalSet) => { evalSet.command = '/changed'; },
      (evalSet) => { evalSet.queries[0].name = 'changed-name'; },
      (evalSet) => { evalSet.queries[0].prompt = 'changed prompt'; },
      (evalSet) => { evalSet.queries[0].setup = 'echo changed'; },
      (evalSet) => { evalSet.queries[0].teardown = 'echo changed'; },
      (evalSet) => { evalSet.queries[0].assertions[0].check = 'changed check'; },
    ];
    for (const mutate of drifts) {
      const recordedEvalSet = minimalEvalSet();
      const driftedEvalSet = JSON.parse(JSON.stringify(recordedEvalSet));
      mutate(driftedEvalSet);
      const evalSetPath = writeTmpEvalSet(driftedEvalSet);
      const tmpDir = makeTmpDir();
      let executed = false;
      const envelope = createEvalEvidence({
        issue_id: '02f5ea90-4a1a-462f-9b22-54eb5d37f6b3',
        pr: 484,
        head_sha: 'a'.repeat(40),
        model: 'model-a',
        effort: 'high',
        role: 'implementation',
        hashes: buildEvalEvidenceHashes({ evalSet: recordedEvalSet, skill: 'recorded skill', tool: 'recorded tool' }),
        started_at: '2026-08-05T10:00:00.000Z',
        ended_at: '2026-08-05T10:00:03.000Z',
        active_ms: 2000,
        passive_ms: 1000,
        tokens: { input: 100, output: 25, cached: 5 },
        retries: 0,
        compactions: 0,
        gates: [{ name: 'tests', passed: true }],
      });
      await expect(runEvalPipeline(evalSetPath, {
        replay: { envelope, inputs: { skill: 'recorded skill', tool: 'recorded tool' } },
        _skipWorktree: true,
        _executeOverride: async (...args) => {
          executed = true;
          return fakeExecute(...args);
        },
        _invokeGrader: fakeGraderPass,
        _basePath: tmpDir,
      })).rejects.toThrow(/eval_set hash drift/);
      expect(executed).toBe(false);
      expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    }
  });

  test('cannot replay by echoing recorded hashes as current input contents', async () => {
    const evalSet = minimalEvalSet();
    const evalSetPath = writeTmpEvalSet(evalSet);
    const tmpDir = makeTmpDir();
    let executed = false;
    const envelope = createEvalEvidence({
      issue_id: '02f5ea90-4a1a-462f-9b22-54eb5d37f6b3',
      pr: 484,
      head_sha: 'a'.repeat(40),
      model: 'model-a',
      effort: 'high',
      role: 'implementation',
      hashes: buildEvalEvidenceHashes({ evalSet, skill: 'recorded skill', tool: 'recorded tool' }),
      started_at: '2026-08-05T10:00:00.000Z',
      ended_at: '2026-08-05T10:00:03.000Z',
      active_ms: 2000,
      passive_ms: 1000,
      tokens: { input: 100, output: 25, cached: 5 },
      retries: 0,
      compactions: 0,
      gates: [{ name: 'tests', passed: true }],
    });

    await expect(runEvalPipeline(evalSetPath, {
      replay: {
        envelope,
        inputs: {
          skill: envelope.evidence.hashes.skill,
          tool: envelope.evidence.hashes.tool,
        },
      },
      _skipWorktree: true,
      _executeOverride: async (...args) => {
        executed = true;
        return fakeExecute(...args);
      },
      _invokeGrader: fakeGraderPass,
      _basePath: tmpDir,
    })).rejects.toThrow(/skill hash drift/i);

    expect(executed).toBe(false);
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  test('accepts eval set path and returns result object', async () => {
    const evalSetPath = writeTmpEvalSet(minimalEvalSet());
    const tmpDir = makeTmpDir();

    const result = await runEvalPipeline(evalSetPath, {
      _skipWorktree: true,
      _executeOverride: fakeExecute,
      _invokeGrader: fakeGraderPass,
      _basePath: tmpDir,
    });

    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
  });

  test('result has command, results, overall_score, passed, duration_ms fields', async () => {
    const evalSetPath = writeTmpEvalSet(minimalEvalSet());
    const tmpDir = makeTmpDir();

    const result = await runEvalPipeline(evalSetPath, {
      _skipWorktree: true,
      _executeOverride: fakeExecute,
      _invokeGrader: fakeGraderPass,
      _basePath: tmpDir,
    });

    expect(result).toHaveProperty('command');
    expect(result).toHaveProperty('results');
    expect(result).toHaveProperty('overall_score');
    expect(result).toHaveProperty('passed');
    expect(result).toHaveProperty('duration_ms');
    expect(result.command).toBe('/status');
    expect(Array.isArray(result.results)).toBe(true);
    expect(typeof result.overall_score).toBe('number');
    expect(typeof result.passed).toBe('boolean');
    expect(typeof result.duration_ms).toBe('number');
  });

  test('score above threshold sets passed to true', async () => {
    const evalSetPath = writeTmpEvalSet(minimalEvalSet());
    const tmpDir = makeTmpDir();

    const result = await runEvalPipeline(evalSetPath, {
      _skipWorktree: true,
      _executeOverride: fakeExecute,
      _invokeGrader: fakeGraderPass,
      _basePath: tmpDir,
      threshold: 0.7,
    });

    expect(result.overall_score).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  test('score below threshold sets passed to false', async () => {
    const evalSetPath = writeTmpEvalSet(minimalEvalSet());
    const tmpDir = makeTmpDir();

    const result = await runEvalPipeline(evalSetPath, {
      _skipWorktree: true,
      _executeOverride: fakeExecute,
      _invokeGrader: fakeGraderFail,
      _basePath: tmpDir,
      threshold: 0.7,
    });

    expect(result.overall_score).toBe(0.0);
    expect(result.passed).toBe(false);
  });

  test('overall_score is average of query scores', async () => {
    const evalSetPath = writeTmpEvalSet(multiQueryEvalSet());
    const tmpDir = makeTmpDir();

    // First query scores 1.0, second scores 0.0 → average 0.5
    const result = await runEvalPipeline(evalSetPath, {
      _skipWorktree: true,
      _executeOverride: fakeExecute,
      _invokeGrader: fakeGraderSequence([1.0, 0.0]),
      _basePath: tmpDir,
      threshold: 0.7,
    });

    expect(result.overall_score).toBe(0.5);
    expect(result.passed).toBe(false);
  });

  test('--timeout option is passed to executeCommand', async () => {
    const evalSetPath = writeTmpEvalSet(minimalEvalSet());
    const tmpDir = makeTmpDir();

    let capturedTimeout;
    const capturingExecute = async (_cmd, _prompt, _path, timeout) => {
      capturedTimeout = timeout;
      return fakeExecute(_cmd, _prompt, _path, timeout);
    };

    await runEvalPipeline(evalSetPath, {
      _skipWorktree: true,
      _executeOverride: capturingExecute,
      _invokeGrader: fakeGraderPass,
      _basePath: tmpDir,
      timeout: 60000,
    });

    expect(capturedTimeout).toBe(60000);
  });

  test('--threshold option changes cutoff', async () => {
    const evalSetPath = writeTmpEvalSet(multiQueryEvalSet());
    const tmpDir = makeTmpDir();

    // Both queries score 0.4 → overall 0.4
    const result = await runEvalPipeline(evalSetPath, {
      _skipWorktree: true,
      _executeOverride: fakeExecute,
      _invokeGrader: fakeGraderSequence([0.4, 0.4]),
      _basePath: tmpDir,
      threshold: 0.3,
    });

    expect(result.overall_score).toBe(0.4);
    expect(result.passed).toBe(true); // 0.4 >= 0.3
  });

  test('saves result to basePath via saveEvalResult', async () => {
    const evalSetPath = writeTmpEvalSet(minimalEvalSet());
    const tmpDir = makeTmpDir();

    const result = await runEvalPipeline(evalSetPath, {
      _skipWorktree: true,
      _executeOverride: fakeExecute,
      _invokeGrader: fakeGraderPass,
      _basePath: tmpDir,
    });

    // Check that a file was written in tmpDir
    const files = fs.readdirSync(tmpDir);
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]).toMatch(/\.json$/);

    // Verify saved content matches result
    const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), 'utf8'));
    expect(saved.command).toBe('/status');
    expect(saved.overall_score).toBe(result.overall_score);
  });

  test('setup and teardown commands are executed when present', async () => {
    const evalSet = {
      command: '/status',
      description: 'Test with setup/teardown',
      queries: [
        {
          name: 'with-setup',
          prompt: 'Run /status',
          setup: 'echo setup-ran',
          teardown: 'echo teardown-ran',
          assertions: [
            { type: 'standard', check: 'check something' },
          ],
        },
      ],
    };
    const evalSetPath = writeTmpEvalSet(evalSet);
    const tmpDir = makeTmpDir();

    // Should not throw — setup/teardown are handled gracefully
    const result = await runEvalPipeline(evalSetPath, {
      _skipWorktree: true,
      _executeOverride: fakeExecute,
      _invokeGrader: fakeGraderPass,
      _basePath: tmpDir,
    });

    expect(result).toBeDefined();
    expect(result.results.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  test('parses eval set path from first positional arg', () => {
    const args = parseArgs(['path/to/eval.json']);
    expect(args.evalSetPath).toBe('path/to/eval.json');
  });

  test('parses --timeout flag', () => {
    const args = parseArgs(['path/to/eval.json', '--timeout', '60000']);
    expect(args.timeout).toBe(60000);
  });

  test('parses --threshold flag', () => {
    const args = parseArgs(['path/to/eval.json', '--threshold', '0.5']);
    expect(args.threshold).toBe(0.5);
  });

  test('uses default threshold of 0.7 when not specified', () => {
    const args = parseArgs(['path/to/eval.json']);
    expect(args.threshold).toBe(0.7);
  });

  test('uses default timeout of 120000 when not specified', () => {
    const args = parseArgs(['path/to/eval.json']);
    expect(args.timeout).toBe(120000);
  });

  test('throws when no eval set path provided', () => {
    expect(() => parseArgs([])).toThrow();
  });
});
