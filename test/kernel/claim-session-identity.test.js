'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLocalBroker } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');

// Session-scoped claim identity (kernel d71a824b). The claim idempotency key was
// `claim.create:<issue_id>:<actor>` with `actor` defaulting to a shared 'forge'. Two
// concurrent AGENTS acting as the SAME human actor on the SAME issue produced the SAME
// key, so the loser's claim collapsed to an idempotent duplicate-replay (ok:true)
// instead of reaching the claim_conflict lease guard — and, because owns() compared by
// actor only, BOTH agents read OWNED. That is silent double-work (a correctness hole,
// not just provenance). The fix threads the per-agent SESSION-ID into (a) the claim
// idempotency key and (b) the owns() lease-ownership check, so exactly one session wins
// the lease and the other is correctly rejected.
describe('claim session identity — same actor, different sessions (d71a824b)', () => {
  let tmpDir;
  let driver;
  let broker;
  let config;
  const now = '2026-06-20T00:00:00.000Z';

  async function createIssue(id, title = id) {
    return broker.runIssueOperation(
      'create',
      ['--id', id, '--title', title, '--type', 'task'],
      { now, actor: 'tester' },
    );
  }

  async function claim(id, actor, sessionId, at = now) {
    return broker.runIssueOperation('claim', ['--issue', id], { now: at, actor, sessionId });
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-session-'));
    const dbPath = path.join(tmpDir, 'kernel.sqlite');
    config = { databasePath: dbPath };
    driver = createBuiltinSQLiteDriver({});
    broker = createLocalBroker({
      projectRoot: tmpDir,
      execFileSync: () => path.join(tmpDir, '.git'),
      databasePath: dbPath,
      driver,
    });
    await broker.initialize();
  });

  afterEach(() => {
    if (driver) driver.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('two claims, one human actor, distinct session-ids: exactly one wins, the other is a claim conflict', async () => {
    await createIssue('sess-1', 'Contended');

    // Same human actor ('alice'), two different per-agent sessions.
    const a = await claim('sess-1', 'alice', 'sess-A', now);
    const b = await claim('sess-1', 'alice', 'sess-B', '2026-06-20T00:00:01.000Z');

    // Before the fix both keys are `claim.create:sess-1:alice`, so B replays as an
    // idempotent duplicate (ok:true) and BOTH report success. After the fix B reaches
    // the lease guard and is quarantined as a claim conflict.
    const wins = [a, b].filter(r => r.ok === true);
    const conflicts = [a, b].filter(r => r.ok === false);
    expect(wins.length).toBe(1);
    expect(conflicts.length).toBe(1);

    // A claimed first, so A holds the lease and B is the loser.
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    expect(b.error.code).toBe('FORGE_ISSUE_CLAIM_CONFLICT');
  });

  test('owns() is session-scoped: the winning session OWNS, a same-actor other session does NOT', async () => {
    await createIssue('sess-2', 'Contended');
    await claim('sess-2', 'alice', 'sess-A', now);

    const ownsWinner = await driver.issueOperation(
      'owns', ['sess-2'], { now, actor: 'alice', sessionId: 'sess-A' }, config,
    );
    expect(ownsWinner.data.owned).toBe(true);
    expect(ownsWinner.data.claimed_by).toBe('alice');

    // Same human actor, DIFFERENT session — must NOT be reported as the lease holder,
    // even though claimed_by === actor. Before the fix owns compared actor only and
    // wrongly returned owned:true.
    const ownsOther = await driver.issueOperation(
      'owns', ['sess-2'], { now, actor: 'alice', sessionId: 'sess-B' }, config,
    );
    expect(ownsOther.data.owned).toBe(false);
  });

  test('backward compatible: a session-less caller still owns its own session-less claim', async () => {
    await createIssue('sess-3', 'Legacy');
    // No sessionId anywhere — historical actor-only behavior must be preserved.
    await claim('sess-3', 'forge-a', undefined, now);

    const owns = await driver.issueOperation(
      'owns', ['sess-3'], { now, actor: 'forge-a' }, config,
    );
    expect(owns.data.owned).toBe(true);
    expect(owns.data.claimed_by).toBe('forge-a');
  });
});
