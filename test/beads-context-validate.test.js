const { describe, test, expect } = require('bun:test');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'beads-context.sh');

/**
 * Helper: run beads-context.sh validate with a bd shim.
 *
 * Note: execSync is safe here — all arguments are test-controlled literals,
 * not user input. Shell invocation required to run bash script under test.
 */
function runValidate(issueId, shimBehavior = {}) {
  const tmpDir = os.tmpdir();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const shimDir = path.join(tmpDir, `bd-shim-validate-${suffix}`);
  fs.mkdirSync(shimDir, { recursive: true });
  const shimPath = path.join(shimDir, 'bd');

  const showJson = shimBehavior.showJson ?? JSON.stringify({
    id: issueId,
    title: 'Test issue',
    description: 'description' in shimBehavior ? shimBehavior.description : 'A test feature',
    design: 'design' in shimBehavior ? shimBehavior.design : '5 tasks | docs/plans/test-tasks.md',
    notes: shimBehavior.notes ?? '',
    status: 'in_progress',
  });

  const commentsOutput = shimBehavior.comments || '';
  const showExitCode = shimBehavior.showExitCode || 0;

  // Write comments to a temp file so the shim can cat it (avoids escaping issues)
  const commentsFile = path.join(shimDir, 'comments.txt');
  // Expand \n to real newlines before writing
  fs.writeFileSync(commentsFile, commentsOutput.replace(/\\n/g, '\n'));

  const jsonFile = path.join(shimDir, 'show.json');
  fs.writeFileSync(jsonFile, showJson);

  const shimContent = [
    '#!/usr/bin/env bash',
    'if [ "$1" = "show" ] && [ "$3" = "--json" ]; then',
    `  if [ "${showExitCode}" -ne 0 ]; then`,
    '    echo "Error resolving issue: $2" >&2',
    `    exit ${showExitCode}`,
    '  fi',
    `  cat "${jsonFile.replace(/\\/g, '/')}"`,
    '  exit 0',
    'fi',
    'if [ "$1" = "comments" ] && [ "$2" = "list" ]; then',
    `  cat "${commentsFile.replace(/\\/g, '/')}"`,
    '  exit 0',
    'fi',
    'echo "bd shim: $*"',
    'exit 0',
  ].join('\n');

  fs.writeFileSync(shimPath, shimContent, { mode: 0o755 });

  try {
    execSync(`chmod +x "${shimPath}"`, { stdio: 'ignore' });
  } catch (_e) { /* ignore */ }

  const fullEnv = {
    ...process.env,
    PATH: `${shimDir}${path.delimiter}${process.env.PATH}`,
  };

  try {
    const output = execSync(`bash "${SCRIPT}" validate ${issueId}`, {
      env: fullEnv,
      encoding: 'utf8',
      timeout: 10000,
    });

    try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }

    return { output, exitCode: 0 };
  } catch (err) {
    try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }

    return {
      output: (err.stdout || '') + (err.stderr || ''),
      exitCode: err.status,
    };
  }
}

describe('beads-context.sh validate', () => {
  test('nonexistent issue exits non-zero or prints error', () => {
    const result = runValidate('nonexistent-999', {
      showExitCode: 1,
      showJson: '',
    });
    const hasError = result.exitCode !== 0 || result.output.toLowerCase().includes('error');
    expect(hasError).toBe(true);
  });

  test('warns when description is missing', () => {
    const result = runValidate('test-issue-010', {
      description: '',
      comments: 'Stage: plan complete → ready for dev\nSummary: Design done',
      design: '3 tasks | docs/plans/test.md',
    });
    expect(result.exitCode).toBe(0);
    expect(result.output.toLowerCase()).toContain('description');
  });

  test('warns when no stage transition exists', () => {
    const result = runValidate('test-issue-011', {
      description: 'A real description',
      comments: '',
      design: '3 tasks | docs/plans/test.md',
    });
    expect(result.exitCode).toBe(0);
    expect(result.output.toLowerCase()).toContain('stage transition');
  });

  test('warns when most recent transition has no summary', () => {
    const result = runValidate('test-issue-012', {
      description: 'A real description',
      comments: 'Stage: plan complete → ready for dev',
      design: '3 tasks | docs/plans/test.md',
    });
    expect(result.exitCode).toBe(0);
    expect(result.output.toLowerCase()).toContain('summary');
  });

  test('warns when design metadata is missing for post-plan stage', () => {
    const result = runValidate('test-issue-013', {
      description: 'A real description',
      comments: 'Stage: dev complete → ready for validate\nSummary: All tasks done',
      design: '',
    });
    expect(result.exitCode).toBe(0);
    expect(result.output.toLowerCase()).toContain('design');
  });

  test('outputs success when all fields are present', () => {
    const result = runValidate('test-issue-014', {
      description: 'A real description',
      comments: 'Stage: dev complete → ready for validate\nSummary: All 5 tasks done',
      design: '5 tasks | docs/plans/test-tasks.md',
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('All context fields present');
  });
});
