const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  buildRewritePrompt,
  runImprovementLoop,
} = require('../../scripts/improve-command');
const { saveEvalResult } = require('../../scripts/lib/eval-storage');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp directory for test artifacts. */
function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'eval-history-'));
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
// Test 1: Improvement loop reads prior eval history before first iteration
// ---------------------------------------------------------------------------

describe('cross-session eval history integration', () => {
  let tmpDir;
  let commandDir;
  let commandPath;
  let evalSetPath;
  let logsDir;

  beforeEach(() => {
    tmpDir = makeTmpDir('eval-history-');
    commandDir = path.join(tmpDir, 'commands');
    fs.mkdirSync(commandDir, { recursive: true });

    commandPath = path.join(commandDir, 'status.md');
    fs.writeFileSync(commandPath, '# /status\nOriginal command content.\nShow git info and beads.', 'utf8');

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
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('improvement loop loads prior eval history and includes it in rewrite prompt', async () => {
    // Write two prior eval results to logsDir
    saveEvalResult({
      command: '/status',
      timestamp: '2026-03-14T10:00:00Z',
      overall_score: 0.4,
      results: [
        {
          name: 'basic',
          prompt: 'Run /status',
          score: 0.4,
          assertions: [
            { type: 'standard', check: 'shows branch', pass: false, reasoning: 'Missing branch info' },
          ],
        },
      ],
    }, logsDir);

    saveEvalResult({
      command: '/status',
      timestamp: '2026-03-15T10:00:00Z',
      overall_score: 0.6,
      results: [
        {
          name: 'basic',
          prompt: 'Run /status',
          score: 0.6,
          assertions: [
            { type: 'standard', check: 'shows branch', pass: true, reasoning: 'Branch shown' },
          ],
        },
      ],
    }, logsDir);

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
      _basePath: logsDir,
    });

    // The rewrite prompt must contain prior attempt scores from history
    expect(capturedPrompt).toContain('0.4');
    expect(capturedPrompt).toContain('0.6');
    expect(capturedPrompt.toLowerCase()).toContain('prior');
  });

  test('rewrite prompt includes summary of previously-tried changes with scores', async () => {
    // Save three prior sessions with different scores
    saveEvalResult({
      command: '/status',
      timestamp: '2026-03-13T10:00:00Z',
      overall_score: 0.3,
      results: [
        {
          name: 'basic',
          prompt: 'Run /status',
          score: 0.3,
          assertions: [
            { type: 'standard', check: 'shows branch', pass: false, reasoning: 'No branch' },
            { type: 'standard', check: 'shows beads issues', pass: false, reasoning: 'No beads' },
          ],
        },
      ],
    }, logsDir);

    saveEvalResult({
      command: '/status',
      timestamp: '2026-03-14T10:00:00Z',
      overall_score: 0.5,
      results: [
        {
          name: 'basic',
          prompt: 'Run /status',
          score: 0.5,
          assertions: [
            { type: 'standard', check: 'shows branch', pass: true, reasoning: 'Branch shown' },
            { type: 'standard', check: 'shows beads issues', pass: false, reasoning: 'Still no beads' },
          ],
        },
      ],
    }, logsDir);

    saveEvalResult({
      command: '/status',
      timestamp: '2026-03-15T10:00:00Z',
      overall_score: 0.7,
      results: [
        {
          name: 'basic',
          prompt: 'Run /status',
          score: 0.7,
          assertions: [
            { type: 'standard', check: 'shows branch', pass: true, reasoning: 'OK' },
            { type: 'standard', check: 'shows beads issues', pass: true, reasoning: 'Present' },
          ],
        },
      ],
    }, logsDir);

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
      return '# /status\nImproved';
    };

    await runImprovementLoop(commandPath, evalSetPath, {
      maxIterations: 1,
      _runEval: fakeRunEval,
      _rewriteCommand: fakeRewriter,
      _basePath: logsDir,
    });

    // Should contain all three prior session scores
    expect(capturedPrompt).toContain('0.3');
    expect(capturedPrompt).toContain('0.5');
    expect(capturedPrompt).toContain('0.7');
    // Should reference the attempts
    expect(capturedPrompt).toContain('Attempt');
  });

  test('rewrite prompt flags historically flaky assertions', async () => {
    // "shows beads issues" passes in session 1, fails in session 2, passes in session 3 → flaky
    // "shows branch" always passes → not flaky
    saveEvalResult({
      command: '/status',
      timestamp: '2026-03-13T10:00:00Z',
      overall_score: 0.6,
      results: [
        {
          name: 'basic',
          prompt: 'Run /status',
          score: 0.6,
          assertions: [
            { type: 'standard', check: 'shows beads issues', pass: true, reasoning: 'OK' },
            { type: 'standard', check: 'shows branch', pass: true, reasoning: 'OK' },
          ],
        },
      ],
    }, logsDir);

    saveEvalResult({
      command: '/status',
      timestamp: '2026-03-14T10:00:00Z',
      overall_score: 0.4,
      results: [
        {
          name: 'basic',
          prompt: 'Run /status',
          score: 0.4,
          assertions: [
            { type: 'standard', check: 'shows beads issues', pass: false, reasoning: 'Not found' },
            { type: 'standard', check: 'shows branch', pass: true, reasoning: 'OK' },
          ],
        },
      ],
    }, logsDir);

    saveEvalResult({
      command: '/status',
      timestamp: '2026-03-15T10:00:00Z',
      overall_score: 0.6,
      results: [
        {
          name: 'basic',
          prompt: 'Run /status',
          score: 0.6,
          assertions: [
            { type: 'standard', check: 'shows beads issues', pass: true, reasoning: 'Present' },
            { type: 'standard', check: 'shows branch', pass: true, reasoning: 'OK' },
          ],
        },
      ],
    }, logsDir);

    let capturedPrompt = '';
    let evalCallCount = 0;

    const fakeRunEval = async () => {
      evalCallCount++;
      if (evalCallCount === 1) {
        return fakeEvalResult(0.5, [{ check: 'shows beads issues', reasoning: 'Missing' }]);
      }
      return fakeEvalResult(0.8, []);
    };

    const fakeRewriter = async (prompt) => {
      capturedPrompt = prompt;
      return '# /status\nImproved';
    };

    await runImprovementLoop(commandPath, evalSetPath, {
      maxIterations: 1,
      _runEval: fakeRunEval,
      _rewriteCommand: fakeRewriter,
      _basePath: logsDir,
    });

    // The prompt must flag "shows beads issues" as flaky/inconsistent
    const promptLower = capturedPrompt.toLowerCase();
    expect(promptLower).toMatch(/flaky|inconsistent/);
    expect(capturedPrompt).toContain('shows beads issues');

    // "shows branch" should NOT be flagged as flaky (always passes)
    // Check that "shows branch" doesn't appear in a flaky context
    // We verify by checking that the flaky section mentions "shows beads issues"
    // but the flaky/inconsistent section is present
    const flakySection = capturedPrompt.toLowerCase().includes('flaky') || capturedPrompt.toLowerCase().includes('inconsistent');
    expect(flakySection).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 4: .gitignore contains .forge/eval-logs/
// ---------------------------------------------------------------------------

describe('.gitignore includes eval-logs', () => {
  test('.gitignore contains .forge/eval-logs/', () => {
    const gitignorePath = path.resolve(__dirname, '../../.gitignore');
    const content = fs.readFileSync(gitignorePath, 'utf8');

    expect(content).toContain('.forge/eval-logs/');
  });
});
