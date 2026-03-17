/**
 * Semi-autonomous improvement loop: analyze eval failures, rewrite command,
 * re-evaluate, and stop on regression or plateau.
 *
 * Usage:
 *   bun scripts/improve-command.js <command-path> --eval-set <path> [--max-iterations <N>]
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const { DEFAULT_BASE_PATH, loadEvalHistory } = require('./lib/eval-storage');

// ---------------------------------------------------------------------------
// analyzeFailures
// ---------------------------------------------------------------------------

/**
 * Extract failing assertions with their query context from an eval result.
 *
 * @param {object} evalResult - result from runEvalPipeline
 * @returns {Array<{ query: string, assertion: string, reasoning: string }>}
 */
function analyzeFailures(evalResult) {
  const failures = [];

  for (const queryResult of evalResult.results) {
    for (const assertion of queryResult.assertions) {
      if (!assertion.pass) {
        failures.push({
          query: queryResult.prompt,
          assertion: assertion.check,
          reasoning: assertion.reasoning,
        });
      }
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// buildRewritePrompt
// ---------------------------------------------------------------------------

/**
 * Build a prompt asking for a command rewrite that fixes the identified failures.
 *
 * @param {string} commandContent - current command markdown content
 * @param {Array<{ query: string, assertion: string, reasoning: string }>} failures
 * @param {object[]} history - array of prior eval results (from loadEvalHistory)
 * @returns {string}
 */
function buildRewritePrompt(commandContent, failures, history) {
  let prompt = '';

  prompt += 'You are a command prompt engineer. Rewrite the following command to fix the failing assertions.\n\n';

  prompt += '## Current Command\n\n';
  prompt += commandContent + '\n\n';

  prompt += '## Failing Assertions\n\n';
  for (const failure of failures) {
    prompt += `- Query: "${failure.query}"\n`;
    prompt += `  Assertion: "${failure.assertion}"\n`;
    prompt += `  Reasoning: "${failure.reasoning}"\n\n`;
  }

  if (history && history.length > 0) {
    prompt += '## Prior Eval Attempts\n\n';
    prompt += 'Avoid repeating approaches that have already been tried. Here is a summary of prior attempts:\n\n';
    for (let i = 0; i < history.length; i++) {
      const attempt = history[i];
      const failCount = attempt.results
        ? attempt.results.filter((result) => result.assertions && result.assertions.some((assertion) => !assertion.pass)).length
        : 0;
      prompt += `- Attempt ${i + 1}: score ${attempt.overall_score}, ${failCount} failing queries\n`;
    }
    prompt += '\n';

    // Detect flaky assertions: the same check both passed and failed across sessions.
    const assertionOutcomes = new Map();
    for (const attempt of history) {
      if (!attempt.results) continue;
      for (const result of attempt.results) {
        if (!result.assertions) continue;
        for (const assertion of result.assertions) {
          if (!assertionOutcomes.has(assertion.check)) {
            assertionOutcomes.set(assertion.check, { pass: 0, fail: 0 });
          }
          const entry = assertionOutcomes.get(assertion.check);
          if (assertion.pass) {
            entry.pass++;
          } else {
            entry.fail++;
          }
        }
      }
    }

    const flakyAssertions = [];
    for (const [check, outcomes] of assertionOutcomes) {
      if (outcomes.pass > 0 && outcomes.fail > 0) {
        flakyAssertions.push({ check, pass: outcomes.pass, fail: outcomes.fail });
      }
    }

    if (flakyAssertions.length > 0) {
      prompt += '## Flaky/Inconsistent Assertions\n\n';
      prompt += 'These assertions are flaky - they pass in some sessions and fail in others. ';
      prompt += 'Do not waste iterations on these; they may depend on environment rather than command quality.\n\n';
      for (const flakyAssertion of flakyAssertions) {
        prompt += `- "${flakyAssertion.check}" - passed ${flakyAssertion.pass}x, failed ${flakyAssertion.fail}x across sessions\n`;
      }
      prompt += '\n';
    }
  }

  prompt += '## Instructions\n\n';
  prompt += 'Return ONLY the rewritten command markdown content. No explanation, no code fences.\n';

  return prompt;
}

// ---------------------------------------------------------------------------
// generateDiff
// ---------------------------------------------------------------------------

/**
 * Simple line-by-line diff showing added (+) and removed (-) lines.
 *
 * @param {string} original
 * @param {string} modified
 * @returns {string}
 */
function generateDiff(original, modified) {
  const originalLines = original.split('\n');
  const modifiedLines = modified.split('\n');

  if (original === modified) {
    return '';
  }

  const lines = [];
  let i = 0;
  let j = 0;

  while (i < originalLines.length || j < modifiedLines.length) {
    if (i < originalLines.length && j < modifiedLines.length && originalLines[i] === modifiedLines[j]) {
      lines.push(' ' + originalLines[i]);
      i++;
      j++;
    } else {
      const originalLineInModified = j < modifiedLines.length ? modifiedLines.indexOf(originalLines[i], j) : -1;
      const modifiedLineInOriginal = i < originalLines.length ? originalLines.indexOf(modifiedLines[j], i) : -1;

      if (i >= originalLines.length) {
        lines.push('+' + modifiedLines[j]);
        j++;
      } else if (j >= modifiedLines.length) {
        lines.push('-' + originalLines[i]);
        i++;
      } else if (
        originalLineInModified !== -1 &&
        (modifiedLineInOriginal === -1 || originalLineInModified - j <= modifiedLineInOriginal - i)
      ) {
        lines.push('+' + modifiedLines[j]);
        j++;
      } else {
        lines.push('-' + originalLines[i]);
        i++;
      }
    }
  }

  return lines.join('\n');
}

/**
 * Default rewrite invocation via `claude -p`.
 *
 * @param {string} prompt
 * @param {{ timeout?: number, _execFileSync?: Function }} [options]
 * @returns {Promise<string>}
 */
async function defaultRewriteCommand(prompt, options = {}) {
  const timeout = options.timeout || 120_000;
  const execFile = options._execFileSync || execFileSync;

  return execFile(
    'claude',
    ['-p', prompt, '--output-format', 'text', '--no-session-persistence'],
    {
      encoding: 'utf-8',
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    }
  );
}

// ---------------------------------------------------------------------------
// runImprovementLoop
// ---------------------------------------------------------------------------

/**
 * Main improvement loop orchestrator.
 *
 * @param {string} commandPath - path to the command markdown file
 * @param {string} evalSetPath - path to the .eval.json file
 * @param {object} [options]
 * @param {number} [options.maxIterations=3]
 * @param {Function} [options._runEval] - injectable eval function for testing
 * @param {Function} [options._rewriteCommand] - injectable rewriter for testing
 * @param {string} [options._basePath] - eval-logs base path for testing
 * @returns {Promise<{ original: string, best: string, originalScore: number, bestScore: number, iterations: number, reason: string, diff: string }>}
 */
async function runImprovementLoop(commandPath, evalSetPath, options = {}) {
  const maxIterations = options.maxIterations || 3;
  const runEval = options._runEval;
  const rewriteCommand = options._rewriteCommand || ((prompt) => defaultRewriteCommand(prompt, options));
  const basePath = options._basePath || DEFAULT_BASE_PATH;

  const originalContent = fs.readFileSync(commandPath, 'utf8');
  let bestContent = originalContent;

  try {
    const baselineResult = await runEval(evalSetPath);
    const originalScore = baselineResult.overall_score;
    const history = loadEvalHistory(baselineResult.command, basePath);

    let bestScore = originalScore;
    let latestResult = baselineResult;
    let previousScore = originalScore;
    let iterations = 0;
    let reason = 'max_iterations';

    for (let iter = 1; iter <= maxIterations; iter++) {
      iterations = iter;

      const failures = analyzeFailures(latestResult);
      const prompt = buildRewritePrompt(
        fs.readFileSync(commandPath, 'utf8'),
        failures,
        history
      );

      const newContent = await rewriteCommand(prompt);
      fs.writeFileSync(commandPath, newContent, 'utf8');

      const newResult = await runEval(evalSetPath);
      const newScore = newResult.overall_score;

      if (newScore < bestScore) {
        fs.writeFileSync(commandPath, bestContent, 'utf8');
        reason = 'regression';
        break;
      }

      if (newScore === previousScore) {
        if (newScore >= bestScore) {
          bestContent = newContent;
          bestScore = newScore;
        }
        fs.writeFileSync(commandPath, bestContent, 'utf8');
        reason = 'plateau';
        break;
      }

      if (newScore > bestScore) {
        bestContent = newContent;
        bestScore = newScore;
      }

      previousScore = newScore;
      latestResult = newResult;

      if (iter === maxIterations) {
        reason = 'max_iterations';
      }
    }

    fs.writeFileSync(commandPath, bestContent, 'utf8');

    return {
      original: originalContent,
      best: bestContent,
      originalScore,
      bestScore,
      iterations,
      reason,
      diff: generateDiff(originalContent, bestContent),
    };
  } catch (err) {
    try {
      fs.writeFileSync(commandPath, bestContent, 'utf8');
    } catch (_restoreErr) {
      // Preserve the original failure if restoring also fails.
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * Parse CLI arguments.
 *
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{ commandPath: string, evalSetPath: string, maxIterations: number }}
 */
function parseCliArgs(argv) {
  let commandPath = null;
  let evalSetPath = null;
  let maxIterations = 3;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--eval-set' && i + 1 < argv.length) {
      evalSetPath = argv[i + 1];
      i++;
    } else if (argv[i] === '--max-iterations' && i + 1 < argv.length) {
      maxIterations = Number(argv[i + 1]);
      i++;
    } else if (!argv[i].startsWith('--')) {
      commandPath = argv[i];
    }
  }

  if (!commandPath) {
    throw new Error('Usage: improve-command <command-path> --eval-set <path> [--max-iterations <N>]');
  }
  if (!evalSetPath) {
    throw new Error('Missing required --eval-set <path>');
  }

  return { commandPath, evalSetPath, maxIterations };
}

if (require.main === module) {
  const args = parseCliArgs(process.argv.slice(2));
  const { runEvalPipeline } = require('./run-command-eval');

  runImprovementLoop(args.commandPath, args.evalSetPath, {
    maxIterations: args.maxIterations,
    _runEval: (evalPath) => runEvalPipeline(evalPath),
  })
    .then((result) => {
      console.log('\n=== Improvement Summary ===');
      console.log(`Original score: ${result.originalScore.toFixed(2)}`);
      console.log(`Best score:     ${result.bestScore.toFixed(2)}`);
      console.log(`Iterations:     ${result.iterations}`);
      console.log(`Reason:         ${result.reason}`);

      if (result.diff) {
        console.log('\n=== Diff (original -> best) ===');
        console.log(result.diff);
      } else {
        console.log('\nNo changes made.');
      }

      console.log('\nDiff shown above. Review and decide whether to apply.');
    })
    .catch((err) => {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    });
}

module.exports = {
  analyzeFailures,
  buildRewritePrompt,
  defaultRewriteCommand,
  generateDiff,
  runImprovementLoop,
};
