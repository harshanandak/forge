const { describe, test, expect } = require('bun:test');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

/**
 * Helper: run beads-context.sh validate with a bd shim.
 */
function runValidate(issueId, shimBehavior = {}) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const shimDir = path.join(ROOT, `.bd-validate-shim-${suffix}`);
  const shimPath = path.join(shimDir, 'bd');

  fs.mkdirSync(shimDir, { recursive: true });

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

  fs.writeFileSync(path.join(shimDir, 'comments.txt'), commentsOutput.replace(/\\n/g, '\n'));
  fs.writeFileSync(path.join(shimDir, 'show.json'), showJson);

  fs.writeFileSync(
    shimPath,
    `#!/usr/bin/env bash
if [ "$1" = "show" ] && [ "$3" = "--json" ]; then
  if [ "${showExitCode}" -ne 0 ]; then
    echo "Error resolving issue: $2" >&2
    exit ${showExitCode}
  fi
  cat ${shQuote(`./${path.basename(shimDir)}/show.json`)}
  exit 0
fi
if [ "$1" = "comments" ] && [ "$2" = "list" ]; then
  cat ${shQuote(`./${path.basename(shimDir)}/comments.txt`)}
  exit 0
fi
echo "bd shim: $*"
exit 0
`,
    { mode: 0o755 }
  );

  const bashScript = `
export PATH=${shQuote(`./${path.basename(shimDir)}`)}:"$PATH"
bash scripts/beads-context.sh validate ${shQuote(issueId)}
`;

  const result = spawnSync('bash', ['-lc', bashScript], {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
    timeout: 20000,
  });

  try {
    fs.rmSync(shimDir, { recursive: true, force: true });
  } catch (_e) {
    // ignore cleanup failures in tests
  }

  return {
    output: (result.stdout || '') + (result.stderr || ''),
    exitCode: result.status,
  };
}

describe('beads-context.sh validate', () => {
  test('nonexistent issue exits non-zero or prints error', () => {
    const result = runValidate('nonexistent-999', {
      showExitCode: 1,
      showJson: '',
    });
    const hasError = result.exitCode !== 0 || result.output.toLowerCase().includes('error');
    expect(hasError).toBe(true);
  }, 15000);

  test('warns when description is missing', () => {
    const result = runValidate('test-issue-010', {
      description: '',
      comments: 'Stage: plan complete -> ready for dev\nSummary: Design done',
      design: '3 tasks | docs/plans/test.md',
    });
    expect(result.exitCode).toBe(0);
    expect(result.output.toLowerCase()).toContain('description');
  }, 15000);

  test('warns when no stage transition exists', () => {
    const result = runValidate('test-issue-011', {
      description: 'A real description',
      comments: '',
      design: '3 tasks | docs/plans/test.md',
    });
    expect(result.exitCode).toBe(0);
    expect(result.output.toLowerCase()).toContain('stage transition');
  }, 15000);

  test('warns when most recent transition has no summary', () => {
    const result = runValidate('test-issue-012', {
      description: 'A real description',
      comments: 'Stage: plan complete -> ready for dev',
      design: '3 tasks | docs/plans/test.md',
    });
    expect(result.exitCode).toBe(0);
    expect(result.output.toLowerCase()).toContain('summary');
  }, 15000);

  test('warns when design metadata is missing for post-plan stage', () => {
    const result = runValidate('test-issue-013', {
      description: 'A real description',
      comments: 'Stage: dev complete -> ready for validate\nSummary: All tasks done',
      design: '',
    });
    expect(result.exitCode).toBe(0);
    expect(result.output.toLowerCase()).toContain('design');
  }, 15000);

  test('outputs success when all fields are present', () => {
    const result = runValidate('test-issue-014', {
      description: 'A real description',
      comments: 'Stage: dev complete -> ready for validate\nSummary: All 5 tasks done',
      design: '5 tasks | docs/plans/test-tasks.md',
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('All context fields present');
  }, 15000);
});
