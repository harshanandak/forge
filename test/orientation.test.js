'use strict';

const { describe, test, expect, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildIssueRecap,
  buildOrientation,
} = require('../lib/orientation');
const orient = require('../lib/commands/orient');
const prime = require('../lib/commands/prime');
const recap = require('../lib/commands/recap');

const tmpDirs = [];

function writeFile(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-orient-test-'));
  tmpDirs.push(root);

  writeFile(root, 'package.json', JSON.stringify({
    name: 'orientation-fixture',
    version: '1.2.3',
    repository: { url: 'https://github.com/example/orientation-fixture.git' },
  }, null, 2));

  writeFile(root, 'docs/PROJECT_DESIGN.md', [
    '# Fixture Design',
    '',
    '## Current design snapshot',
    '',
    'Forge is moving toward a native Kernel/control-plane architecture:',
    '',
    '- Authority uses local SQLite first.',
    '- Agent interface exposes forge prime and JSON-first commands.',
    '',
    '## Decision registry',
    '',
    '### PD-1',
    '',
    '```yaml',
    'id: PD-1',
    'topic: fixture.first',
    'status: accepted',
    '```',
    '',
    '**Current decision:** Keep the first decision visible.',
    '',
    '### PD-2',
    '',
    '```yaml',
    'id: PD-2',
    'topic: fixture.second',
    'status: accepted',
    '```',
    '',
    '**Current decision:** Keep the second decision visible.',
    '',
  ].join('\n'));

  const workDir = 'docs/work/2026-06-06-kernel-backlog-memory-roadmap';
  writeFile(root, `${workDir}/plan.md`, [
    '# Plan',
    '',
    'This plan is intentionally long.',
    'A '.repeat(900),
  ].join('\n'));
  writeFile(root, `${workDir}/tasks.md`, [
    '# Tasks',
    '',
    '- [ ] Implement bounded orientation.',
    'B '.repeat(700),
  ].join('\n'));
  writeFile(root, `${workDir}/decisions.md`, [
    '# Decisions',
    '',
    '## D21',
    'Decisions must be preserved before low-priority plan text truncates.',
  ].join('\n'));

  fs.mkdirSync(path.join(root, '.beads'), { recursive: true });
  writeFile(root, '.beads/issues.jsonl', [
    JSON.stringify({
      _type: 'issue',
      id: 'forge-orient.1',
      title: 'Add bounded orientation',
      status: 'open',
      description: 'Issue description for scoped recap.',
      updated_at: '2026-06-11T00:00:00.000Z',
    }),
  ].join('\n') + '\n');
  writeFile(root, '.beads/interactions.jsonl', '');

  return root;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

describe('bounded orientation assembly', () => {
  test('applies an explicit token budget with deterministic truncation', () => {
    const root = makeProject();
    const result = buildOrientation(root, { budgetTokens: 140 });

    expect(result.token_budget.requested).toBe(140);
    expect(result.token_budget.used).toBeLessThanOrEqual(140);
    expect(result.token_budget.truncated).toBe(true);

    const decisions = result.sections.find(section => section.id === 'active_work_decisions');
    const plan = result.sections.find(section => section.id === 'active_work_plan');
    expect(decisions.truncated).toBe(false);
    expect(decisions.content).toContain('D21');
    expect(plan.truncated).toBe(true);
  });

  test('includes next commands and source list for agents', () => {
    const root = makeProject();
    const result = buildOrientation(root, { budgetTokens: 500 });

    expect(result.next_commands).toContain('forge status --json');
    expect(result.next_commands).toContain('forge issue ready --json');
    expect(result.sources.some(source => source.path === 'docs/PROJECT_DESIGN.md')).toBe(true);
    expect(result.sources.some(source => source.path.endsWith('/plan.md'))).toBe(true);
  });
});

describe('orient and prime commands', () => {
  test('forge orient --json returns bounded orientation JSON', async () => {
    const root = makeProject();
    const result = await orient.handler(['--json', '--budget', '180'], {}, root);
    const parsed = JSON.parse(result.output);

    expect(parsed.kind).toBe('orientation');
    expect(parsed.token_budget.requested).toBe(180);
    expect(parsed.next_commands).toContain('forge recap <issue> --json');
  });

  test('forge prime --json wraps bounded orientation for session entry', async () => {
    const root = makeProject();
    const result = await prime.handler(['--json'], {}, root);
    const parsed = JSON.parse(result.output);

    expect(parsed.kind).toBe('prime');
    expect(parsed.orientation.kind).toBe('orientation');
    expect(parsed.next_commands).toContain('forge orient --json');
  });
});

describe('issue-scoped recap command', () => {
  test('forge recap <issue> --json returns issue-scoped bounded recap', async () => {
    const root = makeProject();
    const result = await recap.handler(['forge-orient.1', '--json', '--budget', '220'], {}, root);
    const parsed = JSON.parse(result.output);

    expect(parsed.kind).toBe('issue_recap');
    expect(parsed.issue.id).toBe('forge-orient.1');
    expect(parsed.token_budget.requested).toBe(220);
    expect(parsed.next_commands).toContain('forge show forge-orient.1 --json');
  });

  test('forge recap without an issue prints usage and fails', async () => {
    const root = makeProject();
    const result = await recap.handler([], {}, root);

    expect(result.success).toBe(false);
    // Usage goes on `error` (not `output`) so the CLI dispatcher prints it
    // once via console.error instead of also appending a bare "Command
    // failed" (see bin/forge.js registry dispatch).
    expect(result.error).toContain('forge recap <issue>');
    expect(result.output).toBeUndefined();
  });
});

describe('issue recap assembly', () => {
  test('uses the same source-backed next command contract as orientation', () => {
    const root = makeProject();
    const result = buildIssueRecap(root, 'forge-orient.1', { budgetTokens: 260 });

    expect(result.sources.some(source => source.path === '.beads/issues.jsonl')).toBe(true);
    expect(result.next_commands).toContain('forge orient --json');
    expect(result.next_commands).toContain('forge comment forge-orient.1 "<handoff note>"');
  });
});
