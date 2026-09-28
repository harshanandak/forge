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

  // PR #589 review: concurrent renewers converge on one winner, caller keys keep
  // deduping across generations, a key reused for another issue is refused, and a
  // pinned claim id is not reused for a new lease row. The lease row is the only
  // authority; idempotency keys are never followed across generations.
  describe('claim renewal authority (PR #589 review)', () => {
    function claimWith(id, actor, sessionId, at, extra) {
      return broker.runIssueOperation('claim', ['--issue', id], {
        now: at, actor, sessionId, leaseTtlMs: TTL_MS, ...extra,
      });
    }

    test('concurrent same-identity renewals of one expired lease converge: the loser replays the winner', async () => {
      await createIssue('race-1');
      await claim('race-1', 'alice', 'sess-A', t0);
      // Renewer B read the expired lease BEFORE renewer A committed (split read). Replay
      // that deterministically: B's driver serves the pre-A active-claim snapshot and a
      // miss on its first renewal-key lookup, then real reads.
      const staleActive = await driver.loadActiveKernelClaim('race-1', {}, config);
      let activeReads = 0;
      let renewalKeyReads = 0;
      const staleDriver = {
        ...driver,
        async loadActiveKernelClaim(...callArgs) {
          activeReads += 1;
          return activeReads === 1 ? staleActive : driver.loadActiveKernelClaim(...callArgs);
        },
        async loadKernelEventByIdempotencyKey(key, ...rest) {
          if (/:(after|lease):/.test(key) && renewalKeyReads === 0) {
            renewalKeyReads += 1;
            return null;
          }
          return driver.loadKernelEventByIdempotencyKey(key, ...rest);
        },
      };
      const brokerB = createLocalBroker({
        projectRoot: tmpDir,
        execFileSync: () => path.join(tmpDir, '.git'),
        databasePath: config.databasePath,
        driver: staleDriver,
      });
      await brokerB.initialize();

      const a = await claim('race-1', 'alice', 'sess-A', tExpired);
      expect(a.ok).toBe(true);
      const b = await brokerB.runIssueOperation('claim', ['--issue', 'race-1'], {
        now: '2026-09-28T00:02:01.000Z', actor: 'alice', sessionId: 'sess-A', leaseTtlMs: TTL_MS,
      });
      // B really took the split-read path (stale lease + missed renewal key).
      expect(renewalKeyReads).toBe(1);
      expect(b.ok).toBe(true);
      expect(b.data.claim_id).toBe(a.data.claim_id);
      expect((await owns('race-1', 'alice', 'sess-A', '2026-09-28T00:02:01.000Z')).data.owned).toBe(true);
    });

    // Round 3: every claim decision must use lease state read AFTER the generation walk,
    // inside the write transaction. The stale driver models a winner that committed
    // after B's pre-transaction reads: until B opens its transaction (BEGIN), the
    // chosen reads serve the pre-winner view; from BEGIN on every read is real, which
    // is what SQLite's BEGIN IMMEDIATE write lock guarantees.
    //   staleLease: active-lease reads return the pre-winner snapshot
    //   staleKeys:  idempotency reads hide events committed at/after winnerAt
    async function brokerWithStaleView(issueId, { staleLease, staleKeys, winnerAt }) {
      const staleActive = await driver.loadActiveKernelClaim(issueId, {}, config);
      const view = { inTransaction: false, staleLeaseReads: 0 };
      const staleDriver = {
        ...driver,
        async exec(sql, ...rest) {
          if (/^BEGIN/i.test(sql)) view.inTransaction = true;
          return driver.exec(sql, ...rest);
        },
        async loadActiveKernelClaim(...callArgs) {
          if (staleLease && !view.inTransaction) {
            view.staleLeaseReads += 1;
            return staleActive;
          }
          return driver.loadActiveKernelClaim(...callArgs);
        },
        async loadKernelEventByIdempotencyKey(...callArgs) {
          const found = await driver.loadKernelEventByIdempotencyKey(...callArgs);
          if (staleKeys && !view.inTransaction && found && found.created_at >= winnerAt) return null;
          return found;
        },
      };
      const staleBroker = createLocalBroker({
        projectRoot: tmpDir,
        execFileSync: () => path.join(tmpDir, '.git'),
        databasePath: config.databasePath,
        driver: staleDriver,
      });
      await staleBroker.initialize();
      return { staleBroker, view };
    }

    test('a committed winner is replayed even when the pre-transaction lease snapshot predates it', async () => {
      await createIssue('race-2');
      await claim('race-2', 'alice', 'sess-A', t0);
      // B's pre-transaction lease view predates A's renewal; B's key reads are real.
      const { staleBroker } = await brokerWithStaleView('race-2', { staleLease: true, staleKeys: false, winnerAt: tExpired });
      const a = await claim('race-2', 'alice', 'sess-A', tExpired);
      expect(a.ok).toBe(true);
      const b = await staleBroker.runIssueOperation('claim', ['--issue', 'race-2'], {
        now: '2026-09-28T00:02:01.000Z', actor: 'alice', sessionId: 'sess-A', leaseTtlMs: TTL_MS,
      });
      expect(b.ok).toBe(true);
      expect(b.data.claim_id).toBe(a.data.claim_id);
      expect((await owns('race-2', 'alice', 'sess-A', '2026-09-28T00:02:01.000Z')).data.owned).toBe(true);
    });

    test('a same-identity winner under a different key is replayed, decided on the in-transaction lease', async () => {
      await createIssue('race-3');
      await claim('race-3', 'alice', 'sess-A', t0);
      // A renews under a caller key, so B's derived key never collides with A's event:
      // only the lease read inside B's transaction can see that alice/sess-A already won.
      const { staleBroker } = await brokerWithStaleView('race-3', { staleLease: true, staleKeys: true, winnerAt: tExpired });
      const a = await claimWith('race-3', 'alice', 'sess-A', tExpired, { idempotencyKey: 'caller-race-3' });
      expect(a.ok).toBe(true);
      const b = await staleBroker.runIssueOperation('claim', ['--issue', 'race-3'], {
        now: '2026-09-28T00:02:01.000Z', actor: 'alice', sessionId: 'sess-A', leaseTtlMs: TTL_MS,
      });
      expect(b.ok).toBe(true);
      expect(b.data.claim_id).toBe(a.data.claim_id);
    });

    // Round 4: the idempotency-key namespace is caller-writable, so claim decisions must
    // never follow key-derived events. Plant a foreign issue event exactly where a
    // generation walk would look (`<claim key>:after:<claim id>`) with the same entity
    // id, forming a cycle. The renewal must not read it at all; the driver throws on
    // the second read of the planted key so a walk fails fast instead of spinning
    // inside BEGIN IMMEDIATE.
    test('a foreign event planted under a derived renewal key is never followed', async () => {
      await createIssue('foreign-1');
      const baseKey = 'claim.create:foreign-1:alice:sess-A';
      const first = await claimWith('foreign-1', 'alice', 'sess-A', t0, { claimId: 'pinned-foreign' });
      expect(first.ok).toBe(true);
      const plantedKey = `${baseKey}:after:pinned-foreign`;
      const planted = await broker.runIssueOperation(
        'create',
        ['--id', 'pinned-foreign', '--title', 'planted', '--type', 'task'],
        { now: tLive, actor: 'mallory', idempotencyKey: plantedKey },
      );
      expect(planted.ok).toBe(true);

      let plantedReads = 0;
      const guardedDriver = {
        ...driver,
        async loadKernelEventByIdempotencyKey(key, ...rest) {
          if (key === plantedKey) {
            plantedReads += 1;
            if (plantedReads > 1) throw new Error('claim walked the planted foreign event more than once');
          }
          return driver.loadKernelEventByIdempotencyKey(key, ...rest);
        },
      };
      const guardedBroker = createLocalBroker({
        projectRoot: tmpDir,
        execFileSync: () => path.join(tmpDir, '.git'),
        databasePath: config.databasePath,
        driver: guardedDriver,
      });
      await guardedBroker.initialize();

      const renewed = await guardedBroker.runIssueOperation('claim', ['--issue', 'foreign-1'], {
        now: tExpired, actor: 'alice', sessionId: 'sess-A', leaseTtlMs: TTL_MS, claimId: 'pinned-foreign',
      });
      expect(plantedReads).toBe(0);
      expect(renewed.ok).toBe(true);
      expect(renewed.data.claim_id).not.toBe('pinned-foreign');
      expect((await owns('foreign-1', 'alice', 'sess-A', tExpired)).data.owned).toBe(true);
    });

    test('a stale snapshot never lets another identity\'s live renewal be replayed or superseded', async () => {
      await createIssue('race-4');
      await claim('race-4', 'alice', 'sess-A', t0);
      const { staleBroker } = await brokerWithStaleView('race-4', { staleLease: true, staleKeys: true, winnerAt: tExpired });
      const bob = await claim('race-4', 'bob', 'sess-B', tExpired);
      expect(bob.ok).toBe(true);
      const again = await staleBroker.runIssueOperation('claim', ['--issue', 'race-4'], {
        now: '2026-09-28T00:02:01.000Z', actor: 'alice', sessionId: 'sess-A', leaseTtlMs: TTL_MS,
      });
      expect(again.ok).toBe(false);
      expect(again.error.code).toBe('FORGE_ISSUE_CLAIM_CONFLICT');
      expect((await owns('race-4', 'bob', 'sess-B', '2026-09-28T00:02:01.000Z')).data.owned).toBe(true);
    });

    test('a caller key bound to another issue is not rewritten into a new claim', async () => {
      await createIssue('key-x');
      await createIssue('key-y');
      const x = await claimWith('key-x', 'alice', 'sess-A', t0, { idempotencyKey: 'caller-key-1' });
      expect(x.ok).toBe(true);
      const y = await claimWith('key-y', 'alice', 'sess-A', tLive, { idempotencyKey: 'caller-key-1' });
      expect(y.ok).toBe(false);
      expect(y.error.code).toBe('FORGE_ISSUE_IDEMPOTENCY_KEY_REUSED');
      expect((await owns('key-y', 'alice', 'sess-A', tLive)).data.owned).toBe(false);
      expect((await owns('key-x', 'alice', 'sess-A', tLive)).data.owned).toBe(true);
    });

    test('a caller key still dedupes a retry after it renewed an expired lease', async () => {
      await createIssue('key-z');
      const first = await claimWith('key-z', 'alice', 'sess-A', t0, { idempotencyKey: 'caller-key-2' });
      const renewed = await claimWith('key-z', 'alice', 'sess-A', tExpired, { idempotencyKey: 'caller-key-2' });
      expect(renewed.ok).toBe(true);
      expect(renewed.data.claim_id).not.toBe(first.data.claim_id);
      const retry = await claimWith('key-z', 'alice', 'sess-A', '2026-09-28T00:02:05.000Z', { idempotencyKey: 'caller-key-2' });
      expect(retry.ok).toBe(true);
      expect(retry.data.claim_id).toBe(renewed.data.claim_id);
    });

    test('a pinned claim id is not reused for the renewed lease row', async () => {
      await createIssue('pin-1');
      const first = await claimWith('pin-1', 'alice', 'sess-A', t0, { claimId: 'pinned-claim-1' });
      expect(first.ok).toBe(true);
      expect(first.data.claim_id).toBe('pinned-claim-1');
      const renewed = await claimWith('pin-1', 'alice', 'sess-A', tExpired, { claimId: 'pinned-claim-1' });
      expect(renewed.ok).toBe(true);
      expect(renewed.data.claim_id).not.toBe('pinned-claim-1');
      const own = await owns('pin-1', 'alice', 'sess-A', tExpired);
      expect(own.data.owned).toBe(true);
      expect(own.data.expired).toBe(false);
    });
  });

  // PR #589 round 5: the full claim ownership matrix, pinned in one table so claim
  // and owns() can never disagree again. Ownership is ONE predicate (the owns() rule):
  // same actor, and sessions conflict only when BOTH are present and unequal. A
  // session-less side falls back to actor-only ownership.
  //
  // Cells that differ from origin/master ON PURPOSE (master probed 2026-09-28):
  // - live, default key, lease none x caller S (and lease S x caller none): master
  //   returned CLAIM_CONFLICT while owns() said owned=true; now both agree: replay.
  // - live, explicit key, lease S x caller S2: master replayed ok to a session that
  //   does not own the lease (owns=false, the d71a824b phantom); now CLAIM_CONFLICT.
  // - expired, any cell: master replayed a same-key claim as a phantom ok with no
  //   live lease; now a new live lease.
  describe('claim ownership matrix (PR #589 round 5)', () => {
    const SESSIONS = { none: undefined, S: 'sess-S', S2: 'sess-S2' };
    const cells = [];
    for (const leaseSession of ['none', 'S']) {
      for (const callerSession of ['none', 'S', 'S2']) {
        for (const phase of ['live', 'expired']) {
          for (const keyMode of ['default', 'explicit']) {
            const sessionsConflict = leaseSession === 'S' && callerSession === 'S2';
            const expected = phase === 'expired' ? 'renew' : (sessionsConflict ? 'conflict' : 'replay');
            cells.push({ actor: 'alice', leaseSession, callerSession, phase, keyMode, expected });
          }
        }
      }
    }
    // Another actor: blocked by a live lease, may take over an expired one.
    for (const phase of ['live', 'expired']) {
      cells.push({ actor: 'bob', leaseSession: 'S', callerSession: 'S', phase, keyMode: 'default', expected: phase === 'live' ? 'conflict' : 'renew' });
    }

    test.each(cells)('$actor lease=$leaseSession caller=$callerSession $phase $keyMode key -> $expected', async (cell) => {
      const issueId = `matrix-${cell.actor}-${cell.leaseSession}-${cell.callerSession}-${cell.phase}-${cell.keyMode}`;
      await createIssue(issueId);
      const keyContext = cell.keyMode === 'explicit' ? { idempotencyKey: `explicit-${issueId}` } : {};
      const first = await broker.runIssueOperation('claim', ['--issue', issueId], {
        now: t0, actor: 'alice', sessionId: SESSIONS[cell.leaseSession], leaseTtlMs: TTL_MS, ...keyContext,
      });
      expect(first.ok).toBe(true);

      const at = cell.phase === 'live' ? tLive : tExpired;
      const again = await broker.runIssueOperation('claim', ['--issue', issueId], {
        now: at, actor: cell.actor, sessionId: SESSIONS[cell.callerSession], leaseTtlMs: TTL_MS, ...keyContext,
      });
      const own = await owns(issueId, cell.actor, SESSIONS[cell.callerSession], at);

      if (cell.expected === 'conflict') {
        expect(again.ok).toBe(false);
        expect(again.error.code).toBe('FORGE_ISSUE_CLAIM_CONFLICT');
        expect(own.data.owned).toBe(false);
        return;
      }
      expect(again.ok).toBe(true);
      expect(own.data.owned).toBe(true);
      if (cell.expected === 'replay') {
        expect(again.data.claim_id).toBe(first.data.claim_id);
      } else {
        expect(again.data.claim_id).not.toBe(first.data.claim_id);
        expect(own.data.expired).toBe(false);
      }
    });
  });

  // PR #589 round 6: claim and owns() must share the canonical live-lease rule
  // (isLiveClaim), and a claim must never commit a lease that is already expired.
  describe('lease validity at claim time (PR #589 round 6)', () => {
    test('a malformed-expiry lease is never replayed as a held lease', async () => {
      await createIssue('bad-expiry');
      await driver.exec(
        "INSERT INTO kernel_claims (id, issue_id, actor, state, session_id, worktree_id, claimed_at, expires_at) "
        + "VALUES ('legacy-bad', 'bad-expiry', 'alice', 'active', 'sess-A', NULL, '2026-09-28T00:00:00.000Z', 'not-a-timestamp');",
        config,
      );
      const again = await claim('bad-expiry', 'alice', 'sess-A', tLive);
      const own = await owns('bad-expiry', 'alice', 'sess-A', tLive);
      expect(own.data.owned).toBe(false);
      // claim and owns() agree: no ok for a lease owns() does not count as live.
      expect(again.ok).toBe(false);
      expect(again.error.code).toBe('FORGE_ISSUE_CLAIM_CONFLICT');
    });

    test('an already-expired --expires is rejected before anything is written, on every retry', async () => {
      await createIssue('past-expiry');
      const countRows = async () => ({
        claims: (await driver.queryAll("SELECT * FROM kernel_claims WHERE issue_id = 'past-expiry'", config)).length,
        events: (await driver.queryAll("SELECT * FROM kernel_events WHERE entity_type = 'claim'", config)).length,
      });
      const before = await countRows();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await broker.runIssueOperation(
          'claim', ['--issue', 'past-expiry', '--expires', '2026-09-27T00:00:00.000Z'],
          { now: tLive, actor: 'alice', sessionId: 'sess-A' },
        );
        expect(result.ok).toBe(false);
        expect(result.error.code).toBe('FORGE_ISSUE_VALIDATION');
      }
      expect(await countRows()).toEqual(before);
    });
  });
});
