const { describe, expect, test } = require('bun:test');
const os = require('node:os');
const path = require('node:path');

const { createLocalBroker } = require('../../lib/kernel/broker');

const PROJECT_ROOT = path.join(os.tmpdir(), 'forge-worktree');
const GIT_COMMON_DIR = path.join(os.tmpdir(), 'forge-common-dir');

// A guarded event that the evaluator accepts: expected_revision 0 against a
// fresh (revision 0 / absent) entity, with no idempotency or dependency state.
function acceptEvent() {
  return {
    entity_type: 'issue',
    entity_id: 'issue-1',
    event_type: 'issue.update',
    idempotency_key: 'issue-update:issue-1:rev-0',
    expected_revision: 0,
    payload: { title: 'Renamed' },
    created_at: '2026-06-17T00:00:00.000Z',
  };
}

function brokerWith(driverOverrides, ops) {
  return createLocalBroker({
    projectRoot: PROJECT_ROOT,
    gitCommonDir: GIT_COMMON_DIR,
    driver: {
      async exec(statement) { ops.push(`exec:${statement}`); },
      async loadKernelEntity() { return null; },
      async listKernelEvents() { return []; },
      async loadKernelEventByIdempotencyKey() { return null; },
      async listKernelDependencies() { return []; },
      async insertKernelConflict(conflict) { ops.push('insertKernelConflict'); return conflict; },
      async insertKernelEvent(event) { ops.push('insertKernelEvent'); return { ...event, id: 'event-1' }; },
      async enqueueKernelProjection(entry) { ops.push('enqueueKernelProjection'); return { ...entry, id: 'outbox-1' }; },
      ...driverOverrides,
    },
  });
}

describe('local Kernel broker atomicity (9.5.6)', () => {
  test('wraps accept-path event insert + projection enqueue in a single BEGIN IMMEDIATE transaction', async () => {
    const ops = [];
    const broker = brokerWith({}, ops);

    const result = await broker.runGuardedEvent(acceptEvent(), {});

    expect(result.decision).toBe('accept');
    expect(result.event.id).toBe('event-1');
    expect(result.outboxEntry.id).toBe('outbox-1');
    // The mutation is bracketed by an immediate-write transaction, with the
    // event insert and outbox enqueue committed together (no interleaving).
    expect(ops).toEqual([
      'exec:BEGIN IMMEDIATE;',
      'insertKernelEvent',
      'enqueueKernelProjection',
      'exec:COMMIT;',
    ]);
  });

  test('rolls back the inserted event when projection enqueue fails', async () => {
    const ops = [];
    const broker = brokerWith({
      async enqueueKernelProjection() {
        ops.push('enqueueKernelProjection');
        throw new Error('outbox write failed');
      },
    }, ops);

    await expect(broker.runGuardedEvent(acceptEvent(), {})).rejects.toThrow('outbox write failed');

    // The transaction is rolled back — never committed — so the event insert is undone.
    expect(ops).toContain('exec:BEGIN IMMEDIATE;');
    expect(ops).toContain('exec:ROLLBACK;');
    expect(ops).not.toContain('exec:COMMIT;');
    expect(ops.indexOf('insertKernelEvent')).toBeLessThan(ops.indexOf('exec:ROLLBACK;'));
  });

  test('recovers a concurrent idempotency collision as a duplicate replay (9.5.9)', async () => {
    const ops = [];
    const existingEvent = { id: 'event-existing', idempotency_key: 'issue-update:issue-1:rev-0' };
    let idempotencyLookupCalls = 0;
    const broker = brokerWith({
      async loadKernelEventByIdempotencyKey() {
        idempotencyLookupCalls += 1;
        // Pre-read sees nothing; recovery read (inside catch) finds the winner's event.
        return idempotencyLookupCalls > 1 ? existingEvent : null;
      },
      async insertKernelEvent() {
        ops.push('insertKernelEvent');
        throw new Error('UNIQUE constraint failed: kernel_events.idempotency_key');
      },
    }, ops);

    const result = await broker.runGuardedEvent(acceptEvent(), {});

    expect(result.decision).toBe('duplicate');
    expect(result.originalEvent).toEqual(existingEvent);
    expect(result.projection).toBe(false);
    // Transaction attempted but rolled back — never committed.
    expect(ops).toContain('exec:BEGIN IMMEDIATE;');
    expect(ops).toContain('exec:ROLLBACK;');
    expect(ops).not.toContain('exec:COMMIT;');
  });
});

const CLAIM_NOW = '2026-06-18T00:00:00.000Z';

