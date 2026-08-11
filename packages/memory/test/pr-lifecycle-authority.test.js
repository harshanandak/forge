'use strict';

const { describe, expect, test } = require('bun:test');
const {
  computeContentHash,
  validateContractStructure,
} = require('@forge/memory-contracts');
const { createPrLifecycleAuthority } = require('../src/pr-lifecycle-authority');

const ISSUE_ID = 'issue-1';
const REPOSITORY_ID = 'github.com/example/forge';
const HEAD = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);
const CONFIG_REVISION = 'config-1';
const NOW = '2026-08-11T00:00:00.000Z';

function packet(overrides = {}) {
  const basePayload = {
    issue_id: ISSUE_ID,
    expected_issue_revision: 7,
    packet_id: 'packet-1',
    packet_revision: 1,
    repository_id: REPOSITORY_ID,
    target_head: HEAD,
    objective: 'merge a ready PR',
    authority: { kind: 'kernel', issue_revision: 7 },
    allowed_mutations: ['pr.merge'],
    workflow_config_revision: CONFIG_REVISION,
    capability_manifest_digest: DIGEST,
    risk: { status: 'approved', revision: 'risk-1' },
    risk_manifest_digest: 'c'.repeat(64),
    receipt_requirements: { terminal: true, gate_ids: ['gate-1'] },
  };
  const value = {
    schema_id: 'forge.memory.work-packet.v1',
    schema_version: 1,
    object_id: '4c9d9e6a-4f14-47e7-aac8-9ec7731aa523',
    created_at: NOW,
    producer: {
      product_id: 'forge-memory',
      product_version: '0.1.0-beta.6',
      instance_id: 'authority-test',
    },
    capabilities_used: [],
    provenance: { source_kind: 'kernel', actor_class: 'agent', actor_id: 'agent-1' },
    payload: basePayload,
    extensions: {},
    ...overrides,
  };
  value.payload = { ...basePayload, ...(overrides.payload || {}) };
  value.content_hash = computeContentHash(value);
  return value;
}

function receipt(workPacket, overrides = {}) {
  const basePayload = {
    packet_hash: workPacket.content_hash,
    run_id: 'run-1',
    attempt_id: 'attempt-1',
    exact_head: workPacket.payload.target_head,
    packet_revision: workPacket.payload.packet_revision,
    manifest_digest: workPacket.payload.capability_manifest_digest,
    workflow_config_revision: workPacket.payload.workflow_config_revision,
    status: 'PASS',
    executor: { product_id: 'forge-flow', mode: 'test' },
    started_at: NOW,
    ended_at: NOW,
    evidence_refs: [{ kind: 'terminal', status: 'PASS' }],
    validation: { status: 'PASS', terminal: true },
    cleanup: { status: 'PASS', terminal: true },
    mutations_attempted: ['pr.merge'],
    mutations_authorized: ['pr.merge'],
  };
  const value = {
    schema_id: 'forge.memory.run-receipt.v1',
    schema_version: 1,
    object_id: 'f1f99076-d454-4954-acb4-77286b5b206d',
    created_at: NOW,
    producer: {
      product_id: 'forge-flow',
      product_version: '0.1.0-beta.6',
      instance_id: 'run-1',
    },
    capabilities_used: [],
    provenance: { source_kind: 'flow', actor_class: 'agent', actor_id: 'agent-1' },
    payload: basePayload,
    extensions: {},
    ...overrides,
  };
  value.payload = { ...basePayload, ...(overrides.payload || {}) };
  value.content_hash = computeContentHash(value);
  return value;
}

function provider(overrides = {}) {
  return {
    runIssueOperation: async () => null,
    recordPrLinkage: async () => ({ ok: true }),
    readTrace: async () => ({ ok: true }),
    readIssue: async () => ({ id: ISSUE_ID, revision: 7, status: 'open', ready: true }),
    readOwnership: async () => ({ owned: true, actor_id: 'agent-1', session_id: 'session-1' }),
    readHead: async () => ({ repository_id: REPOSITORY_ID, head: HEAD }),
    readCapability: async () => ({ digest: DIGEST, approved: true, config_revision: CONFIG_REVISION }),
    readRisk: async () => ({ approved: true, digest: 'c'.repeat(64) }),
    readGates: async () => ({ complete: true, approved: true, ids: ['gate-1'] }),
    recordRunReceipt: async (value) => ({ accepted: true, receipt: value }),
    merge: async (value) => ({ merged: true, linkage: value }),
    ready: async () => ([{ id: 'first', rank: 1 }, { id: 'second', rank: 2 }]),
    ...overrides,
  };
}

