'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MIN_ISSUE_ID_PREFIX_LENGTH,
  MAX_AMBIGUOUS_CANDIDATES,
  OPERATION_ID_POSITIONS,
  resolveIssueId,
  resolveIssueIdArgs,
} = require('../../lib/kernel/issue-id-resolver');
const { ISSUE_COMMAND_EXIT_CODES } = require('../../lib/kernel/issue-command-contract');
const { createLocalBroker } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');
const { runIssueSubcommand } = require('../../lib/commands/_issue');

// Git-style short issue-id support (kernel 9556660b): every kernel issue command
// accepts an unambiguous id prefix (>= 6 hex chars). Resolution happens ONCE at the
// broker boundary (runIssueOperation) so every subcommand — including batch close
// and the gate.issue_verify read-back — consumes the RESOLVED full id.

// Windows-safe teardown: the SQLite WAL unmap can race rmSync and throw
// EBUSY/EPERM — retry briefly (same pattern as test/bin/orientation-front-door).
function rmrf(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch (error) {
      if (attempt === 4 || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) return;
      const until = Date.now() + 100; while (Date.now() < until) { /* brief spin */ }
    }
  }
}

const UUID_A = 'e79a1b2c-0000-4000-8000-000000000001';
const UUID_B = 'deadbeef-1111-4000-8000-000000000002';
const UUID_C = 'deadbeef-2222-4000-8000-000000000003';

function fakeLookup(rows) {
  const calls = [];
  const lookup = async (prefix, limit) => {
    calls.push({ prefix, limit });
    return rows.filter(row => row.id.startsWith(prefix)).slice(0, limit);
  };
  lookup.calls = calls;
  return lookup;
}

