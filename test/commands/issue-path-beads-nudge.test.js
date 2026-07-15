'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const { runIssueSubcommand } = require('../../lib/commands/_issue');

// Upgrade-safety footgun (kernel issue a5399f3d): the 0.0.10 -> current default
// flipped Beads -> Kernel, but beads -> kernel migration fires ONLY from
// setup/init, never lazily on the issue path. So a user who runs `bun update`
// then `forge list`/`forge ready` reads an EMPTY kernel and their 0.0.10 issues
// APPEAR GONE (data is safe in .beads/*.jsonl, just invisible) with no nudge.
// These tests pin the guided nudge: kernel default + empty read + .beads/*.jsonl
// present -> a one-time stderr hint pointing at `forge migrate --from beads`.

function makeRoot({ withBeads } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'forge-beads-nudge-'));
  if (withBeads) {
    mkdirSync(path.join(root, '.beads'), { recursive: true });
    writeFileSync(path.join(root, '.beads', 'issues.jsonl'), '{"id":"bd-1","title":"legacy"}\n');
  }
  return root;
}

// Kernel list/ready envelope: { ok, data: { issues: [...], count } }.
function kernelListRunner(issues) {
  return async () => ({
    ok: true,
    schema_version: 'forge.issue.v1',
    command: 'issue.list',
    data: { issues, count: issues.length },
    next_commands: [],
  });
}

let errors;
const originalError = console.error;
beforeEach(() => {
  errors = [];
  console.error = (...args) => { errors.push(args.join(' ')); };
});
afterEach(() => {
  console.error = originalError;
});

function joined() {
  return errors.join('\n');
}

describe('issue-path unmigrated-beads nudge', () => {
  test('kernel default + empty list + .beads/*.jsonl present -> guided nudge', async () => {
    const root = makeRoot({ withBeads: true });
    await runIssueSubcommand('list', [], root, {
      env: {},
      runIssueOperation: kernelListRunner([]),
    });
    const out = joined();
    expect(out).toContain('forge migrate --from beads');
    expect(out.toLowerCase()).toContain('beads');
  });

  test('kernel default + empty ready + .beads present -> nudge (ready is also a returning-user read)', async () => {
    const root = makeRoot({ withBeads: true });
    await runIssueSubcommand('ready', [], root, {
      env: {},
      runIssueOperation: kernelListRunner([]),
    });
    expect(joined()).toContain('forge migrate --from beads');
  });

  test('NON-empty kernel list suppresses the nudge (issues already visible)', async () => {
    const root = makeRoot({ withBeads: true });
    await runIssueSubcommand('list', [], root, {
      env: {},
      runIssueOperation: kernelListRunner([{ id: 'k-1', title: 'live' }]),
    });
    expect(joined()).not.toContain('forge migrate');
  });

  test('no .beads/*.jsonl -> no nudge even on an empty kernel', async () => {
    const root = makeRoot({ withBeads: false });
    await runIssueSubcommand('list', [], root, {
      env: {},
      runIssueOperation: kernelListRunner([]),
    });
    expect(joined()).not.toContain('forge migrate');
  });

  test('explicit beads backend suppresses the nudge (user is on Beads on purpose)', async () => {
    const root = makeRoot({ withBeads: true });
    await runIssueSubcommand('list', [], root, {
      env: { FORGE_ISSUE_BACKEND: 'beads' },
      issueBackend: 'beads',
      runIssueOperation: kernelListRunner([]),
    });
    expect(joined()).not.toContain('forge migrate');
  });

  test('nudge fires at most once per project root (no spam across repeated reads)', async () => {
    const root = makeRoot({ withBeads: true });
    const opts = { env: {}, runIssueOperation: kernelListRunner([]) };
    await runIssueSubcommand('list', [], root, opts);
    await runIssueSubcommand('ready', [], root, opts);
    const hits = errors.filter(line => line.includes('forge migrate --from beads')).length;
    expect(hits).toBe(1);
  });
});
