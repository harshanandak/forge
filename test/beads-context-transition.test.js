const { describe, test, expect } = require('bun:test');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'beads-context.sh');

/**
 * Helper: run beads-context.sh stage-transition with given args.
 * Uses a bd shim that captures the comment text passed to `bd comments add`.
 * This avoids needing a real Beads installation for unit tests.
 *
 * Note: execSync is safe here — all arguments are test-controlled string literals,
 * not user input. Shell invocation is required to run the bash script under test.
 */
function runTransition(args, _env = {}) {
  const tmpDir = os.tmpdir();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const captureFile = path.join(tmpDir, `beads-ctx-test-${suffix}.txt`);

  // Create a bd shim that captures the comment text
  const shimDir = path.join(tmpDir, `bd-shim-${suffix}`);
  fs.mkdirSync(shimDir, { recursive: true });
  const shimPath = path.join(shimDir, 'bd');
  fs.writeFileSync(shimPath, `#!/usr/bin/env bash
# Shim: capture the comment argument
if [ "$1" = "comments" ] && [ "$2" = "add" ]; then
  printf '%s' "$4" > "${captureFile}"
  echo "Comment added"
  exit 0
fi
if [ "$1" = "update" ]; then
  echo "Updated"
  exit 0
fi
echo "bd shim: unknown command $*"
exit 0
`, { mode: 0o755 });

  try {
    execSync(`chmod +x "${shimPath}"`, { stdio: 'ignore' });
  } catch (_e) {
    // chmod may fail on Windows — mode was set above
  }

  const fullEnv = {
    ...process.env,
    PATH: `${shimDir}${path.delimiter}${process.env.PATH}`,
    CAPTURE_FILE: captureFile,
  };

  try {
    const output = execSync(`bash "${SCRIPT}" stage-transition ${args}`, {
      env: fullEnv,
      encoding: 'utf8',
      timeout: 10000,
    });

    let comment = '';
    try {
      comment = fs.readFileSync(captureFile, 'utf8');
    } catch (_e) {
      // File may not exist if bd wasn't called
    }

    // Cleanup
    try { fs.unlinkSync(captureFile); } catch (_e) { /* ignore */ }
    try { fs.unlinkSync(shimPath); } catch (_e) { /* ignore */ }
    try { fs.rmdirSync(shimDir); } catch (_e) { /* ignore */ }

    return { output, comment };
  } catch (err) {
    let comment = '';
    try {
      comment = fs.readFileSync(captureFile, 'utf8');
    } catch (_e) { /* ignore */ }
    try { fs.unlinkSync(captureFile); } catch (_e) { /* ignore */ }
    try { fs.unlinkSync(shimPath); } catch (_e) { /* ignore */ }
    try { fs.rmdirSync(shimDir); } catch (_e) { /* ignore */ }

    return { output: err.stdout || '', stderr: err.stderr || '', comment, exitCode: err.status };
  }
}

describe('beads-context.sh stage-transition', () => {
  test('backward compat: without flags produces simple transition comment', () => {
    const result = runTransition('test-issue-001 plan dev');
    expect(result.comment).toContain('Stage: plan complete');
    expect(result.comment).toContain('ready for dev');
    // Should NOT contain structured fields when no flags given
    expect(result.comment).not.toContain('Summary:');
    expect(result.comment).not.toContain('Decisions:');
    expect(result.comment).not.toContain('Artifacts:');
    expect(result.comment).not.toContain('Next:');
  });

  test('with all four flags produces structured comment', () => {
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

  test('with partial flags only includes provided fields', () => {
    const result = runTransition(
      'test-issue-003 validate ship --summary "All checks pass" --artifacts "scripts/validate.sh"'
    );
    expect(result.comment).toContain('Stage: validate complete');
    expect(result.comment).toContain('Summary: All checks pass');
    expect(result.comment).toContain('Artifacts: scripts/validate.sh');
    // Not provided, should be absent
    expect(result.comment).not.toContain('Decisions:');
    expect(result.comment).not.toContain('Next:');
  });

  test('output message still reports transition', () => {
    const result = runTransition('test-issue-004 ship review --summary "PR created"');
    expect(result.output).toContain('Stage transition recorded on test-issue-004');
    expect(result.output).toContain('ship');
    expect(result.output).toContain('review');
  });
});
