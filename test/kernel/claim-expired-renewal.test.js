'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLocalBroker } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');

// Expired-lease re-claim (issue 55a6d3e6). The default claim idempotency key is
// deterministic per issue+actor+session, so a SAME-identity claim after the earlier
// lease EXPIRED used to replay the stored claim.create as an idempotent duplicate:
// ok:true with a fresh-looking claim_id, but no live lease (owns → owned=false,
// claimed_by=null). All clocks are injected via context.now — no real-TTL sleeping.
describe('claim renewal after lease expiry (55a6d3e6)', () => {
  let tmpDir;
  let driver;
  let broker;
  let config;
  const TTL_MS = 60_000;
  const t0 = '2026-09-28T00:00:00.000Z';
  const tLive = '2026-09-28T00:00:10.000Z'; // inside the first lease
  const tExpired = '2026-09-28T00:02:00.000Z'; // after the first lease expired
  const tExpired2 = '2026-09-28T00:04:00.000Z'; // after a renewed lease expired

  async function createIssue(id) {
    return broker.runIssueOperation(
      'create',
      ['--id', id, '--title', id, '--type', 'task'],
      { now: t0, actor: 'tester' },
    );
  }

  function claim(id, actor, sessionId, at) {
    return broker.runIssueOperation('claim', ['--issue', id], {
      now: at, actor, sessionId, leaseTtlMs: TTL_MS,
    });
  }

  function owns(id, actor, sessionId, at) {
    return driver.issueOperation('owns', [id], { now: at, actor, sessionId }, config);
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-renewal-'));
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

  test('same-identity re-claim of an EXPIRED lease acquires a new live lease', async () => {
    await createIssue('renew-1');
    const first = await claim('renew-1', 'alice', 'sess-A', t0);
    expect(first.ok).toBe(true);

    const second = await claim('renew-1', 'alice', 'sess-A', tExpired);
    expect(second.ok).toBe(true);
    expect(second.data.claim_id).not.toBe(first.data.claim_id);

    const own = await owns('renew-1', 'alice', 'sess-A', tExpired);
    expect(own.data.owned).toBe(true);
    expect(own.data.expired).toBe(false);
    expect(own.data.claimed_by).toBe('alice');
    expect(own.data.expires_at).toBe(new Date(Date.parse(tExpired) + TTL_MS).toISOString());
  });

  test('session-less same-actor re-claim of an EXPIRED lease also renews', async () => {
    await createIssue('renew-2');
    await claim('renew-2', 'alice', undefined, t0);
    const second = await claim('renew-2', 'alice', undefined, tExpired);
    expect(second.ok).toBe(true);
    const own = await owns('renew-2', 'alice', undefined, tExpired);
    expect(own.data.owned).toBe(true);
  });

  test('renewal chains: every expired generation is re-acquired, not replayed', async () => {
    await createIssue('renew-3');
    const first = await claim('renew-3', 'alice', 'sess-A', t0);
    const second = await claim('renew-3', 'alice', 'sess-A', tExpired);
    const third = await claim('renew-3', 'alice', 'sess-A', tExpired2);
    expect(third.ok).toBe(true);
    const ids = new Set([first.data.claim_id, second.data.claim_id, third.data.claim_id]);
    expect(ids.size).toBe(3);
    expect((await owns('renew-3', 'alice', 'sess-A', tExpired2)).data.owned).toBe(true);
  });

  test('same-identity replay while the lease is LIVE is idempotent and returns the live lease', async () => {
    await createIssue('replay-1');
    const first = await claim('replay-1', 'alice', 'sess-A', t0);
    const before = await owns('replay-1', 'alice', 'sess-A', tLive);

    const replay = await claim('replay-1', 'alice', 'sess-A', tLive);
    expect(replay.ok).toBe(true);
    expect(replay.data.claim_id).toBe(first.data.claim_id);

    const after = await owns('replay-1', 'alice', 'sess-A', tLive);
    expect(after.data.owned).toBe(true);
    expect(after.data.expires_at).toBe(before.data.expires_at);
  });

  test('replay of a RENEWED live lease returns that renewed lease', async () => {
    await createIssue('replay-2');
    await claim('replay-2', 'alice', 'sess-A', t0);
    const renewed = await claim('replay-2', 'alice', 'sess-A', tExpired);
    const replay = await claim('replay-2', 'alice', 'sess-A', '2026-09-28T00:02:05.000Z');
    expect(replay.ok).toBe(true);
    expect(replay.data.claim_id).toBe(renewed.data.claim_id);
  });

  test('another identity holding a LIVE lease still refuses the claim', async () => {
    await createIssue('other-1');
    const a = await claim('other-1', 'alice', 'sess-A', t0);
    expect(a.ok).toBe(true);
    const b = await claim('other-1', 'bob', 'sess-B', tLive);
    expect(b.ok).toBe(false);
    expect(b.error.code).toBe('FORGE_ISSUE_CLAIM_CONFLICT');
    expect((await owns('other-1', 'bob', 'sess-B', tLive)).data.owned).toBe(false);
  });

  test('an EXPIRED lease held by another identity is reclaimable by the caller', async () => {
    await createIssue('other-2');
    await claim('other-2', 'alice', 'sess-A', t0);
    const b = await claim('other-2', 'bob', 'sess-B', tExpired);
    expect(b.ok).toBe(true);
    const own = await owns('other-2', 'bob', 'sess-B', tExpired);
    expect(own.data.owned).toBe(true);
    expect(own.data.claimed_by).toBe('bob');
  });

  test('a stale same-identity key never replays ok over ANOTHER identity\'s live lease', async () => {
    await createIssue('other-3');
    await claim('other-3', 'alice', 'sess-A', t0);
    // alice's lease expires; bob takes the issue with a live lease.
    const b = await claim('other-3', 'bob', 'sess-B', tExpired);
    expect(b.ok).toBe(true);
    // alice claims again with her original (now stale) key while bob is live:
    // must fail closed as a conflict, not replay her old ok.
    const again = await claim('other-3', 'alice', 'sess-A', '2026-09-28T00:02:10.000Z');
    expect(again.ok).toBe(false);
    expect(again.error.code).toBe('FORGE_ISSUE_CLAIM_CONFLICT');
    expect((await owns('other-3', 'bob', 'sess-B', '2026-09-28T00:02:10.000Z')).data.owned).toBe(true);
  });
});
