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

  test('same actor + same session claiming the SAME issue twice: idempotent duplicate replay — one lease, no conflict', async () => {
    // The central POSITIVE guarantee: identical (actor, session) on the same issue
    // yields an IDENTICAL idempotency key, so the retry replays as a duplicate (ok:true)
    // rather than minting a second lease or tripping claim_conflict. This guards against
    // a regression that changed the key format for same-session retries (which would
    // otherwise stay green — the distinct-sessions test alone would not catch it).
    await createIssue('sess-4', 'Retry');

    const first = await claim('sess-4', 'alice', 'sess-A', now);
    const second = await claim('sess-4', 'alice', 'sess-A', '2026-06-20T00:00:01.000Z');

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    // ok:true means NOT a claim conflict (a conflict is ok:false with an error).
    expect(second.error).toBeUndefined();

    // Exactly ONE active lease exists — the retry did not create a second.
    const stats = await driver.issueOperation('stats', [], { now }, config);
    expect(stats.data.active_claims).toBe(1);

    // And the single session still holds it.
    const owns = await driver.issueOperation(
      'owns', ['sess-4'], { now, actor: 'alice', sessionId: 'sess-A' }, config,
    );
    expect(owns.data.owned).toBe(true);
  });

  test('empty-string session-id is treated as session-LESS symmetrically (key + owns)', async () => {
    // '' must behave identically at the write site (no trailing ':' appended to the key,
    // session_id stored null) and the owns read (actor-only fallback), never as "present"
    // at one and "absent" at the other.
    await createIssue('sess-5', 'Blank');

    // Claim with an EMPTY session, then re-claim with an actual session-less caller: both
    // resolve to the SAME `claim.create:sess-5:alice` key, so the second is a duplicate
    // replay (ok:true) — proving '' did not append to the key.
    const empty = await claim('sess-5', 'alice', '', now);
    const sessionless = await claim('sess-5', 'alice', undefined, '2026-06-20T00:00:01.000Z');
    expect(empty.ok).toBe(true);
    expect(sessionless.ok).toBe(true);

    const stats = await driver.issueOperation('stats', [], { now }, config);
    expect(stats.data.active_claims).toBe(1);

    // owns with an empty session falls back to actor-only ownership (stored session is null).
    const owns = await driver.issueOperation(
      'owns', ['sess-5'], { now, actor: 'alice', sessionId: '' }, config,
    );
    expect(owns.data.owned).toBe(true);
    expect(owns.data.claimed_by).toBe('alice');
  });
});
