'use strict';

// Adversarial integration: the exact failure this gate exists to prevent.
// `forge claim <id>` with NO prior `forge recap` MUST be blocked (nonzero exit);
// `forge recap <id>` then `forge claim <id>` MUST pass. Disabling rail.grounding
// or gate.read_first lets the claim through. The claim runner is faked (same seam
// as issue-verify.test.js) so the assertions target the gate, not SQLite; the
// context.loaded state is recorded into a real injected :memory: kernel.

const { describe, test, expect } = require('bun:test');

const { runIssueSubcommand } = require('../../lib/commands/_issue');
const recapCommand = require('../../lib/commands/recap');
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

// A fake claim runner: returns a success envelope so a PASSED gate reaches a
// successful claim. gate.issue_verify is disabled in the injected graph so no
// read-back is attempted.
function fakeClaimRunner() {
  return async (operation, _args, _projectRoot, _deps) => ({
    ok: true,
    schema_version: 'forge.issue.v1',
    command: operation,
    data: { id: 'x', status: 'in_progress', revision: 1 },
    next_commands: [],
  });
}

const GRAPH_ON = () => ({
  rails: [{ id: 'rail.grounding', enabled: true }],
  gates: [{ id: 'gate.read_first', enabled: true }, { id: 'gate.issue_verify', enabled: false }],
});

function claimOpts(kernel, extra = {}) {
  return {
    issueBackend: 'kernel',
    env: { FORGE_ACTOR: 'alice' },
    runIssueOperation: fakeClaimRunner(),
    kernelBroker: kernel.kernelBroker,
    kernelDriver: kernel.kernelDriver,
    resolveRuntimeGraph: GRAPH_ON,
    ...extra,
  };
}

describe('gate.read_first hard-blocks forge claim', () => {
  test('claim WITHOUT a prior recap is blocked (nonzero exit, remedy in message)', async () => {
    const kernel = await freshKernel();
    const issue = await seedIssue(kernel, 'claim-noread');

    const result = await runIssueSubcommand('claim', [issue], ROOT, claimOpts(kernel));

    expect(result.success).toBe(false);
    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.error).toContain(`forge recap ${issue}`);
  });

  test('recap THEN claim passes (recap records context.loaded, gate clears)', async () => {
    const kernel = await freshKernel();
    const issue = await seedIssue(kernel, 'claim-afterread');
    const now = '2026-07-16T12:00:00.000Z';

    // forge recap <id> -> appends context.loaded to the injected kernel.
    const recap = await recapCommand.handler([issue], {}, ROOT, {
      kernelBroker: kernel.kernelBroker,
      kernelDriver: kernel.kernelDriver,
      env: { FORGE_ACTOR: 'alice' },
      now,
    });
    expect(recap.success).toBe(true);

    const result = await runIssueSubcommand('claim', [issue], ROOT, claimOpts(kernel, { now }));
    expect(result.success).not.toBe(false);
  });

  test('rail.grounding disabled -> claim allowed without a recap', async () => {
    const kernel = await freshKernel();
    const issue = await seedIssue(kernel, 'claim-railoff');
    const graphOff = () => ({
      rails: [{ id: 'rail.grounding', enabled: false }],
      gates: [{ id: 'gate.read_first', enabled: true }, { id: 'gate.issue_verify', enabled: false }],
    });
    const result = await runIssueSubcommand('claim', [issue], ROOT, claimOpts(kernel, { resolveRuntimeGraph: graphOff }));
    expect(result.success).not.toBe(false);
  });

  test('gate.read_first disabled -> claim allowed without a recap', async () => {
    const kernel = await freshKernel();
    const issue = await seedIssue(kernel, 'claim-gateoff');
    const graphOff = () => ({
      rails: [{ id: 'rail.grounding', enabled: true }],
      gates: [{ id: 'gate.read_first', enabled: false }, { id: 'gate.issue_verify', enabled: false }],
    });
    const result = await runIssueSubcommand('claim', [issue], ROOT, claimOpts(kernel, { resolveRuntimeGraph: graphOff }));
    expect(result.success).not.toBe(false);
  });
});
