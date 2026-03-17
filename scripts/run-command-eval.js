/**
 * End-to-end eval pipeline — wire it all together.
 *
 * Load eval set → create worktree → for each query: run setup → execute
 * command → parse transcript → grade → run teardown → reset worktree →
 * save results → destroy worktree.
 *
 * Usage:
 *   bun scripts/run-command-eval.js <eval-set-path> [--timeout <ms>] [--threshold <score>]
 */

const { execFileSync } = require('child_process');
const { loadEvalSet } = require('./lib/eval-schema');
const { parseTranscript } = require('./lib/transcript-parser');
const {
  createEvalWorktree,
  destroyEvalWorktree,
  resetWorktree,
  executeCommand,
} = require('./lib/eval-runner');
const { gradeTranscript } = require('./lib/grading');
const { saveEvalResult } = require('./lib/eval-storage');

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

/**
 * Parse CLI arguments.
 *
 * @param {string[]} argv — process.argv.slice(2)
 * @returns {{ evalSetPath: string, timeout: number, threshold: number }}
 */
function parseArgs(argv) {
  let evalSetPath = null;
  let timeout = 120000;
  let threshold = 0.7;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--timeout' && i + 1 < argv.length) {
      timeout = Number(argv[i + 1]);
      i++; // skip next
    } else if (argv[i] === '--threshold' && i + 1 < argv.length) {
      threshold = Number(argv[i + 1]);
      i++; // skip next
    } else if (!argv[i].startsWith('--')) {
      evalSetPath = argv[i];
    }
  }

  if (!evalSetPath) {
    throw new Error('Usage: run-command-eval <eval-set-path> [--timeout <ms>] [--threshold <score>]');
  }

  return { evalSetPath, timeout, threshold };
}

// ---------------------------------------------------------------------------
// runShellCommand — run a setup/teardown shell command in a worktree
// ---------------------------------------------------------------------------

/**
 * Run a shell command (setup or teardown) in the worktree.
 * Uses execFileSync with bash -c to avoid direct shell injection.
 *
 * @param {string} command — the shell command string
 * @param {string} worktreePath — cwd for the command
 */
function runShellCommand(command, worktreePath) {
  execFileSync('bash', ['-c', command], {
    cwd: worktreePath,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// ---------------------------------------------------------------------------
// runEvalPipeline
// ---------------------------------------------------------------------------

/**
 * Main orchestrator — run the full eval pipeline.
 *
 * @param {string} evalSetPath — path to the .eval.json file
 * @param {object} [options]
 * @param {number} [options.timeout=120000] — per-query timeout in ms
 * @param {number} [options.threshold=0.7] — pass/fail score cutoff
 * @param {Function} [options._invokeGrader] — injectable grader for testing
 * @param {string} [options._basePath] — eval-logs base path for testing
 * @param {boolean} [options._skipWorktree=false] — skip worktree creation for unit tests
 * @param {Function} [options._executeOverride] — injectable command executor for testing
 * @returns {Promise<{ command: string, results: Array, overall_score: number, passed: boolean, duration_ms: number }>}
 */
async function runEvalPipeline(evalSetPath, options = {}) {
  const timeout = options.timeout || 120000;
  const threshold = options.threshold != null ? options.threshold : 0.7;
  const skipWorktree = options._skipWorktree || false;
  const execOverride = options._executeOverride || null;
  const invokeGrader = options._invokeGrader || null;
  const basePath = options._basePath || undefined;

  const startTime = Date.now();

  // 1. Load eval set
  const evalSet = loadEvalSet(evalSetPath);
  const { command, queries } = evalSet;

  // 2. Create eval worktree (unless skipped for testing)
  let worktreePath = null;
  if (!skipWorktree) {
    const wt = await createEvalWorktree();
    worktreePath = wt.path;
  }

  const queryResults = [];

  try {
    // 3. For each query in eval set
    for (const query of queries) {
      // a. Run setup command if present
      if (query.setup && worktreePath) {
        try {
          runShellCommand(query.setup, worktreePath);
        } catch (_err) {
          // Setup failure is non-fatal — continue with the query
        }
      }

      // b. Execute the command
      let execResult;
      if (execOverride) {
        execResult = await execOverride(command, query.prompt, worktreePath, timeout);
      } else {
        execResult = await executeCommand(command, query.prompt, worktreePath, timeout);
      }

      // c. Parse transcript
      const transcript = parseTranscript(execResult.stdout);

      // d. Grade with gradeTranscript
      let gradeResult;
      const gradeOpts = { timeout };
      if (invokeGrader) {
        gradeResult = await invokeGrader(transcript, query.assertions, gradeOpts);
      } else {
        gradeResult = await gradeTranscript(transcript, query.assertions, gradeOpts);
      }

      // e. Run teardown command if present
      if (query.teardown && worktreePath) {
        try {
          runShellCommand(query.teardown, worktreePath);
        } catch (_err) {
          // Teardown failure is non-fatal
        }
      }

      // f. Reset worktree
      if (worktreePath) {
        await resetWorktree(worktreePath);
      }

      // g. Collect results
      queryResults.push({
        name: query.name,
        prompt: query.prompt,
        score: gradeResult.score,
        assertions: gradeResult.assertions,
        exitCode: execResult.exitCode,
        timedOut: execResult.timedOut,
      });
    }

    // 4. Compute overall score (average of query scores)
    const totalScore = queryResults.reduce((sum, qr) => sum + qr.score, 0);
    const overallScore = queryResults.length > 0 ? totalScore / queryResults.length : 0;

    // 5. Build the final result
    const endTime = Date.now();
    const result = {
      command,
      results: queryResults,
      overall_score: overallScore,
      passed: overallScore >= threshold,
      duration_ms: endTime - startTime,
      timestamp: new Date().toISOString(),
    };

    // 6. Save results
    const savedPath = saveEvalResult(result, basePath);
    result.savedTo = savedPath;

    return result;
  } finally {
    // 7. Destroy worktree (in finally block)
    if (worktreePath) {
      try {
        await destroyEvalWorktree(worktreePath);
      } catch (_err) {
        // Best-effort cleanup
      }
    }
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));

  runEvalPipeline(args.evalSetPath, args)
    .then((result) => {
      const passedCount = result.results.filter((r) => r.score >= 0.5).length;
      const totalCount = result.results.length;

      console.log(`Command: ${result.command}`);
      console.log(`Queries: ${passedCount}/${totalCount} passed`);
      console.log(`Overall score: ${result.overall_score.toFixed(2)}`);
      console.log(
        `Result: ${result.passed ? 'PASS' : 'FAIL'} (threshold: ${args.threshold})`
      );
      if (result.savedTo) {
        console.log(`Saved to: ${result.savedTo}`);
      }

      process.exit(result.passed ? 0 : 1);
    })
    .catch((err) => {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { runEvalPipeline, parseArgs };