function claimEvent(overrides = {}) {
  return {
    entity_type: 'claim',
    entity_id: 'claim-issue-1-A',
    event_type: 'claim.create',
    idempotency_key: 'claim:issue-1:A',
    actor: 'agent-A',
    payload: { issue_id: 'issue-1', expires_at: '2026-06-18T01:00:00.000Z' },
    created_at: CLAIM_NOW,
    ...overrides,
  };
}

function activeClaimRow(overrides = {}) {
  return {
    id: 'claim-issue-1-B',
    issue_id: 'issue-1',
    actor: 'agent-B',
    state: 'active',
    claimed_at: '2026-06-17T00:00:00.000Z',
    expires_at: '2026-06-18T01:00:00.000Z',
    ...overrides,
  };
}

function claimBrokerWith(driverOverrides, ops) {
  return createLocalBroker({
    projectRoot: PROJECT_ROOT,
    gitCommonDir: GIT_COMMON_DIR,
    driver: {
      async exec(statement) { ops.push(`exec:${statement}`); },
      async loadKernelEntity() { return null; },
      async listKernelEvents() { return []; },
      async loadKernelEventByIdempotencyKey() { return null; },
      async listKernelDependencies() { return []; },
      async insertKernelConflict(conflict) { ops.push('insertKernelConflict'); return { ...conflict, id: 'conflict-1' }; },
      async insertKernelEvent(event) { ops.push('insertKernelEvent'); return { ...event, id: 'event-1' }; },
      async enqueueKernelProjection(entry) { ops.push('enqueueKernelProjection'); return { ...entry, id: 'outbox-1' }; },
      async loadActiveKernelClaim() { ops.push('loadActiveKernelClaim'); return null; },
      async insertKernelClaim(claim) { ops.push('insertKernelClaim'); return { ...claim, id: claim.id || 'claim-1' }; },
      async updateKernelClaimState(claimId, state) { ops.push(`updateKernelClaimState:${state}`); return { id: claimId, state }; },
      ...driverOverrides,
    },
  });
}

const TXN_OPS = [
  'exec:BEGIN IMMEDIATE;',
  'updateKernelClaimState:reclaimable',
  'insertKernelClaim',
  'insertKernelEvent',
  'enqueueKernelProjection',
  'exec:COMMIT;',
];

