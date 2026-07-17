'use strict';

// Unit coverage for the grounding context.loaded event store (lib/grounding/
// context-events.js). "This issue's context was loaded" is a pure append to the
// issue's kernel event stream — structurally identical to gate.approved
// (lib/gate-events.js): durable, idempotent, resume-safe, survives across
// processes. This is the state primitive gate.read_first denies against.

const { describe, expect, test } = require('bun:test');

const {
  CONTEXT_LOADED_EVENT,
  contextLoadedIdempotencyKey,
  recordContextLoaded,
  listContextLoadedEvents,
  hasFreshContextLoaded,
  DEFAULT_WINDOW_MS,
} = require('../../lib/grounding/context-events');
const { buildMigratedKernelIssueDeps } = require('../../lib/kernel/cli-broker-factory');

const UNUSED_ROOT = '/unused-because-deps-are-injected';

async function freshKernel() {
  return buildMigratedKernelIssueDeps({ databasePath: ':memory:' });
}

async function seedIssue(kernel, id) {
  const res = await kernel.kernelBroker.runIssueOperation(
    'create',
    ['--id', id, '--title', 'unit', '--type', 'task'],
    { actor: 'seed', origin: 'test' },
  );
  expect(res.ok).toBe(true);
  return res.data.id;
}

function deps(kernel) {
  return { kernelBroker: kernel.kernelBroker, kernelDriver: kernel.kernelDriver };
}

describe('grounding context-events module', () => {
  test('CONTEXT_LOADED_EVENT is the kernel event type', () => {
    expect(CONTEXT_LOADED_EVENT).toBe('context.loaded');
  });

  test('contextLoadedIdempotencyKey scopes to issue+scope+window-bucket', () => {
    expect(contextLoadedIdempotencyKey('i1', 'alice', 42))
      .toBe('context.loaded:i1:alice:42');
  });

  test('recordContextLoaded appends a context.loaded event with the resolved actor', async () => {
    const kernel = await freshKernel();
    const issue = await seedIssue(kernel, 'ctx-basic');

    const result = await recordContextLoaded(UNUSED_ROOT, {
      issueId: issue,
      cmd: 'recap',
      env: { FORGE_ACTOR: 'alice' },
      deps: deps(kernel),
    });

    expect(result.ok).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(result.actor).toBe('alice');
    expect(result.event.event_type).toBe(CONTEXT_LOADED_EVENT);
    expect(result.event.cmd).toBe('recap');
  });

  test('recordContextLoaded is idempotent within a window bucket', async () => {
    const kernel = await freshKernel();
    const issue = await seedIssue(kernel, 'ctx-idem');
    const now = '2026-07-16T12:00:00.000Z';
    const params = {
      issueId: issue,
      cmd: 'recap',
      env: { FORGE_ACTOR: 'alice' },
      deps: deps(kernel),
      now,
    };

    const first = await recordContextLoaded(UNUSED_ROOT, params);
    const second = await recordContextLoaded(UNUSED_ROOT, params);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);

    const events = await listContextLoadedEvents(UNUSED_ROOT, issue, { deps: deps(kernel) });
    expect(events.filter(e => e.event_type === CONTEXT_LOADED_EVENT)).toHaveLength(1);
  });

  test('recordContextLoaded reports a missing issue instead of an orphan event', async () => {
    const kernel = await freshKernel();
    const result = await recordContextLoaded(UNUSED_ROOT, {
      issueId: 'ghost',
      env: { FORGE_ACTOR: 'alice' },
      deps: deps(kernel),
    });
    expect(result.ok).toBe(false);
    expect(result.issueMissing).toBe(true);
  });

  test('hasFreshContextLoaded is false before, true after a recap in the window', async () => {
    const kernel = await freshKernel();
    const issue = await seedIssue(kernel, 'ctx-fresh');
    const now = '2026-07-16T12:00:00.000Z';

    expect(await hasFreshContextLoaded(UNUSED_ROOT, issue, { now, deps: deps(kernel) })).toBe(false);

    await recordContextLoaded(UNUSED_ROOT, {
      issueId: issue, cmd: 'recap', env: { FORGE_ACTOR: 'alice' }, deps: deps(kernel), now,
    });

    expect(await hasFreshContextLoaded(UNUSED_ROOT, issue, { now, deps: deps(kernel) })).toBe(true);
  });

  test('hasFreshContextLoaded re-blocks once the event is older than the window', async () => {
    const kernel = await freshKernel();
    const issue = await seedIssue(kernel, 'ctx-stale');
    const loadedAt = '2026-07-15T12:00:00.000Z';
    await recordContextLoaded(UNUSED_ROOT, {
      issueId: issue, cmd: 'recap', env: { FORGE_ACTOR: 'alice' }, deps: deps(kernel), now: loadedAt,
    });

    // 25h later, with a 24h window -> stale -> re-blocks.
    const later = '2026-07-16T13:00:00.000Z';
    expect(await hasFreshContextLoaded(UNUSED_ROOT, issue, {
      now: later, windowMs: DEFAULT_WINDOW_MS, deps: deps(kernel),
    })).toBe(false);
  });

  test('hasFreshContextLoaded honors Tier-1 session scoping when a session is given', async () => {
    const kernel = await freshKernel();
    const issue = await seedIssue(kernel, 'ctx-session');
    const now = '2026-07-16T12:00:00.000Z';
    await recordContextLoaded(UNUSED_ROOT, {
      issueId: issue, cmd: 'recap', session: 'sess-A', env: { FORGE_ACTOR: 'alice' }, deps: deps(kernel), now,
    });

    // Same session -> pass; a different session -> blocked (even though fresh).
    expect(await hasFreshContextLoaded(UNUSED_ROOT, issue, { session: 'sess-A', now, deps: deps(kernel) })).toBe(true);
    expect(await hasFreshContextLoaded(UNUSED_ROOT, issue, { session: 'sess-B', now, deps: deps(kernel) })).toBe(false);
  });
});