describe('issue-id resolver — unit', () => {
  test('exports the contract constants', () => {
    expect(MIN_ISSUE_ID_PREFIX_LENGTH).toBe(6);
    expect(MAX_AMBIGUOUS_CANDIDATES).toBe(5);
    expect(OPERATION_ID_POSITIONS.show).toEqual([0]);
    expect(OPERATION_ID_POSITIONS['dep.add']).toEqual([0, 1]);
  });

  test('exact full UUID passes through without a lookup', async () => {
    const lookup = fakeLookup([{ id: UUID_A, title: 'a' }]);
    const result = await resolveIssueId(UUID_A, lookup);
    expect(result).toEqual({ id: UUID_A });
    expect(lookup.calls.length).toBe(0);
  });

  test('non-hex legacy ids pass through untouched without a lookup', async () => {
    const lookup = fakeLookup([]);
    for (const legacy of ['forge-2a3bc9', 'own-1', 'issue-42', 'bd-abc']) {
      const result = await resolveIssueId(legacy, lookup);
      expect(result).toEqual({ id: legacy });
    }
    expect(lookup.calls.length).toBe(0);
  });

  test('a unique hex prefix resolves to the full id', async () => {
    const lookup = fakeLookup([
      { id: UUID_A, title: 'target' },
      { id: UUID_B, title: 'other' },
    ]);
    const result = await resolveIssueId('e79a1b2c', lookup);
    expect(result).toEqual({ id: UUID_A });
  });

  test('a unique dashed UUID partial resolves too', async () => {
    const lookup = fakeLookup([
      { id: UUID_B, title: 'b' },
      { id: UUID_C, title: 'c' },
    ]);
    const result = await resolveIssueId('deadbeef-1111', lookup);
    expect(result).toEqual({ id: UUID_B });
  });

  test('an ambiguous prefix errors listing the candidate ids and titles', async () => {
    const lookup = fakeLookup([
      { id: UUID_B, title: 'first match' },
      { id: UUID_C, title: 'second match' },
    ]);
    const result = await resolveIssueId('deadbeef', lookup);
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe('FORGE_ISSUE_ID_AMBIGUOUS');
    expect(result.error.exitCode).toBe(ISSUE_COMMAND_EXIT_CODES.validation);
    expect(result.error.message).toContain(UUID_B);
    expect(result.error.message).toContain(UUID_C);
    expect(result.error.message).toContain('first match');
    expect(result.error.details.candidates.length).toBe(2);
  });

  test('an ambiguous prefix lists at most MAX_AMBIGUOUS_CANDIDATES candidates', async () => {
    const rows = Array.from({ length: 9 }, (_, index) => ({
      id: `deadbeef-000${index}-4000-8000-00000000000${index}`,
      title: `candidate ${index}`,
    }));
    const result = await resolveIssueId('deadbeef', fakeLookup(rows));
    expect(result.error.code).toBe('FORGE_ISSUE_ID_AMBIGUOUS');
    expect(result.error.details.candidates.length).toBe(MAX_AMBIGUOUS_CANDIDATES);
  });

  test('a too-short hex prefix errors with guidance', async () => {
    const lookup = fakeLookup([{ id: UUID_B, title: 'b' }]);
    const result = await resolveIssueId('dead', lookup);
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe('FORGE_ISSUE_ID_PREFIX_TOO_SHORT');
    expect(result.error.exitCode).toBe(ISSUE_COMMAND_EXIT_CODES.validation);
    expect(result.error.message).toContain('at least 6');
  });

  test('a short hex token that IS a stored full id passes through (exact wins)', async () => {
    const lookup = fakeLookup([
      { id: 'abc12', title: 'short custom id' },
      { id: 'abc12999-0000-4000-8000-000000000009', title: 'other' },
    ]);
    const result = await resolveIssueId('abc12', lookup);
    expect(result).toEqual({ id: 'abc12' });
  });

  test('a hex prefix with zero matches passes through (downstream not-found unchanged)', async () => {
    const result = await resolveIssueId('abcdef123456', fakeLookup([]));
    expect(result).toEqual({ id: 'abcdef123456' });
  });

  test('resolveIssueIdArgs resolves only the id positions for the operation', async () => {
    const lookup = fakeLookup([{ id: UUID_A, title: 'a' }]);
    const comment = await resolveIssueIdArgs('comment', ['e79a1b2c', 'body', 'e79a1b'], lookup);
    expect(comment.args).toEqual([UUID_A, 'body', 'e79a1b']);

    const close = await resolveIssueIdArgs('close', ['e79a1b2c', '--reason', 'abc123'], lookup);
    expect(close.args).toEqual([UUID_A, '--reason', 'abc123']);
  });

  test('resolveIssueIdArgs resolves both dep endpoints, including --issue=/--blocks= forms', async () => {
    const lookup = fakeLookup([
      { id: UUID_A, title: 'a' },
      { id: UUID_B, title: 'b' },
    ]);
    const positional = await resolveIssueIdArgs('dep.add', ['e79a1b2c', 'deadbeef-1111'], lookup);
    expect(positional.args).toEqual([UUID_A, UUID_B]);

    const flagged = await resolveIssueIdArgs('dep.add', ['--issue=e79a1b2c', '--blocks=deadbeef-1111'], lookup);
    expect(flagged.args).toEqual([`--issue=${UUID_A}`, `--blocks=${UUID_B}`]);
  });

  test('resolveIssueIdArgs leaves non-id operations untouched without a lookup', async () => {
    const lookup = fakeLookup([{ id: UUID_A, title: 'a' }]);
    for (const operation of ['list', 'ready', 'search', 'stats', 'create']) {
      const result = await resolveIssueIdArgs(operation, ['e79a1b2c'], lookup);
      expect(result.args).toEqual(['e79a1b2c']);
    }
    expect(lookup.calls.length).toBe(0);
  });

  test('resolveIssueIdArgs surfaces the resolver error', async () => {
    const lookup = fakeLookup([
      { id: UUID_B, title: 'b' },
      { id: UUID_C, title: 'c' },
    ]);
    const result = await resolveIssueIdArgs('show', ['deadbeef'], lookup);
    expect(result.error.code).toBe('FORGE_ISSUE_ID_AMBIGUOUS');
  });
});

