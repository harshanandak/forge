/**
 * Semi-autonomous improvement loop — analyze eval failures, rewrite command,
 * re-evaluate, and stop on regression or plateau.
 *
 * Usage:
 *   bun scripts/improve-command.js <command-path> --eval-set <path> [--max-iterations <N>]
 */

const fs = require('fs');
const { loadEvalHistory } = require('./lib/eval-storage');

// ---------------------------------------------------------------------------
// analyzeFailures
// ---------------------------------------------------------------------------

/**
 * Extract failing assertions with their query context from an eval result.
 *
 * @param {object} evalResult — result from runEvalPipeline
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
 * @param {string} commandContent — current command markdown content
 * @param {Array<{ query: string, assertion: string, reasoning: string }>} failures
 * @param {object[]} history — array of prior eval results (from loadEvalHistory)
 * @returns {string}
 */
function buildRewritePrompt(commandContent, failures, history) {
  let prompt = '';

  prompt += 'You are a command prompt engineer. Rewrite the following command to fix the failing assertions.\n\n';

  prompt += '## Current Command\n\n';
  prompt += commandContent + '\n\n';

  prompt += '## Failing Assertions\n\n';
  for (const f of failures) {
    prompt += `- Query: "${f.query}"\n`;
    prompt += `  Assertion: "${f.assertion}"\n`;
    prompt += `  Reasoning: "${f.reasoning}"\n\n`;
  }

  if (history && history.length > 0) {
    prompt += '## Prior Eval Attempts\n\n';
    prompt += 'Avoid repeating approaches that have already been tried. Here is a summary of prior attempts:\n\n';
    for (let i = 0; i < history.length; i++) {
      const h = history[i];
      const failCount = h.results
        ? h.results.filter((r) => r.assertions && r.assertions.some((a) => !a.pass)).length
        : 0;
      prompt += `- Attempt ${i + 1}: score ${h.overall_score}, ${failCount} failing queries\n`;
    }
    prompt += '\n';
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
  const origLines = original.split('\n');
  const modLines = modified.split('\n');

  if (original === modified) {
    return '';
  }

  const lines = [];
  const maxLen = Math.max(origLines.length, modLines.length);

  // Simple LCS-based diff using a set approach:
  // Mark lines present in original but not modified as removed,
  // and lines present in modified but not original as added.
  // For identical lines, output them as context.

  // Build a more accurate line-by-line diff using edit distance approach
  const origSet = new Map();
  for (const line of origLines) {
    origSet.set(line, (origSet.get(line) || 0) + 1);
  }

  const modSet = new Map();
  for (const line of modLines) {
    modSet.set(line, (modSet.get(line) || 0) + 1);
  }

  // Walk through both arrays using two pointers
  let i = 0;
  let j = 0;

  while (i < origLines.length || j < modLines.length) {
    if (i < origLines.length && j < modLines.length && origLines[i] === modLines[j]) {
      // Same line — context
      lines.push(' ' + origLines[i]);
      i++;
      j++;
    } else {
      // Check if the original line appears later in modified (it was moved/kept)
      const origLineInMod = j < modLines.length ? modLines.indexOf(origLines[i], j) : -1;
      const modLineInOrig = i < origLines.length ? origLines.indexOf(modLines[j], i) : -1;

      if (i >= origLines.length) {
        // Only modified lines left — additions
        lines.push('+' + modLines[j]);
        j++;
      } else if (j >= modLines.length) {
        // Only original lines left — removals
        lines.push('-' + origLines[i]);
        i++;
      } else if (origLineInMod !== -1 && (modLineInOrig === -1 || origLineInMod - j <= modLineInOrig - i)) {
        // Modified line was added before a matching original line
        lines.push('+' + modLines[j]);
        j++;
      } else {
        // Original line was removed
        lines.push('-' + origLines[i]);
        i++;
      }
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// runImprovementLoop
// ---------------------------------------------------------------------------

/**
 * Main improvement loop orchestrator.
 *
 * @param {string} commandPath — path to the command markdown file
 * @param {string} evalSetPath — path to the .eval.json file
 * @param {object} [options]
 * @param {number} [options.maxIterations=3]
 * @param {Function} [options._runEval] — injectable eval function for testing
 * @param {Function} [options._rewriteCommand] — injectable rewriter for testing
 * @param {string} [options._basePath] — eval-logs base path for testing
 * @returns {Promise<{ original: string, best: string, originalScore: number, bestScore: number, iterations: number, reason: string, diff: string }>}
 */
async function runImprovementLoop(commandPath, evalSetPath, options = {}) {
  const maxIterations = options.maxIterations || 3;
  const runEval = options._runEval;
  const rewriteCommand = options._rewriteCommand;
  const basePath = options._basePath;

  // 1. Read original command content (backup in memory)
  const originalContent = fs.readFileSync(commandPath, 'utf8');

  // 2. Run eval → baseline score
  const baselineResult = await runEval(evalSetPath);
  const originalScore = baselineResult.overall_score;

  // 3. Load prior eval history
  const history = basePath ? loadEvalHistory(baselineResult.command, basePath) : [];

  // Track best version
  let bestContent = originalContent;
  let bestScore = originalScore;
  let latestResult = baselineResult;
  let previousScore = originalScore;
  let iterations = 0;
  let reason = 'max_iterations';

  // 4. Iteration loop
  for (let iter = 1; iter <= maxIterations; iter++) {
    iterations = iter;

    // a. Analyze failures from latest eval result
    const failures = analyzeFailures(latestResult);

    // b. Build rewrite prompt (including history)
    const prompt = buildRewritePrompt(
      fs.readFileSync(commandPath, 'utf8'),
      failures,
      history
    );

    // c. Call rewriter to get new command content
    const newContent = await rewriteCommand(prompt);

    // d. Write new content to command file
    fs.writeFileSync(commandPath, newContent, 'utf8');

    // e. Re-run eval → new score
    const newResult = await runEval(evalSetPath);
    const newScore = newResult.overall_score;

    // f. If score dropped: restore best version, STOP
    if (newScore < bestScore) {
      fs.writeFileSync(commandPath, bestContent, 'utf8');
      reason = 'regression';
      break;
    }

    // g. If plateaued (same score 2 consecutive times): STOP
    if (newScore === previousScore) {
      // Update best if this is at least as good
      if (newScore >= bestScore) {
        bestContent = newContent;
        bestScore = newScore;
      }
      fs.writeFileSync(commandPath, bestContent, 'utf8');
      reason = 'plateau';
      break;
    }

    // h. If improved: update best version, continue
    if (newScore > bestScore) {
      bestContent = newContent;
      bestScore = newScore;
    }

    previousScore = newScore;
    latestResult = newResult;

    // If this is the last iteration, set reason
    if (iter === maxIterations) {
      reason = 'max_iterations';
    }
  }

  // 5. After loop: restore best version
  fs.writeFileSync(commandPath, bestContent, 'utf8');

  // 6. Return summary
  return {
    original: originalContent,
    best: bestContent,
    originalScore,
    bestScore,
    iterations,
    reason,
    diff: generateDiff(originalContent, bestContent),
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * Parse CLI arguments.
 *
 * @param {string[]} argv — process.argv.slice(2)
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
    _rewriteCommand: async (_prompt) => {
      // In a real scenario this would call Claude; for now placeholder
      throw new Error('Real LLM rewriter not yet implemented. Use --dry-run or inject _rewriteCommand.');
    },
  })
    .then((result) => {
      console.log('\n=== Improvement Summary ===');
      console.log(`Original score: ${result.originalScore.toFixed(2)}`);
      console.log(`Best score:     ${result.bestScore.toFixed(2)}`);
      console.log(`Iterations:     ${result.iterations}`);
      console.log(`Reason:         ${result.reason}`);

      if (result.diff) {
        console.log('\n=== Diff (original → best) ===');
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
  generateDiff,
  runImprovementLoop,
};
