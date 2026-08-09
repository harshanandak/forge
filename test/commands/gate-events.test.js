'use strict';

// Gates-as-kernel-EVENTS (Fable's key insight): a human gate is satisfied by a
// durable, queryable, resume-safe `gate.approved` kernel event on the issue — NOT
// by skill prose. These tests drive the `forge gate approve|reject|status|check`
// surface against a REAL issue in a FRESH kernel (in-memory SQLite), proving:
//   (a) check is UNSATISFIED with no approval + gate enabled,
//   (b) check is SATISFIED after approve,
//   (c) approving twice is idempotent (one event),
//   (d) check is SATISFIED when the gate is DISABLED (no approval needed),
//   (e) status --json reflects approve + reject events with actor.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');

const gateCommand = require('../../lib/commands/gate');
const { buildMigratedKernelIssueDeps } = require('../../lib/kernel/cli-broker-factory');

const tempRoots = [];

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gate-events-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  return root;
}

// A fresh, migrated in-memory kernel. Reusing the SAME driver/broker keeps the
// single :memory: connection alive across every gate call in a test.
async function freshKernel() {
  return buildMigratedKernelIssueDeps({ databasePath: ':memory:' });
}

async function seedIssue(deps, id) {
  const res = await deps.kernelBroker.runIssueOperation(
    'create',
    ['--id', id, '--title', 'Gate events test', '--type', 'task'],
    { actor: 'seed', origin: 'test' },
  );
  expect(res.ok).toBe(true);
  return res.data.id;
}

