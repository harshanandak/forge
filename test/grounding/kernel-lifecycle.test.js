'use strict';

// Regression coverage for the driver-lifecycle invariant behind the Windows
// EBUSY bug (follow-up to #410): the grounding event store builds a fresh kernel
// on every `forge recap`/`show`/`claim` when no kernel is injected, and MUST
// close that SQLite driver — an unclosed handle locks the DB directory on
// Windows so a later `fs.rmSync` throws `EBUSY: resource busy or locked`
// (observed at test/orientation.test.js:106). Equally important: an INJECTED
// (shared) kernel must NEVER be closed — the caller/orchestrator owns it, and
// closing it would break the next operation that reuses it.
//
// These assertions are cross-platform (they count close() calls) and complement
// the end-to-end Windows guard in test/orientation.test.js.

const { describe, expect, test } = require('bun:test');

const {
  recordContextLoaded,
  readFirstVerdict,
  listContextLoadedEvents,
} = require('../../lib/grounding/context-events');
const { buildMigratedKernelIssueDeps } = require('../../lib/kernel/cli-broker-factory');

const ROOT = '/unused-because-deps-are-injected';

async function freshKernel() {
  return buildMigratedKernelIssueDeps({ databasePath: ':memory:' });
}
async function seedIssue(kernel, id) {
  const res = await kernel.kernelBroker.runIssueOperation(
    'create', ['--id', id, '--title', 'unit', '--type', 'task'], { actor: 'seed', origin: 'test' },
  );
  expect(res.ok).toBe(true);
  return res.data.id;
}

// Wrap a driver so its methods still hit the real :memory: kernel, but close()
// is counted instead of actually closing (so the shared db stays usable across
// assertions).
function withCloseCounter(driver) {
  const counter = { count: 0 };
  const wrapped = {};
  for (const key of Object.keys(driver)) {
    wrapped[key] = typeof driver[key] === 'function' ? driver[key].bind(driver) : driver[key];
  }
  wrapped.close = () => { counter.count += 1; };
  // dispose closes the REAL driver so the underlying SQLite handle is released
  // during teardown (unclosed handles lock the DB dir on Windows -> rmSync EBUSY).
  return { driver: wrapped, counter, dispose: () => driver.close() };
}

describe('grounding kernel-driver lifecycle', () => {
  test('an INJECTED/shared kernel is NEVER closed (caller owns it)', async () => {
    const kernel = await freshKernel();
    const { driver, counter, dispose } = withCloseCounter(kernel.kernelDriver);
    try {
      const issue = await seedIssue(kernel, 'life-injected');
      const deps = { kernelBroker: kernel.kernelBroker, kernelDriver: driver };

      await recordContextLoaded(ROOT, { issueId: issue, cmd: 'recap', env: { FORGE_ACTOR: 'a' }, deps });
      await readFirstVerdict(ROOT, issue, { deps });

      expect(counter.count).toBe(0);
      // The shared kernel is still usable afterwards (would throw if we'd closed it).
      const events = await listContextLoadedEvents(ROOT, issue, { deps });
      expect(events.length).toBeGreaterThan(0);
    } finally {
      dispose(); // always close the REAL driver so teardown can rmSync the DB dir
    }
  });

  test('a kernel the module BUILT itself is closed after each read/append', async () => {
    const kernel = await freshKernel();
    const { driver, counter, dispose } = withCloseCounter(kernel.kernelDriver);
    try {
      const issue = await seedIssue(kernel, 'life-owned');
      // kernelBuilder is the test seam over buildMigratedKernelIssueDeps — supplying
      // it (without kernelBroker/kernelDriver) drives the OWNED path.
      const deps = { kernelBuilder: async () => ({ kernelBroker: kernel.kernelBroker, kernelDriver: driver }) };

      await recordContextLoaded(ROOT, { issueId: issue, cmd: 'recap', env: { FORGE_ACTOR: 'a' }, deps });
      expect(counter.count).toBe(1);

      await readFirstVerdict(ROOT, issue, { deps });
      expect(counter.count).toBe(2);
    } finally {
      dispose(); // always close the REAL driver so teardown can rmSync the DB dir
    }
  });

  test('the built kernel is closed even when the issue is missing', async () => {
    const kernel = await freshKernel();
    const { driver, counter, dispose } = withCloseCounter(kernel.kernelDriver);
    try {
      const deps = { kernelBuilder: async () => ({ kernelBroker: kernel.kernelBroker, kernelDriver: driver }) };

      const result = await recordContextLoaded(ROOT, { issueId: 'ghost', env: { FORGE_ACTOR: 'a' }, deps });
      expect(result.issueMissing).toBe(true);
      expect(counter.count).toBe(1); // finally still closes on the early return
    } finally {
      dispose(); // always close the REAL driver so teardown can rmSync the DB dir
    }
  });
});
