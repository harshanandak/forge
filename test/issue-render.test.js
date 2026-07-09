'use strict';

// Human-first rendering for the forge issue read surface (ready / list / show).
// Kernel issue a9bbd065: the default output of these reads is a compact text
// table / detail view; the forge.issue.v1 JSON contract stays available behind
// --json (or FORGE_JSON=1). These tests pin the renderer itself.

const { describe, test, expect } = require('bun:test');

const {
  shortId,
  issueHandle,
  renderIssueList,
  renderIssueShow,
  renderIssueMutation,
  renderIssueEnvelope,
} = require('../lib/issue-render');

const UUID_A = 'a9bbd065-cbbc-43a4-879d-ae49ab265992';
const UUID_B = 'd71a824b-1111-4222-8333-444455556666';

function envelope(command, data, extra = {}) {
  return {
    ok: true,
    schema_version: 'forge.issue.v1',
    command,
    data,
    next_commands: [],
    ...extra,
  };
}

describe('shortId', () => {
  test('truncates a UUID to its 8-char prefix', () => {
    expect(shortId(UUID_A)).toBe('a9bbd065');
  });

  test('leaves non-UUID ids untouched', () => {
    expect(shortId('forge-2agy.2')).toBe('forge-2agy.2');
  });

  test('tolerates non-string ids', () => {
    expect(shortId(null)).toBe('');
    expect(shortId(undefined)).toBe('');
  });
});

describe('renderIssueList', () => {
  const issues = [
    { id: UUID_A, title: 'Human-first output', type: 'task', status: 'open', priority: 'P1' },
    { id: 'forge-2agy.2', title: 'Kernel schema', type: 'feature', status: 'open', priority: 'P0' },
  ];

  test('renders one aligned row per issue with a header', () => {
    const out = renderIssueList(envelope('issue.ready', { issues, count: 2 }));
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^ID\s+TYPE\s+STATUS\s+PRIORITY\s+TITLE$/);
    expect(out).toContain('a9bbd065');
    expect(out).not.toContain(UUID_A); // list shows the 8-char prefix, not the full UUID
    expect(out).toContain('forge-2agy.2'); // non-UUID ids stay full
    expect(out).toContain('Human-first output');
    expect(out).toContain('P0');
  });

  test('columns align across mixed id widths', () => {
    const out = renderIssueList(envelope('issue.list', { issues, count: 2 }));
    const rows = out.split('\n').slice(1, 3);
    const titleCol0 = rows[0].indexOf('Human-first output');
    const titleCol1 = rows[1].indexOf('Kernel schema');
    expect(titleCol0).toBeGreaterThan(0);
    expect(titleCol0).toBe(titleCol1);
  });

  test('renders a count footer', () => {
    const out = renderIssueList(envelope('issue.ready', { issues, count: 2 }));
    expect(out).toContain('2 issues');
  });

  test('renders the empty message when there are no issues', () => {
    const out = renderIssueList(envelope('issue.ready', { issues: [], count: 0 }), {
      emptyMessage: 'No ready issues.',
    });
    expect(out).toBe('No ready issues.');
  });

  test('never emits raw contract JSON', () => {
    const out = renderIssueList(envelope('issue.ready', { issues, count: 2 }));
    expect(out).not.toContain('"schema_version"');
    expect(out).not.toContain('next_commands');
  });
});

describe('renderIssueShow', () => {
  const data = {
    id: UUID_A,
    title: 'Human-first output for forge ready',
    body: 'Default output becomes text; JSON stays behind --json.',
    type: 'task',
    status: 'open',
    priority: 'P1',
    rank: 3,
    blocked: true,
    claimed_by: 'agent-x',
    labels: ['0.1.0', 'cli'],
    dependencies: [UUID_B],
    dependents: [],
    blocked_by: [UUID_B],
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-06T00:00:00.000Z',
    acceptance_criteria: 'ready/list/show default to text.',
    assignee: null,
    closed_at: null,
    close_reason: null,
    comments: [
      { id: 'c1', body: 'PR opened', actor: 'agent-x', created_at: '2026-07-06T01:00:00.000Z' },
    ],
  };

  test('prints the FULL id (the accessible full-UUID surface)', () => {
    const out = renderIssueShow(envelope('issue.show', data));
    expect(out).toContain(UUID_A);
  });

  test('prints title, core fields, labels, and blocked marker', () => {
    const out = renderIssueShow(envelope('issue.show', data));
    expect(out).toContain('Human-first output for forge ready');
    expect(out).toContain('task');
    expect(out).toContain('open');
    expect(out).toContain('P1');
    expect(out).toContain('blocked');
    expect(out).toContain('0.1.0, cli');
    expect(out).toContain('agent-x');
  });

  test('renders dependency edges as short ids', () => {
    const out = renderIssueShow(envelope('issue.show', data));
    expect(out).toContain('d71a824b');
    expect(out).not.toContain(UUID_B);
  });

  test('renders the body and acceptance criteria', () => {
    const out = renderIssueShow(envelope('issue.show', data));
    expect(out).toContain('Default output becomes text');
    expect(out).toContain('ready/list/show default to text.');
  });

  test('renders comments with actor and timestamp', () => {
    const out = renderIssueShow(envelope('issue.show', data));
    expect(out).toContain('Comments (1)');
    expect(out).toContain('PR opened');
    expect(out).toContain('2026-07-06T01:00:00.000Z');
  });

  test('omits empty optional sections', () => {
    const bare = { ...data, blocked: false, claimed_by: null, labels: [], blocked_by: [], dependencies: [], comments: [], acceptance_criteria: null };
    const out = renderIssueShow(envelope('issue.show', bare));
    expect(out).not.toContain('Labels:');
    expect(out).not.toContain('Blocked by:');
    expect(out).not.toContain('Comments');
    expect(out).not.toContain('Acceptance criteria');
  });
});