// Inject the shared kernel (and a deterministic actor) into the gate handler.
function opts(deps, actor = 'alice') {
  return {
    kernelBroker: deps.kernelBroker,
    kernelDriver: deps.kernelDriver,
    env: { FORGE_ACTOR: actor },
    now: '2026-08-09T10:00:00.000Z',
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('forge gate events (approve/reject/status/check)', () => {
  test('(a) check is UNSATISFIED with no approval and the gate enabled', async () => {
    const root = makeProject();
    const deps = await freshKernel();
    const issue = await seedIssue(deps, 'forge-gate-a');

    const result = await gateCommand.handler(['check', issue, 'gate.plan-approval'], {}, root, opts(deps));
    expect(result.success).toBe(false);
    expect(result.error).toContain('gate.plan-approval');
    expect(result.error).toContain(issue);
  });

  test('(b) check is SATISFIED after gate approve', async () => {
    const root = makeProject();
    const deps = await freshKernel();
    const issue = await seedIssue(deps, 'forge-gate-b');

    const approve = await gateCommand.handler(['approve', issue, 'gate.plan-approval'], {}, root, opts(deps));
    expect(approve.success).toBe(true);

    const check = await gateCommand.handler(['check', issue, 'gate.plan-approval'], {}, root, opts(deps));
    expect(check.success).toBe(true);
  });

  test('(c) approving twice is idempotent — one event, status shows a single approval', async () => {
    const root = makeProject();
    const deps = await freshKernel();
    const issue = await seedIssue(deps, 'forge-gate-c');

    const first = await gateCommand.handler(['approve', issue, 'gate.plan-approval'], {}, root, opts(deps));
    expect(first.success).toBe(true);
    const second = await gateCommand.handler(['approve', issue, 'gate.plan-approval'], {}, root, opts(deps));
    expect(second.success).toBe(true);
    expect(second.duplicate).toBe(true);

    const status = await gateCommand.handler(['status', issue, '--json'], { json: true }, root, opts(deps));
    const parsed = JSON.parse(status.output);
    const approvals = parsed.events.filter(
      e => e.event_type === 'gate.approved' && e.gate === 'gate.plan-approval',
    );
    expect(approvals).toHaveLength(1);
    expect(approvals[0].actor).toBe('alice');
  });

  test('(d) check is SATISFIED when the gate is DISABLED, without any approval event', async () => {
    const root = makeProject();
    const deps = await freshKernel();
    const issue = await seedIssue(deps, 'forge-gate-d');

    // Toggle the gate OFF via the shipped config writer + resolver.
    const disable = await gateCommand.handler(['disable', 'gate.plan-approval'], {}, root);
    expect(disable.success).toBe(true);

    const check = await gateCommand.handler(['check', issue, 'gate.plan-approval'], {}, root, opts(deps));
    expect(check.success).toBe(true);
  });

  test('(e) status --json reflects approve + reject events with actor', async () => {
    const root = makeProject();
    const deps = await freshKernel();
    const issue = await seedIssue(deps, 'forge-gate-e');

    await gateCommand.handler(['approve', issue, 'gate.intent'], {}, root, opts(deps, 'alice'));
    await gateCommand.handler(['reject', issue, 'gate.merge'], { reason: 'needs rework' }, root, opts(deps, 'bob'));

    const status = await gateCommand.handler(['status', issue, '--json'], { json: true }, root, opts(deps));
    const parsed = JSON.parse(status.output);

    const approved = parsed.events.find(e => e.event_type === 'gate.approved' && e.gate === 'gate.intent');
    const rejected = parsed.events.find(e => e.event_type === 'gate.rejected' && e.gate === 'gate.merge');

    expect(approved).toBeDefined();
    expect(approved.actor).toBe('alice');
    expect(rejected).toBeDefined();
    expect(rejected.actor).toBe('bob');
    expect(rejected.reason).toBe('needs rework');
  });

  test('rejects an unknown gate id at write time (approve)', async () => {
    const root = makeProject();
    const deps = await freshKernel();
    const issue = await seedIssue(deps, 'forge-gate-unknown');

    const result = await gateCommand.handler(['approve', issue, 'gate.does-not-exist'], {}, root, opts(deps));
    expect(result.success).toBe(false);
    expect(result.error).toContain('gate.does-not-exist');
  });

  test('errors clearly when the issue does not exist (approve)', async () => {
    const root = makeProject();
    const deps = await freshKernel();

    const result = await gateCommand.handler(['approve', 'no-such-issue', 'gate.plan-approval'], {}, root, opts(deps));
    expect(result.success).toBe(false);
    expect(result.error).toContain('no-such-issue');
  });

  test('approve --ttl stores bounded expiry and status exposes the stable authority fields', async () => {
    const root = makeProject();
    const deps = await freshKernel();
    const issue = await seedIssue(deps, 'forge-gate-ttl');

    const approve = await gateCommand.handler(
      ['approve', issue, 'gate.merge'], { ttl: '5m' }, root, opts(deps),
    );
    expect(approve.success).toBe(true);

    const status = await gateCommand.handler(['status', issue], { json: true }, root, opts(deps));
    const event = JSON.parse(status.output).events[0];
    expect(event).toMatchObject({
      issue_id: issue,
      gate: 'gate.merge',
      control_id: `gate:${issue}:gate.merge`,
      actor: 'alice',
      decision: 'approved',
      issued_at: '2026-08-09T10:00:00.000Z',
      expires_at: '2026-08-09T10:05:00.000Z',
    });

    const check = await gateCommand.handler(['check', issue, 'gate.merge'], {}, root, opts(deps));
    expect(check.success).toBe(true);
    expect(check.event).toMatchObject({
      issue_id: issue,
      gate: 'gate.merge',
      control_id: `gate:${issue}:gate.merge`,
      actor: 'alice',
      decision: 'approved',
      issued_at: '2026-08-09T10:00:00.000Z',
      expires_at: '2026-08-09T10:05:00.000Z',
    });
  });

  test('check fails closed at expiry and after a later rejection', async () => {
    const root = makeProject();
    const deps = await freshKernel();
    const issue = await seedIssue(deps, 'forge-gate-expired');
    await gateCommand.handler(['approve', issue, 'gate.merge'], { ttl: '1m' }, root, opts(deps));

    const expiredOpts = { ...opts(deps), now: '2026-08-09T10:01:00.000Z' };
    expect((await gateCommand.handler(['check', issue, 'gate.merge'], {}, root, expiredOpts)).success).toBe(false);

    const liveIssue = await seedIssue(deps, 'forge-gate-rejected');
    await gateCommand.handler(['approve', liveIssue, 'gate.merge'], {}, root, opts(deps));
    await gateCommand.handler(['reject', liveIssue, 'gate.merge'], {}, root, {
      ...opts(deps), now: '2026-08-09T10:01:00.000Z',
    });
    expect((await gateCommand.handler(['check', liveIssue, 'gate.merge'], {}, root, {
      ...opts(deps), now: '2026-08-09T10:02:00.000Z',
    })).success).toBe(false);
  });

  test('invalid TTL inputs fail closed without recording approval', async () => {
    const root = makeProject();
    const deps = await freshKernel();
    const issue = await seedIssue(deps, 'forge-gate-invalid-ttl');

    for (const ttl of ['', '0m', '-1m', 'later', '999999999d']) {
      const result = await gateCommand.handler(
        ['approve', issue, 'gate.merge'], { ttl }, root, opts(deps),
      );
      expect(result.success).toBe(false);
    }
    expect((await gateCommand.handler(
      ['approve', issue, 'gate.merge', '--ttl'], {}, root, opts(deps),
    )).success).toBe(false);
    const status = await gateCommand.handler(['status', issue], { json: true }, root, opts(deps));
    expect(JSON.parse(status.output).events).toHaveLength(0);
  });
});