describe('issue-id resolver — broker boundary (kernel end-to-end)', () => {
  let tmpDir;
  let driver;
  let broker;
  const now = '2026-07-07T00:00:00.000Z';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'short-id-'));
    const dbPath = path.join(tmpDir, 'kernel.sqlite');
    driver = createBuiltinSQLiteDriver({});
    broker = createLocalBroker({
      projectRoot: tmpDir,
      execFileSync: () => path.join(tmpDir, '.git'),
      databasePath: dbPath,
      driver,
    });
    await broker.initialize();
    for (const [id, title] of [
      [UUID_A, 'Unique target'],
      [UUID_B, 'Ambiguous one'],
      [UUID_C, 'Ambiguous two'],
    ]) {
      const created = await broker.runIssueOperation(
        'create',
        ['--id', id, '--title', title, '--type', 'task'],
        { now, actor: 'tester' },
      );
      expect(created.ok).toBe(true);
    }
  });

  afterEach(() => {
    if (driver) driver.close();
    if (tmpDir) rmrf(tmpDir);
  });

  test('show resolves an unambiguous 8-char prefix to the full issue', async () => {
    const result = await broker.runIssueOperation('show', ['e79a1b2c'], { now });
    expect(result.ok).toBe(true);
    expect(result.data.id).toBe(UUID_A);
  });

  test('claim + owns + comment + close all accept the short prefix', async () => {
    const claimed = await broker.runIssueOperation('claim', ['e79a1b2c'], { now, actor: 'agent-a' });
    expect(claimed.ok).toBe(true);

    const owns = await broker.runIssueOperation('owns', ['e79a1b2c'], { now, actor: 'agent-a' });
    expect(owns.ok).toBe(true);
    expect(owns.data.owned).toBe(true);
    expect(owns.data.id).toBe(UUID_A);

    const commented = await broker.runIssueOperation('comment', ['e79a1b2c', 'short-id note'], { now, actor: 'agent-a' });
    expect(commented.ok).toBe(true);

    const closed = await broker.runIssueOperation('close', ['e79a1b2c', '--reason', 'done via prefix'], { now, actor: 'agent-a' });
    expect(closed.ok).toBe(true);

    const shown = await broker.runIssueOperation('show', [UUID_A], { now });
    expect(shown.data.status).toBe('done');
    expect((shown.data.comments || []).some(comment => comment.body === 'short-id note')).toBe(true);
  });

  test('an ambiguous prefix fails with the candidate list', async () => {
    const result = await broker.runIssueOperation('show', ['deadbeef'], { now });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('FORGE_ISSUE_ID_AMBIGUOUS');
    expect(result.error.exit_code).toBe(ISSUE_COMMAND_EXIT_CODES.validation);
    expect(result.error.message).toContain(UUID_B);
    expect(result.error.message).toContain(UUID_C);
  });

  test('a too-short prefix fails with guidance', async () => {
    const result = await broker.runIssueOperation('show', ['dead'], { now });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('FORGE_ISSUE_ID_PREFIX_TOO_SHORT');
    expect(result.error.message).toContain('at least 6');
  });

  test('a non-matching prefix keeps the unchanged not-found error', async () => {
    const result = await broker.runIssueOperation('show', ['abcdef000000'], { now });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('FORGE_ISSUE_NOT_FOUND');
  });

  test('legacy non-hex ids still pass through and resolve', async () => {
    const created = await broker.runIssueOperation(
      'create',
      ['--id', 'forge-legacy1', '--title', 'Legacy id', '--type', 'task'],
      { now, actor: 'tester' },
    );
    expect(created.ok).toBe(true);
    const shown = await broker.runIssueOperation('show', ['forge-legacy1'], { now });
    expect(shown.ok).toBe(true);
    expect(shown.data.id).toBe('forge-legacy1');
  });

  test('command level: forge show/close consume short prefixes through runIssueSubcommand', async () => {
    const opts = { issueBackend: 'kernel', kernelBroker: broker };

    const shown = await runIssueSubcommand('show', ['e79a1b2c', '--json'], tmpDir, opts);
    expect(shown.success).toBe(true);
    expect(shown.output).toContain(UUID_A);

    // Batch close fans out one broker call per id — each id is resolved.
    const closed = await runIssueSubcommand('close', ['deadbeef-1111', 'deadbeef-2222'], tmpDir, opts);
    expect(closed.success).toBe(true);
    expect(closed.output).toContain(UUID_B);
    expect(closed.output).toContain(UUID_C);
  });
});

describe('issue-id resolver — human handles (1db53c60)', () => {
  test('resolves a <slug>-<short-id> handle by its trailing 8-char short id', async () => {
    const lookup = fakeLookup([{ id: UUID_A, title: 'Add OAuth login' }]);
    const result = await resolveIssueId('add-oauth-login-e79a1b2c', lookup);
    expect(result).toEqual({ id: UUID_A });
  });

  test('ignores a stale/wrong slug — only the trailing short id matters', async () => {
    const lookup = fakeLookup([{ id: UUID_A, title: 'Renamed thing' }]);
    const result = await resolveIssueId('whatever-old-name-e79a1b2c', lookup);
    expect(result).toEqual({ id: UUID_A });
  });

  test('prefers an exact match on the whole token (imported handle-shaped ids)', async () => {
    const imported = 'legacy-2a3bc9de';
    const lookup = fakeLookup([{ id: imported, title: 'imported' }]);
    const result = await resolveIssueId(imported, lookup);
    expect(result).toEqual({ id: imported });
  });

  test('a short (<8) hex suffix is NOT treated as a handle (no lookup)', async () => {
    const lookup = fakeLookup([]);
    const result = await resolveIssueId('forge-2a3bc9', lookup);
    expect(result).toEqual({ id: 'forge-2a3bc9' });
    expect(lookup.calls.length).toBe(0);
  });
});
