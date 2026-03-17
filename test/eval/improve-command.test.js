const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  analyzeFailures,
  buildRewritePrompt,
  defaultRewriteCommand,
  generateDiff,
  runImprovementLoop,
} = require('../../scripts/improve-command');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp directory for test artifacts. */
function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'improve-cmd-'));
}

/** Build a fake eval result with controlled scores and assertion outcomes. */
function fakeEvalResult(score, failingAssertions = [], passingAssertions = []) {
  const results = [];

  for (const fa of failingAssertions) {
    results.push({
      name: fa.queryName || 'query-1',
      prompt: fa.queryPrompt || 'Run /status',
      score: 0.0,
      assertions: [
        { type: 'standard', check: fa.check, pass: false, reasoning: fa.reasoning || 'Not found' },
      ],
      exitCode: 0,
      timedOut: false,
    });
  }

  for (const pa of passingAssertions) {
    results.push({
      name: pa.queryName || 'query-pass',
      prompt: pa.queryPrompt || 'Run /status',
      score: 1.0,
      assertions: [
        { type: 'standard', check: pa.check, pass: true, reasoning: pa.reasoning || 'Looks good' },
      ],
      exitCode: 0,
      timedOut: false,
    });
  }

  return {
    command: '/status',
    overall_score: score,
    results,
    passed: score >= 0.7,
    duration_ms: 5000,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// analyzeFailures
// ---------------------------------------------------------------------------

describe('analyzeFailures', () => {
  test('extracts failing assertions with query context', () => {
    const evalResult = fakeEvalResult(0.5, [
      { queryName: 'basic-status', queryPrompt: 'Run /status', check: 'shows current branch', reasoning: 'Branch not shown' },
      { queryName: 'beads-check', queryPrompt: 'Check beads', check: 'lists open issues', reasoning: 'No issues listed' },
    ], [
      { queryName: 'passing-query', queryPrompt: 'Simple check', check: 'has output', reasoning: 'Output present' },
    ]);

    const failures = analyzeFailures(evalResult);

    expect(Array.isArray(failures)).toBe(true);
    expect(failures).toHaveLength(2);

    expect(failures[0]).toHaveProperty('query');
    expect(failures[0]).toHaveProperty('assertion');
    expect(failures[0]).toHaveProperty('reasoning');

    expect(failures[0].query).toBe('Run /status');
    expect(failures[0].assertion).toBe('shows current branch');
    expect(failures[0].reasoning).toBe('Branch not shown');

    expect(failures[1].query).toBe('Check beads');
    expect(failures[1].assertion).toBe('lists open issues');
    expect(failures[1].reasoning).toBe('No issues listed');
  });

  test('returns empty array when all assertions pass', () => {
    const evalResult = fakeEvalResult(1.0, [], [
      { check: 'has output', reasoning: 'Output present' },
    ]);

    const failures = analyzeFailures(evalResult);

    expect(failures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildRewritePrompt
// ---------------------------------------------------------------------------

describe('buildRewritePrompt', () => {
  test('includes command content and failure descriptions', () => {
    const commandContent = '# /status\nShow project status with beads and git info.';
    const failures = [
      { query: 'Run /status', assertion: 'shows current branch', reasoning: 'Branch not shown' },
    ];

    const prompt = buildRewritePrompt(commandContent, failures, []);

    expect(typeof prompt).toBe('string');
    expect(prompt).toContain(commandContent);
    expect(prompt).toContain('shows current branch');
    expect(prompt).toContain('Branch not shown');
    expect(prompt).toContain('Run /status');
  });

  test('includes history summary when provided', () => {
    const commandContent = '# /status\nShow project status.';
    const failures = [
      { query: 'Run /status', assertion: 'shows branch', reasoning: 'Missing' },
    ];
    const history = [
      fakeEvalResult(0.5, [{ check: 'shows branch' }]),
      fakeEvalResult(0.3, [{ check: 'shows branch' }, { check: 'shows beads' }]),
    ];

    const prompt = buildRewritePrompt(commandContent, failures, history);

    expect(prompt).toContain('0.5');
    expect(prompt).toContain('0.3');
    // Should mention prior attempts to prevent repeated approaches
    expect(prompt.toLowerCase()).toContain('prior');
  });

  test('works with empty history', () => {
    const commandContent = '# /status\nShow status.';
    const failures = [
      { query: 'Run /status', assertion: 'shows branch', reasoning: 'Missing' },
    ];

    const prompt = buildRewritePrompt(commandContent, failures, []);

    expect(typeof prompt).toBe('string');
    expect(prompt).toContain(commandContent);
    expect(prompt).toContain('shows branch');
  });
});

// ---------------------------------------------------------------------------
// generateDiff
// ---------------------------------------------------------------------------

describe('generateDiff', () => {
  test('shows added and removed lines', () => {
    const original = 'line one\nline two\nline three';
    const modified = 'line one\nline TWO modified\nline three\nline four';

    const diff = generateDiff(original, modified);

    expect(typeof diff).toBe('string');
    expect(diff).toContain('-');
    expect(diff).toContain('+');
    // Removed line
    expect(diff).toContain('line two');
    // Added line
    expect(diff).toContain('line TWO modified');
    expect(diff).toContain('line four');
  });

  test('returns empty string when content is identical', () => {
    const content = 'same\ncontent\nhere';

    const diff = generateDiff(content, content);

    expect(diff).toBe('');
  });
});

// ---------------------------------------------------------------------------
// runImprovementLoop
// ---------------------------------------------------------------------------

describe('runImprovementLoop', () => {
  let tmpDir;
  let commandDir;
  let commandPath;
  let evalSetPath;
  let logsDir;
  let originalCwd;

  beforeEach(() => {
    tmpDir = makeTmpDir('improve-loop-');
    originalCwd = process.cwd();
    commandDir = path.join(tmpDir, 'commands');
    fs.mkdirSync(commandDir, { recursive: true });

    commandPath = path.join(commandDir, 'status.md');
    fs.writeFileSync(commandPath, '# /status\nOriginal command content.\nShow git info and beads.', 'utf8');

    // Create a minimal eval set file
    const evalSetDir = path.join(tmpDir, 'eval-sets');
    fs.mkdirSync(evalSetDir, { recursive: true });
    evalSetPath = path.join(evalSetDir, 'status.eval.json');
    fs.writeFileSync(evalSetPath, JSON.stringify({
      command: '/status',
      description: 'Status eval',
      queries: [
        {
          name: 'basic',
          prompt: 'Run /status',
          assertions: [{ type: 'standard', check: 'shows branch' }],
        },
      ],
    }), 'utf8');

    logsDir = path.join(tmpDir, 'eval-logs');
    fs.mkdirSync(logsDir, { recursive: true });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('score improves → continues iteration, returns reason "max_iterations"', async () => {
    let evalCallCount = 0;
    const fakeRunEval = async () => {
      evalCallCount++;
      if (evalCallCount === 1) return fakeEvalResult(0.5, [{ check: 'shows branch', reasoning: 'Missing' }]);
      if (evalCallCount === 2) return fakeEvalResult(0.7, [{ check: 'shows branch', reasoning: 'Partially shown' }]);
      if (evalCallCount === 3) return fakeEvalResult(0.8, [{ check: 'shows branch', reasoning: 'Almost' }]);
      return fakeEvalResult(0.9, []);
    };

    const fakeRewriter = async (_prompt) => {
      return '# /status\nImproved command v' + evalCallCount;
    };

    const result = await runImprovementLoop(commandPath, evalSetPath, {
      maxIterations: 3,
      _runEval: fakeRunEval,
      _rewriteCommand: fakeRewriter,
      _basePath: logsDir,
    });

    expect(result.reason).toBe('max_iterations');
    expect(result.bestScore).toBeGreaterThan(result.originalScore);
    expect(result.originalScore).toBe(0.5);
    expect(result.iterations).toBe(3);
  });

  test('score improves then stops at max → returns reason "improved" when score keeps improving', async () => {
    let evalCallCount = 0;
    const fakeRunEval = async () => {
      evalCallCount++;
      if (evalCallCount === 1) return fakeEvalResult(0.4, [{ check: 'a', reasoning: 'fail' }]);
      return fakeEvalResult(0.6 + evalCallCount * 0.1, []);
    };

    const fakeRewriter = async () => '# improved\ncontent';

    const result = await runImprovementLoop(commandPath, evalSetPath, {
      maxIterations: 2,
      _runEval: fakeRunEval,
      _rewriteCommand: fakeRewriter,
      _basePath: logsDir,
    });

    expect(result.bestScore).toBeGreaterThan(result.originalScore);
  });

  test('score regresses → rolls back, returns reason "regression"', async () => {
    let evalCallCount = 0;
    const fakeRunEval = async () => {
      evalCallCount++;
      if (evalCallCount === 1) return fakeEvalResult(0.6, [{ check: 'a', reasoning: 'fail' }]);
      if (evalCallCount === 2) return fakeEvalResult(0.4, [{ check: 'a', reasoning: 'worse' }]); // regression
      return fakeEvalResult(0.9, []);
    };

    const fakeRewriter = async () => '# worse\nbad rewrite';

    const result = await runImprovementLoop(commandPath, evalSetPath, {
      maxIterations: 3,
      _runEval: fakeRunEval,
      _rewriteCommand: fakeRewriter,
      _basePath: logsDir,
    });

    expect(result.reason).toBe('regression');
    expect(result.iterations).toBe(1);
    // Best should equal original since regression happened on first iteration
    expect(result.bestScore).toBe(0.6);

    // Command file should be restored to original (or best)
    const restoredContent = fs.readFileSync(commandPath, 'utf8');
    expect(restoredContent).toContain('Original command content');
  });

  test('score plateaus (same 2x) → stops, returns reason "plateau"', async () => {
    let evalCallCount = 0;
    const fakeRunEval = async () => {
      evalCallCount++;
      if (evalCallCount === 1) return fakeEvalResult(0.5, [{ check: 'a', reasoning: 'fail' }]);
      if (evalCallCount === 2) return fakeEvalResult(0.7, [{ check: 'a', reasoning: 'better' }]);
      if (evalCallCount === 3) return fakeEvalResult(0.7, [{ check: 'a', reasoning: 'same' }]); // plateau
      return fakeEvalResult(0.9, []);
    };

    const fakeRewriter = async () => '# same\nno improvement';

    const result = await runImprovementLoop(commandPath, evalSetPath, {
      maxIterations: 5,
      _runEval: fakeRunEval,
      _rewriteCommand: fakeRewriter,
      _basePath: logsDir,
    });

    expect(result.reason).toBe('plateau');
    expect(result.bestScore).toBe(0.7);
    expect(result.iterations).toBe(2);
  });

  test('maxIterations respected', async () => {
    let evalCallCount = 0;
    const fakeRunEval = async () => {
      evalCallCount++;
      return fakeEvalResult(0.3 + evalCallCount * 0.1, [{ check: 'a', reasoning: 'fail' }]);
    };

    const fakeRewriter = async () => '# improved\ncontent v' + evalCallCount;

    const result = await runImprovementLoop(commandPath, evalSetPath, {
      maxIterations: 2,
      _runEval: fakeRunEval,
      _rewriteCommand: fakeRewriter,
      _basePath: logsDir,
    });

    // Baseline eval + 2 iterations = 3 eval calls
    expect(evalCallCount).toBe(3);
    expect(result.iterations).toBe(2);
  });

  test('original command backed up and restorable on regression', async () => {
    const originalContent = fs.readFileSync(commandPath, 'utf8');

    let evalCallCount = 0;
    const fakeRunEval = async () => {
      evalCallCount++;
      if (evalCallCount === 1) return fakeEvalResult(0.6, [{ check: 'a', reasoning: 'fail' }]);
      return fakeEvalResult(0.3, [{ check: 'a', reasoning: 'worse' }]); // always regress
    };

    const fakeRewriter = async () => '# completely different\nrewritten content';

    const result = await runImprovementLoop(commandPath, evalSetPath, {
      maxIterations: 3,
      _runEval: fakeRunEval,
      _rewriteCommand: fakeRewriter,
      _basePath: logsDir,
    });

    expect(result.reason).toBe('regression');

    // The file should be restored to the original content
    const restoredContent = fs.readFileSync(commandPath, 'utf8');
    expect(restoredContent).toBe(originalContent);
  });

  test('returns result with all expected fields', async () => {
    let evalCallCount = 0;
    const fakeRunEval = async () => {
      evalCallCount++;
      if (evalCallCount === 1) return fakeEvalResult(0.5, [{ check: 'a', reasoning: 'fail' }]);
      return fakeEvalResult(0.8, []);
    };

    const fakeRewriter = async () => '# improved\nnew content';

    const result = await runImprovementLoop(commandPath, evalSetPath, {
      maxIterations: 1,
      _runEval: fakeRunEval,
      _rewriteCommand: fakeRewriter,
      _basePath: logsDir,
    });

    expect(result).toHaveProperty('original');
    expect(result).toHaveProperty('best');
    expect(result).toHaveProperty('originalScore');
    expect(result).toHaveProperty('bestScore');
    expect(result).toHaveProperty('iterations');
    expect(result).toHaveProperty('reason');
    expect(result).toHaveProperty('diff');

    expect(typeof result.original).toBe('string');
    expect(typeof result.best).toBe('string');
    expect(typeof result.originalScore).toBe('number');
    expect(typeof result.bestScore).toBe('number');
    expect(typeof result.iterations).toBe('number');
    expect(typeof result.reason).toBe('string');
    expect(typeof result.diff).toBe('string');
  });

  test('best version is restored after loop (not necessarily the last iteration)', async () => {
    let evalCallCount = 0;
    const rewriteVersions = [];

    const fakeRunEval = async () => {
      evalCallCount++;
      if (evalCallCount === 1) return fakeEvalResult(0.4, [{ check: 'a', reasoning: 'fail' }]);
      if (evalCallCount === 2) return fakeEvalResult(0.8, []);  // best
      if (evalCallCount === 3) return fakeEvalResult(0.6, [{ check: 'a', reasoning: 'regress' }]); // regression
      return fakeEvalResult(0.5, []);
    };

    let rewriteCount = 0;
    const fakeRewriter = async () => {
      rewriteCount++;
      const content = `# version ${rewriteCount}\nRewrite attempt ${rewriteCount}`;
      rewriteVersions.push(content);
      return content;
    };

    const result = await runImprovementLoop(commandPath, evalSetPath, {
      maxIterations: 5,
      _runEval: fakeRunEval,
      _rewriteCommand: fakeRewriter,
      _basePath: logsDir,
    });

    expect(result.reason).toBe('regression');
    expect(result.bestScore).toBe(0.8);

    // The file should contain the best version (version 1, which scored 0.8)
    const fileContent = fs.readFileSync(commandPath, 'utf8');
    expect(fileContent).toBe(rewriteVersions[0]); // version 1 was the best
  });

  test('uses the default eval log path when _basePath is not provided', async () => {
    const defaultLogsDir = path.join(tmpDir, '.forge', 'eval-logs');
    fs.mkdirSync(defaultLogsDir, { recursive: true });
    process.chdir(tmpDir);

    fs.writeFileSync(
      path.join(defaultLogsDir, '2026-03-16-14-30-status.json'),
      JSON.stringify({
        command: '/status',
        timestamp: '2026-03-16T14:30:00Z',
        overall_score: 0.4,
        results: [],
      }),
      'utf8'
    );

    let capturedPrompt = '';
    let evalCallCount = 0;

    const fakeRunEval = async () => {
      evalCallCount++;
      if (evalCallCount === 1) {
        return fakeEvalResult(0.5, [{ check: 'shows branch', reasoning: 'Missing' }]);
      }
      return fakeEvalResult(0.8, []);
    };

    const fakeRewriter = async (prompt) => {
      capturedPrompt = prompt;
      return '# /status\nImproved command';
    };

    await runImprovementLoop(commandPath, evalSetPath, {
      maxIterations: 1,
      _runEval: fakeRunEval,
      _rewriteCommand: fakeRewriter,
    });

    expect(capturedPrompt).toContain('0.4');
  });

  test('restores the last safe command content if eval throws after a rewrite', async () => {
    const originalContent = fs.readFileSync(commandPath, 'utf8');
    let evalCallCount = 0;

    const fakeRunEval = async () => {
      evalCallCount++;
      if (evalCallCount === 1) {
        return fakeEvalResult(0.5, [{ check: 'shows branch', reasoning: 'Missing' }]);
      }
      throw new Error('eval runner crashed');
    };

    const fakeRewriter = async () => '# /status\nBroken in-progress rewrite';

    await expect(
      runImprovementLoop(commandPath, evalSetPath, {
        maxIterations: 1,
        _runEval: fakeRunEval,
        _rewriteCommand: fakeRewriter,
        _basePath: logsDir,
      })
    ).rejects.toThrow('eval runner crashed');

    const restoredContent = fs.readFileSync(commandPath, 'utf8');
    expect(restoredContent).toBe(originalContent);
  });
});

describe('defaultRewriteCommand', () => {
  test('invokes claude with non-interactive text output flags', async () => {
    let receivedCommand = null;
    let receivedArgs = null;
    let receivedOptions = null;

    const result = await defaultRewriteCommand('Rewrite this command', {
      timeout: 42_000,
      _execFileSync: (command, args, options) => {
        receivedCommand = command;
        receivedArgs = args;
        receivedOptions = options;
        return '# rewritten command';
      },
    });

    expect(result).toBe('# rewritten command');
    expect(receivedCommand).toBe('claude');
    expect(receivedArgs).toEqual([
      '-p',
      'Rewrite this command',
      '--output-format',
      'text',
      '--no-session-persistence',
    ]);
    expect(receivedOptions.encoding).toBe('utf-8');
    expect(receivedOptions.timeout).toBe(42_000);
    expect(receivedOptions.maxBuffer).toBe(10 * 1024 * 1024);
  });
});
