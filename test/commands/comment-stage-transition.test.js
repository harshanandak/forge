'use strict';

// 5a5ba3a6: a kernel `comment` carrying the Descriptive Context Convention's
// `stage: <from> -> <to>` line auto-records a stage_run (complete from, start to)
// through the real runIssueSubcommand dispatch — proving the wiring, not just the
// helper. Uses the injectable runIssueOperation + a fake kernelDriver so no DB is
// needed; the assertions are on what the driver was asked to record.

const { describe, test, expect } = require('bun:test');
const { runIssueSubcommand } = require('../../lib/commands/_issue');

function fakeKernelDriver() {
  const stageCalls = [];
  return {
    stageCalls,
    recordStageRun(input) {
      stageCalls.push(input);
      return { id: `row-${stageCalls.length}`, ...input };
    },
  };
}

function kernelOpts(driver, extra = {}) {
  return {
    useKernelBroker: true,
    issueBackend: 'kernel',
    kernelDriver: driver,
    // Fake runner returns the kernel-contract mutation shape (ok:true + data.id).
    runIssueOperation: async () => ({
      ok: true,
      data: { id: 'forge-full-id', revision: 1, comment_id: 'c1' },
    }),
    // Keep check-after-write out of the way; the stage hook is independent of it.
    isIssueVerifyEnabled: () => false,
    resolveRuntimeGraph: () => ({}),
    env: { FORGE_JSON: '1' },
    ...extra,
  };
}

describe('comment auto-records stage_runs (5a5ba3a6)', () => {
  test('a stage-transition comment completes from-stage and starts to-stage', async () => {
    const driver = fakeKernelDriver();
    await runIssueSubcommand(
      'comment',
      ['forge-full-id', 'stage: dev -> validate\nsummary: all tasks done'],
      '/repo',
      kernelOpts(driver),
    );

    expect(driver.stageCalls).toEqual([
      { issue_id: 'forge-full-id', stage: 'dev', action: 'complete' },
      { issue_id: 'forge-full-id', stage: 'validate', action: 'start' },
    ]);
  });

  test('a plain comment records no stage_run', async () => {
    const driver = fakeKernelDriver();
    await runIssueSubcommand(
      'comment',
      ['forge-full-id', 'just a normal handoff note'],
      '/repo',
      kernelOpts(driver),
    );
    expect(driver.stageCalls).toEqual([]);
  });

  test('a driver failure never breaks the comment', async () => {
    const throwingDriver = {
      recordStageRun() {
        throw new Error('db locked');
      },
    };
    const result = await runIssueSubcommand(
      'comment',
      ['forge-full-id', 'stage: dev -> validate'],
      '/repo',
      kernelOpts(throwingDriver),
    );
    // The comment result still comes back successful (contract ok:true).
    const parsed = typeof result.output === 'string' ? JSON.parse(result.output) : result;
    expect(parsed.ok).toBe(true);
  });
});