describe('verification surfacing (gate.issue_verify)', () => {
  test('a verified:false envelope surfaces a warning with each mismatch', () => {
    const out = renderIssueEnvelope('show', envelope('issue.show', {
      id: UUID_A, title: 'T', type: 'task', status: 'open', priority: 'P1',
    }, { verified: false, mismatches: ['title: expected "A", read back "B"'] }));
    expect(out).toContain('WARNING');
    expect(out).toContain('title: expected "A", read back "B"');
  });

  test('a verified:null envelope surfaces an unconfirmed warning', () => {
    const out = renderIssueEnvelope('list', envelope('issue.list', { issues: [], count: 0 }, { verified: null }));
    expect(out).toContain('WARNING');
    expect(out).toContain('could not confirm');
  });

  test('a verified:true envelope stays clean', () => {
    const out = renderIssueEnvelope('list', envelope('issue.list', { issues: [], count: 0 }, { verified: true, mismatches: [] }));
    expect(out).not.toContain('WARNING');
  });
});

describe('renderIssueEnvelope dispatch', () => {
  test('ready and list render tables with subcommand-specific empty messages', () => {
    expect(renderIssueEnvelope('ready', envelope('issue.ready', { issues: [], count: 0 }))).toBe('No ready issues.');
    expect(renderIssueEnvelope('list', envelope('issue.list', { issues: [], count: 0 }))).toBe('No issues found.');
  });

  test('show renders the detail view', () => {
    const out = renderIssueEnvelope('show', envelope('issue.show', {
      id: UUID_A, title: 'T', type: 'task', status: 'open', priority: 'P1',
    }));
    expect(out).toContain(UUID_A);
    expect(out).toContain('T');
  });
});

describe('renderIssueMutation (842a8be7: human confirmation for writes, TTY-gated in _issue.js)', () => {
  test('create renders a confirmation with the readable handle + status', () => {
    const out = renderIssueMutation('create', envelope('issue.create', {
      id: UUID_A, title: 'Wire the thing', status: 'open',
    }));
    expect(out).toContain('✓ Created');
    // Readable handle: title-slug + 8-char short id (kernel 1db53c60).
    expect(out).toContain('wire-the-thing-a9bbd065');
    expect(out).toContain('[open]');
    expect(out).not.toContain('schema_version'); // no raw contract JSON
  });

  test('claim / close use their own past-tense verb', () => {
    expect(renderIssueMutation('claim', envelope('issue.claim', { id: UUID_A })))
      .toContain('✓ Claimed');
    expect(renderIssueMutation('close', envelope('issue.close', { id: UUID_A, status: 'done' })))
      .toContain('✓ Closed');
  });

  test('renderIssueEnvelope routes mutations to the mutation renderer', () => {
    const out = renderIssueEnvelope('claim', envelope('issue.claim', { id: UUID_A }));
    expect(out).toContain('✓ Claimed');
    // No title in the envelope → handle degrades to the 8-char short id.
    expect(out).toContain('a9bbd065');
  });

  test('surfaces check-after-write verification lines when present', () => {
    const out = renderIssueMutation('close', envelope('issue.close', { id: UUID_A }, {
      verified: false,
      mismatches: [{ field: 'status', expected: 'done', got: null }],
    }));
    expect(out).toContain('✓ Closed');
    expect(out.toLowerCase()).toContain('verif'); // verification note rendered, not dropped
  });
});

describe('issueHandle (1db53c60: title-slug + short-id, e.g. add-oauth-login-56a3a16d)', () => {
  test('builds <slug>-<8char> from title + id', () => {
    expect(issueHandle({ id: UUID_A, title: 'Add OAuth login' })).toBe('add-oauth-login-a9bbd065');
  });

  test('caps the slug to the first four title words', () => {
    expect(issueHandle({ id: UUID_A, title: 'One two three four five six' }))
      .toBe('one-two-three-four-a9bbd065');
  });

  test('strips punctuation and collapses separators', () => {
    expect(issueHandle({ id: UUID_A, title: '  Fix: the (weird)  thing!! ' }))
      .toBe('fix-the-weird-thing-a9bbd065');
  });

  test('degrades to the bare short id when there is no usable title', () => {
    expect(issueHandle({ id: UUID_A })).toBe('a9bbd065');
    expect(issueHandle({ id: UUID_A, title: '!!! ***' })).toBe('a9bbd065');
  });

  test('renderIssueList shows the handle in the ID column', () => {
    const out = renderIssueList(envelope('issue.list', {
      issues: [{ id: UUID_A, title: 'Add OAuth login', type: 'feature', status: 'open', priority: 'P2' }],
    }));
    expect(out).toContain('add-oauth-login-a9bbd065');
  });
});