describe('public PR lifecycle authority', () => {
  test('RED: exposes an injected facade without private imports', () => {
    const authority = createPrLifecycleAuthority({ provider: provider() });
    expect(typeof authority.issueWorkPacket).toBe('function');
    expect(typeof authority.acceptRunReceipt).toBe('function');
    expect(typeof authority.mergeWorkPacket).toBe('function');
    expect(typeof authority.requestNextWork).toBe('function');
  });

  test('issues a hash-valid packet only after live readiness and ownership checks', async () => {
    const calls = [];
    const authority = createPrLifecycleAuthority({
      provider: provider({
        readIssue: async (...args) => { calls.push('issue'); return provider().readIssue(...args); },
        readOwnership: async (...args) => { calls.push('ownership'); return provider().readOwnership(...args); },
      }),
    });
    const result = await authority.issueWorkPacket({ issue_id: ISSUE_ID, repository_id: REPOSITORY_ID });
    expect(validateContractStructure(result.packet).ok).toBe(true);
    expect(result.packet.payload.target_head).toBe(HEAD);
    expect(calls).toEqual(['issue', 'ownership']);
    expect(result.packet.payload).not.toHaveProperty('lease_epoch');
  });

  test('fails closed when ownership is stale at issuance', async () => {
    const authority = createPrLifecycleAuthority({ provider: provider({ readOwnership: async () => ({ owned: false }) }) });
    await expect(authority.issueWorkPacket({ issue_id: ISSUE_ID, repository_id: REPOSITORY_ID }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_OWNERSHIP_STALE' });
  });

  test('re-probes ownership and exact head at receipt acceptance', async () => {
    const workPacket = packet();
    const runReceipt = receipt(workPacket);
    const ownershipLost = createPrLifecycleAuthority({ provider: provider({ readOwnership: async () => ({ owned: false }) }) });
    await expect(ownershipLost.acceptRunReceipt({ packet: workPacket, receipt: runReceipt }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_OWNERSHIP_STALE' });
    const headDrifted = createPrLifecycleAuthority({ provider: provider({ readHead: async () => ({ repository_id: REPOSITORY_ID, head: 'd'.repeat(40) }) }) });
    await expect(headDrifted.acceptRunReceipt({ packet: workPacket, receipt: runReceipt }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_HEAD_STALE' });
  });

  test('rejects unavailable capability, risk, or gate evidence', async () => {
    const workPacket = packet();
    const runReceipt = receipt(workPacket);
    for (const [method, value, code] of [
      ['readCapability', { digest: DIGEST, approved: false, config_revision: CONFIG_REVISION }, 'PR_LIFECYCLE_CAPABILITY_INVALID'],
      ['readRisk', { approved: true }, 'PR_LIFECYCLE_CONTRACT_INVALID'],
      ['readGates', { complete: false, approved: true, ids: ['gate-1'] }, 'PR_LIFECYCLE_GATE_INVALID'],
    ]) {
      const authority = createPrLifecycleAuthority({ provider: provider({ [method]: async () => value }) });
      await expect(authority.acceptRunReceipt({ packet: workPacket, receipt: runReceipt }))
        .rejects.toMatchObject({ code });
    }
  });

  test('accepts a PASS receipt only with fresh ownership and terminal mutation evidence', async () => {
    const workPacket = packet();
    const authority = createPrLifecycleAuthority({ provider: provider() });
    const result = await authority.acceptRunReceipt({ packet: workPacket, receipt: receipt(workPacket) });
    expect(result.accepted).toBe(true);
    expect(result.linkage).toMatchObject({ issue_id: ISSUE_ID, repository_id: REPOSITORY_ID, head: HEAD });
  });

  test('rejects malformed or stale receipts before recording', async () => {
    let recorded = 0;
    const workPacket = packet();
    const authority = createPrLifecycleAuthority({
      provider: provider({
        recordRunReceipt: async () => { recorded += 1; },
      }),
    });
    const malformed = { ...receipt(workPacket), content_hash: 'd'.repeat(64) };
    await expect(authority.acceptRunReceipt({ packet: workPacket, receipt: malformed }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_CONTRACT_INVALID' });
    expect(recorded).toBe(0);
  });

  test('rejects unauthorized mutation, incomplete terminal evidence, and deferred lease epochs', async () => {
    const workPacket = packet();
    const authority = createPrLifecycleAuthority({ provider: provider() });
    await expect(authority.acceptRunReceipt({
      packet: workPacket,
      receipt: receipt(workPacket, { payload: { mutations_attempted: ['files'], mutations_authorized: ['files'] } }),
    })).rejects.toMatchObject({ code: 'PR_LIFECYCLE_MUTATION_UNAUTHORIZED' });
    await expect(authority.acceptRunReceipt({
      packet: workPacket,
      receipt: receipt(workPacket, { payload: { cleanup: { status: 'INCOMPLETE' } } }),
    })).rejects.toMatchObject({ code: 'PR_LIFECYCLE_TERMINAL_INVALID' });
    await expect(authority.acceptRunReceipt({
      packet: workPacket,
      receipt: receipt(workPacket, { payload: { lease_epoch: 1 } }),
    })).rejects.toMatchObject({ code: 'PR_LIFECYCLE_AUTHORITY_UNSUPPORTED' });
  });

  test('replays identical receipts idempotently but rejects divergent identity/content', async () => {
    let recorded = 0;
    const workPacket = packet();
    const authority = createPrLifecycleAuthority({
      provider: provider({
        recordRunReceipt: async (value) => { recorded += 1; return { accepted: true, receipt: value }; },
      }),
    });
    const first = await authority.acceptRunReceipt({ packet: workPacket, receipt: receipt(workPacket) });
    const replay = await authority.acceptRunReceipt({ packet: structuredClone(workPacket), receipt: receipt(workPacket) });
    expect(replay).toEqual(first);
    expect(recorded).toBe(1);
    const divergent = receipt(workPacket, { payload: { attempt_id: 'attempt-2' } });
    await expect(authority.acceptRunReceipt({ packet: workPacket, receipt: divergent }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_REPLAY_CONFLICT' });
  });

  test('merges only from accepted packet/receipt linkage and re-probes ownership', async () => {
    let merges = 0;
    const workPacket = packet();
    const runReceipt = receipt(workPacket);
    const authority = createPrLifecycleAuthority({
      provider: provider({ merge: async (value) => { merges += 1; return { merged: true, linkage: value }; } }),
    });
    await authority.acceptRunReceipt({ packet: workPacket, receipt: runReceipt });
    const result = await authority.mergeWorkPacket({ packet: workPacket, receipt: runReceipt });
    expect(result.merged).toBe(true);
    expect(merges).toBe(1);
    expect(result.linkage).toMatchObject({ issue_id: ISSUE_ID, repository_id: REPOSITORY_ID, head: HEAD });
  });

  test('returns provider ready order without reranking', async () => {
    const ready = [{ id: 'z', rank: 10 }, { id: 'a', rank: 1 }];
    const authority = createPrLifecycleAuthority({ provider: provider({ ready: async () => ready }) });
    const result = await authority.requestNextWork();
    expect(result).toEqual(ready);
  });

  test('uses the public runIssueOperation seam when optional live reads are not direct methods', async () => {
    const base = provider();
    for (const method of ['readIssue', 'readOwnership', 'readHead', 'readCapability', 'readRisk', 'readGates']) {
      delete base[method];
    }
    base.runIssueOperation = async (operation, args) => {
      if (operation === 'show') return { ok: true, data: { id: args[0], revision: 7, status: 'open', ready: true } };
      if (operation === 'owns') return { ok: true, data: { owned: true, actor_id: 'agent-1' } };
      if (operation === 'readHead') return { repository_id: REPOSITORY_ID, head: HEAD };
      if (operation === 'readCapability') return { digest: DIGEST, approved: true, config_revision: CONFIG_REVISION };
      if (operation === 'readRisk') return { approved: true, digest: 'c'.repeat(64) };
      if (operation === 'readGates') return { complete: true, approved: true, ids: ['gate-1'] };
      throw new Error(`unexpected operation ${operation}`);
    };
    const authority = createPrLifecycleAuthority({ provider: base });
    const result = await authority.issueWorkPacket({ issue_id: ISSUE_ID, repository_id: REPOSITORY_ID });
    expect(result.packet.payload.target_head).toBe(HEAD);
  });

  test('uses the public recordPrLinkage operation for merge persistence', async () => {
    const calls = [];
    const base = provider({
      merge: undefined,
      recordPrLinkage: async (value) => { calls.push(value); return { link: { id: 'pr-1' } }; },
    });
    const workPacket = packet({ payload: {
      target: { pr_number: 514, branch: 'codex/test', git_common_dir: '/repo/.git', url: 'https://example.test/pull/514' },
      allowed_mutations: ['pr.merge', 'pr.merged'],
    } });
    const runReceipt = receipt(workPacket, { payload: {
      mutations_attempted: ['pr.merge'],
      mutations_authorized: ['pr.merge'],
    } });
    const authority = createPrLifecycleAuthority({ provider: base });
    await authority.acceptRunReceipt({ packet: workPacket, receipt: runReceipt });
    await authority.mergeWorkPacket({ packet: workPacket, receipt: runReceipt });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ phase: 'merged', repo: REPOSITORY_ID, number: 514 });
    expect(calls[0].work_packet).toEqual(workPacket);
    expect(calls[0].run_receipt).toEqual(runReceipt);
  });

  test('reads the public trace seam before using accepted linkage for merge', async () => {
    let traceReads = 0;
    const workPacket = packet();
    const runReceipt = receipt(workPacket);
    const authority = createPrLifecycleAuthority({
      provider: provider({ readTrace: async () => { traceReads += 1; return { ok: true }; } }),
    });
    await authority.acceptRunReceipt({ packet: workPacket, receipt: runReceipt });
    await authority.mergeWorkPacket({ packet: workPacket, receipt: runReceipt });
    expect(traceReads).toBe(1);
  });
});
