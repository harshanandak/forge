'use strict';

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const recap = require('../../lib/commands/recap');

function makeProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-recap-cmd-'));
}

// The kernel `show` envelope returns the issue summary directly as `data`. Injected
// through the handler's opts seam so these tests never open a kernel database.
const opts = {
  runIssueOperation: async (operation, operationArgs) => (
    operation === 'show' && operationArgs[0] === 'forge-recap.1'
      ? {
        ok: true,
        command: 'show',
        data: {
          id: 'forge-recap.1',
          title: 'Issue-scoped recap',
          status: 'open',
          description: 'Summarize a single issue.',
        },
      }
      : { ok: false }
  ),
};

describe('forge recap command', () => {
  test('exports the issue-scoped recap command', () => {
    expect(recap.name).toBe('recap');
    expect(typeof recap.description).toBe('string');
    expect(typeof recap.handler).toBe('function');
    expect(recap.usage).toContain('<issue>');
    expect(recap.usage).toContain('--budget');
  });

  test('source documents the forge recap <issue> contract', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'lib', 'commands', 'recap.js'),
      'utf8'
    );
    expect(source).toContain('forge recap <issue>');
  });

  test('forge recap <issue> --json returns an issue-scoped bounded recap', async () => {
    const root = makeProject();
    const result = await recap.handler(['forge-recap.1', '--json', '--budget', '220'], {}, root, opts);
    const parsed = JSON.parse(result.output);

    expect(result.success).toBe(true);
    expect(parsed.kind).toBe('issue_recap');
    expect(parsed.issue.id).toBe('forge-recap.1');
    expect(parsed.issue.title).toBe('Issue-scoped recap');
    expect(parsed.scope.issue_id).toBe('forge-recap.1');
  });

  test('forge recap --budget N <issue> does not mistake the budget value for the issue', async () => {
    const root = makeProject();
    const result = await recap.handler(['--budget', '220', 'forge-recap.1', '--json'], {}, root, opts);
    const parsed = JSON.parse(result.output);

    expect(result.success).toBe(true);
    expect(parsed.scope.issue_id).toBe('forge-recap.1');
  });

  test('forge recap <issue> renders human-readable issue-scoped text', async () => {
    const root = makeProject();
    const result = await recap.handler(['forge-recap.1'], {}, root, opts);

    expect(result.success).toBe(true);
    expect(result.output).toContain('Issue Summary');
    expect(result.output).toContain('forge-recap.1');
  });

  test('forge recap without an issue prints usage instead of throwing', async () => {
    const root = makeProject();
    const result = await recap.handler([], {}, root, opts);

    expect(result.success).toBe(false);
    // Usage goes on `error` (not `output`) so the CLI dispatcher prints it
    // once via console.error instead of also appending a bare "Command
    // failed" (see bin/forge.js registry dispatch).
    expect(result.error).toContain('forge recap <issue>');
    expect(result.output).toBeUndefined();
  });
});