describe('local Kernel broker claim leases (9.5.10 / 9.5.3)', () => {
  test('inserts an active claim inside the transaction when the issue is unclaimed', async () => {
    const ops = [];
    const broker = claimBrokerWith({}, ops);

    const result = await broker.runGuardedEvent(claimEvent(), { now: CLAIM_NOW });

    expect(result.decision).toBe('accept');
    const txn = ops.filter(op => TXN_OPS.includes(op));
    expect(txn).toEqual([
      'exec:BEGIN IMMEDIATE;',
      'insertKernelClaim',
      'insertKernelEvent',
      'enqueueKernelProjection',
      'exec:COMMIT;',
    ]);
    expect(ops).not.toContain('exec:ROLLBACK;');
  });

  test('quarantines a claim against a live lease held by another actor without opening a transaction', async () => {
    const ops = [];
    const broker = claimBrokerWith({
      async loadActiveKernelClaim() { ops.push('loadActiveKernelClaim'); return activeClaimRow(); },
    }, ops);

    const result = await broker.runGuardedEvent(claimEvent(), { now: CLAIM_NOW });

    expect(result.decision).toBe('quarantine');
    expect(result.reason).toBe('claim_conflict');
    expect(result.projection).toBe(false);
    expect(ops).toContain('insertKernelConflict');
    expect(ops).not.toContain('exec:BEGIN IMMEDIATE;');
    expect(ops).not.toContain('insertKernelClaim');
  });

  test('reclaims an expired lease by superseding it before inserting the new claim, atomically', async () => {
    const ops = [];
    const broker = claimBrokerWith({
      async loadActiveKernelClaim() {
        ops.push('loadActiveKernelClaim');
        return activeClaimRow({ id: 'claim-stale', expires_at: '2026-06-17T23:00:00.000Z' });
      },
    }, ops);

    const result = await broker.runGuardedEvent(claimEvent(), { now: CLAIM_NOW });

    expect(result.decision).toBe('accept');
    const txn = ops.filter(op => TXN_OPS.includes(op));
    expect(txn).toEqual(TXN_OPS);
    expect(ops).not.toContain('exec:ROLLBACK;');
  });

  test('recovers a concurrent active-lease index collision as a claim conflict (9.5.1-9.5.3 proof)', async () => {
    const ops = [];
    let claimLookups = 0;
    const broker = claimBrokerWith({
      async loadActiveKernelClaim() {
        claimLookups += 1;
        ops.push('loadActiveKernelClaim');
        // Pre-read sees nothing; recovery read finds the race winner's lease.
        return claimLookups > 1 ? activeClaimRow() : null;
      },
      async insertKernelClaim(_claim) {
        ops.push('insertKernelClaim');
        throw new Error('UNIQUE constraint failed: kernel_claims.issue_id');
      },
    }, ops);

    const result = await broker.runGuardedEvent(claimEvent(), { now: CLAIM_NOW });

    expect(result.decision).toBe('quarantine');
    expect(result.reason).toBe('claim_conflict');
    expect(result.projection).toBe(false);
    expect(ops).toContain('exec:BEGIN IMMEDIATE;');
    expect(ops).toContain('exec:ROLLBACK;');
    expect(ops).not.toContain('exec:COMMIT;');
    expect(ops).toContain('insertKernelConflict');
  });

  test('replays a same-idempotency-key claim race as a duplicate, not a conflict', async () => {
    // A retry of the SAME claim races the winner: its claim insert trips the
    // active-lease index BEFORE the events idempotency index, so the broker must
    // re-read the idempotency winner and replay as a duplicate.
    const ops = [];
    const existingEvent = { id: 'event-existing', idempotency_key: 'claim:issue-1:A' };
    const broker = claimBrokerWith({
      async loadKernelEventByIdempotencyKey() {
        // Pre-read sees nothing; recovery read (inside catch) finds the winner.
        return ops.includes('insertKernelClaim') ? existingEvent : null;
      },
      async insertKernelClaim(_claim) {
        ops.push('insertKernelClaim');
        throw new Error('UNIQUE constraint failed: kernel_claims.issue_id');
      },
    }, ops);

    const result = await broker.runGuardedEvent(claimEvent(), { now: CLAIM_NOW });

    expect(result.decision).toBe('duplicate');
    expect(result.originalEvent).toEqual(existingEvent);
    expect(result.projection).toBe(false);
    expect(ops).toContain('exec:ROLLBACK;');
    expect(ops).not.toContain('exec:COMMIT;');
    expect(ops).not.toContain('insertKernelConflict');
  });

  test('rethrows a non-lease UNIQUE violation (e.g. duplicate claim id) instead of quarantining', async () => {
    const ops = [];
    const broker = claimBrokerWith({
      async insertKernelClaim(_claim) {
        ops.push('insertKernelClaim');
        throw new Error('UNIQUE constraint failed: kernel_claims.id');
      },
    }, ops);

    await expect(broker.runGuardedEvent(claimEvent(), { now: CLAIM_NOW }))
      .rejects.toThrow('UNIQUE constraint failed: kernel_claims.id');
    expect(ops).toContain('exec:ROLLBACK;');
    expect(ops).not.toContain('insertKernelConflict');
  });

  test('quarantines a malformed claim.create with no issue_id instead of persisting an unscoped event', async () => {
    const ops = [];
    const broker = claimBrokerWith({}, ops);

    const result = await broker.runGuardedEvent(
      claimEvent({ payload: { expires_at: '2026-06-18T01:00:00.000Z' } }),
      { now: CLAIM_NOW },
    );

    expect(result.decision).toBe('quarantine');
    expect(result.reason).toBe('invalid_claim_scope');
    expect(result.projection).toBe(false);
    expect(ops).toContain('insertKernelConflict');
    // Nothing is persisted: no transaction, no event/outbox, no claim row.
    expect(ops).not.toContain('exec:BEGIN IMMEDIATE;');
    expect(ops).not.toContain('insertKernelEvent');
    expect(ops).not.toContain('insertKernelClaim');
  });

  test('passes broker config to the transaction exec calls', async () => {
    // A driver constructed without its own databasePath resolves the database
    // from the broker config on every exec, so BEGIN/COMMIT must receive it.
    const ops = [];
    const execConfigs = [];
    const broker = claimBrokerWith({
      async exec(statement, config) { ops.push(`exec:${statement}`); execConfigs.push([statement, config]); },
    }, ops);

    await broker.runGuardedEvent(claimEvent(), { now: CLAIM_NOW });

    for (const statement of ['BEGIN IMMEDIATE;', 'COMMIT;']) {
      const call = execConfigs.find(([s]) => s === statement);
      expect(call).toBeDefined();
      expect(call[1]).toMatchObject({ mode: 'local' });
    }
  });
});
