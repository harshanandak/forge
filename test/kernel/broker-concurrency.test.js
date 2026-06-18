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
});
