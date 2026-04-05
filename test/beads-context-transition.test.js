const { describe, test, expect } = require('bun:test');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function splitShellArgs(input) {
  const matches = input.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return matches.map((token) => token.replace(/^['"]|['"]$/g, ''));
}

function transitionTest(name, callback) {
  return test(name, { timeout: 30000 }, callback);
}

/**
 * Helper: run beads-context.sh stage-transition with given args.
 * Uses a bd shim that captures the comment text passed to `bd comments add`.
 * This avoids needing a real Beads installation for unit tests.
 */
function runTransition(args, _env = {}) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const shimDir = path.join(ROOT, `.bd-shim-${suffix}`);
  const captureFile = path.join(shimDir, 'capture.txt');
  const shimPath = path.join(shimDir, 'bd');

  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(
    shimPath,
    `#!/usr/bin/env bash
if [ "$1" = "comments" ] && [ "$2" = "add" ]; then
  printf '%s' "$4" > ${shQuote(`./${path.basename(shimDir)}/capture.txt`)}
  echo "Comment added"
  exit 0
fi
if [ "$1" = "update" ]; then
  echo "Updated"
  exit 0
fi
echo "bd shim: unknown command $*"
exit 0
`,
    { mode: 0o755 }
  );

  const bashScript = `
export PATH=${shQuote(`./${path.basename(shimDir)}`)}:"$PATH"
exec ./scripts/beads-context.sh stage-transition ${splitShellArgs(args).map(shQuote).join(' ')}
`;

  const result = spawnSync('bash', ['-c', bashScript], {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
    timeout: 20000,
  });

  let comment = '';
  try {
    comment = fs.readFileSync(captureFile, 'utf8');
  } catch (_e) {
    // File may not exist if bd wasn't called
  }

  try { fs.unlinkSync(captureFile); } catch (_e) { /* ignore */ }
  try { fs.unlinkSync(shimPath); } catch (_e) { /* ignore */ }
  try { fs.rmdirSync(shimDir); } catch (_e) { /* ignore */ }

  return {
    output: result.stdout || '',
    stderr: result.stderr || '',
    comment,
    exitCode: result.status,
  };
}

describe('beads-context.sh stage-transition', () => {
  transitionTest('backward compat: without flags produces simple transition comment', () => {
    const result = runTransition('test-issue-001 plan dev');
    expect(result.comment).toContain('Stage: plan complete');
    expect(result.comment).toContain('ready for dev');
    expect(result.comment).not.toContain('Summary:');
    expect(result.comment).not.toContain('Decisions:');
    expect(result.comment).not.toContain('Artifacts:');
    expect(result.comment).not.toContain('Next:');
  });

  transitionTest('with all four flags produces structured comment', () => {
    const result = runTransition(
      'test-issue-002 dev validate --summary "All 5 tasks done" --decisions "Used approach A" --artifacts "lib/foo.js test/foo.test.js" --next "Run type check and lint"'
    );
    expect(result.comment).toContain('Stage: dev complete');
    expect(result.comment).toContain('ready for validate');
    expect(result.comment).toContain('Summary: All 5 tasks done');
    expect(result.comment).toContain('Decisions: Used approach A');
    expect(result.comment).toContain('Artifacts: lib/foo.js test/foo.test.js');
    expect(result.comment).toContain('Next: Run type check and lint');
  });

  transitionTest('with partial flags only includes provided fields', () => {
    const result = runTransition(
      'test-issue-003 validate ship --summary "All checks pass" --artifacts "scripts/validate.sh"'
    );
    expect(result.comment).toContain('Stage: validate complete');
    expect(result.comment).toContain('Summary: All checks pass');
    expect(result.comment).toContain('Artifacts: scripts/validate.sh');
    expect(result.comment).not.toContain('Decisions:');
    expect(result.comment).not.toContain('Next:');
  });

  transitionTest('output message still reports transition', () => {
    const result = runTransition('test-issue-004 ship review --summary "PR created"');
    expect(result.output).toContain('Stage transition recorded on test-issue-004');
    expect(result.output).toContain('ship');
    expect(result.output).toContain('review');
  });

  transitionTest('with workflow-state includes machine-readable state payload', () => {
    const workflowState = JSON.stringify({
      currentStage: 'dev',
      completedStages: ['plan'],
      skippedStages: [],
      workflowDecisions: {
        classification: 'standard',
        reason: 'fixture',
        userOverride: false,
        overrides: [],
      },
      parallelTracks: [],
    });
    const result = runTransition(
      `test-issue-005 plan dev --summary "Plan done" --workflow-state '${workflowState}'`
    );
    expect(result.comment).toContain('WorkflowState:');
    expect(result.comment).toContain('"currentStage":"dev"');
  });
});
