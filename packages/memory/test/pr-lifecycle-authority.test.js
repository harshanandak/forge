'use strict';

const { describe, expect, test } = require('bun:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const {
  computeContentHash,
  validateContractStructure,
} = require('@forge/memory-contracts');
const {
  PR_LIFECYCLE_PROVIDER_METHODS,
  PrLifecycleAuthorityError,
  createPrLifecycleAuthority,
} = require('../src/pr-lifecycle-authority');

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
    allowed_mutations: ['pr.merged'],
    workflow_config_revision: CONFIG_REVISION,
    capability_manifest_digest: DIGEST,
    risk: { status: 'approved', revision: 'risk-1' },
    risk_manifest_digest: 'c'.repeat(64),
    target: { pr_number: 514, branch: 'codex/test', git_common_dir: '/repo/.git', url: 'https://example.test/pull/514' },
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
    provenance: {
      source_kind: 'kernel', actor_class: 'agent', actor_id: 'agent-1',
    },
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
    mutations_attempted: ['pr.merged'],
    mutations_authorized: ['pr.merged'],
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
  let durable = null;
  const overrideRecordPrLinkage = overrides.recordPrLinkage;
  const base = {
    runIssueOperation: async () => null,
    recordPrLinkage: async (value) => { durable = value; return { ok: true }; },
    readTrace: async () => {
      if (!durable) return { pull_requests: [] };
      if (durable.packet.payload.target?.pr_number) return { pull_requests: [{
        number: durable.packet.payload.target.pr_number,
        repo: durable.packet.payload.repository_id,
        head_sha: durable.packet.payload.target_head,
        issue_id: durable.packet.payload.issue_id,
        iterations: [{ work_packet_hash: durable.packet.content_hash, run_receipt_hash: durable.receipt.content_hash }],
      }] };
      return { iterations: [{ work_packet_hash: durable.packet.content_hash, run_receipt_hash: durable.receipt.content_hash }] };
    },
    readIssue: async () => ({ id: ISSUE_ID, revision: 7, status: 'open', ready: true }),
    readOwnership: async () => ({ owned: true, actor_id: 'agent-1', session_id: 'session-1' }),
    readHead: async () => ({ repository_id: REPOSITORY_ID, head: HEAD }),
    readCapability: async () => ({ digest: DIGEST, approved: true, available: true, probed: true, expires_at: '2099-01-01T00:00:00.000Z', config_revision: CONFIG_REVISION }),
    readRisk: async () => ({ approved: true, digest: 'c'.repeat(64) }),
    readGates: async () => ({ complete: true, approved: true, ids: ['gate-1'] }),
    mergePr: async (value) => ({ merged: true, linkage: value }),
    listReadyWork: async () => ([{ id: 'first', rank: 1 }, { id: 'second', rank: 2 }]),
    ...overrides,
  };
  base.recordPrLinkage = async (value) => {
    durable = value.work_packet && value.run_receipt
      ? { packet: value.work_packet, receipt: value.run_receipt }
      : durable;
    return overrideRecordPrLinkage ? overrideRecordPrLinkage(value) : { accepted: true };
  };
  return base;
}

describe('public PR lifecycle authority', () => {
  test('RED: exposes an injected facade without private imports', () => {
    const authority = createPrLifecycleAuthority({ provider: provider() });
    expect(typeof authority.issueWorkPacket).toBe('function');
    expect(typeof authority.acceptRunReceipt).toBe('function');
    expect(typeof authority.mergeWorkPacket).toBe('function');
    expect(typeof authority.requestNextWork).toBe('function');
  });

  test('exports only the canonical public lifecycle provider methods', () => {
    expect(PR_LIFECYCLE_PROVIDER_METHODS).toEqual([
      'readIssue',
      'readOwnership',
      'readHead',
      'readCapability',
      'readRisk',
      'readGates',
      'mergePr',
      'listReadyWork',
      'runIssueOperation',
      'recordPrLinkage',
      'readTrace',
    ]);
  });

  test('pins receipt requirements to live terminal gates and rejects non-objects', async () => {
    const authority = createPrLifecycleAuthority({ provider: provider() });
    const issued = await authority.issueWorkPacket({
      issue_id: ISSUE_ID,
      repository_id: REPOSITORY_ID,
      actor_id: 'agent-1',
      receipt_requirements: { terminal: false, gate_ids: ['caller-gate'] },
    });
    expect(issued.packet.payload.receipt_requirements).toEqual({ terminal: true, gate_ids: ['gate-1'] });
    await expect(authority.issueWorkPacket({
      issue_id: ISSUE_ID,
      repository_id: REPOSITORY_ID,
      actor_id: 'agent-1',
      receipt_requirements: [],
    })).rejects.toMatchObject({ code: 'PR_LIFECYCLE_INVALID_INPUT' });
  });

  test('maps injected live probe throws and rejections to unavailable', async () => {
    for (const readIssue of [
      () => { throw new Error('probe failed'); },
      async () => { throw new Error('probe rejected'); },
    ]) {
      const authority = createPrLifecycleAuthority({ provider: provider(), liveProbes: { readIssue } });
      await expect(authority.issueWorkPacket({
        issue_id: ISSUE_ID,
        repository_id: REPOSITORY_ID,
        actor_id: 'agent-1',
      })).rejects.toMatchObject({ code: 'PR_LIFECYCLE_UNAVAILABLE' });
    }
  });

  test('bounds provider calls and rejects invalid timeout configuration before invocation', async () => {
    let invoked = 0;
    const never = createPrLifecycleAuthority({
      provider: provider({ readIssue: async () => { invoked += 1; return new Promise(() => {}); } }),
      timeoutMs: 5,
    });
    const outcome = await Promise.race([
      never.issueWorkPacket({ issue_id: ISSUE_ID, repository_id: REPOSITORY_ID, actor_id: 'agent-1' })
        .then(() => null)
        .catch(error => error),
      new Promise(resolve => setTimeout(() => resolve({ code: 'PR_LIFECYCLE_TEST_TIMEOUT' }), 100)),
    ]);
    expect(outcome).toMatchObject({ code: 'PR_LIFECYCLE_UNAVAILABLE' });
    expect(invoked).toBe(1);
    let observedSignal;
    const abortable = createPrLifecycleAuthority({
      provider: provider({
        readIssue: async (_issueId, signal) => new Promise(resolve => {
          observedSignal = signal;
          signal.addEventListener('abort', () => resolve({ id: ISSUE_ID, revision: 7, status: 'open', ready: true }));
        }),
      }),
      timeoutMs: 5,
    });
    const abortOutcome = await Promise.race([
      abortable.issueWorkPacket({ issue_id: ISSUE_ID, repository_id: REPOSITORY_ID, actor_id: 'agent-1' })
        .then(() => null)
        .catch(error => error),
      new Promise(resolve => setTimeout(() => resolve({ code: 'PR_LIFECYCLE_TEST_TIMEOUT' }), 100)),
    ]);
    expect(abortOutcome).toMatchObject({ code: 'PR_LIFECYCLE_UNAVAILABLE' });
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal.aborted).toBe(true);
    for (const timeoutMs of [0, -1, 30_001, Infinity, '5']) {
      let calls = 0;
      expect(() => createPrLifecycleAuthority({
        provider: provider({ readIssue: async () => { calls += 1; } }),
        timeoutMs,
      })).toThrowError(expect.objectContaining({ code: 'PR_LIFECYCLE_INVALID_INPUT' }));
      expect(calls).toBe(0);
    }
  });

  test('keeps a standalone child alive until an unresponsive provider times out', () => {
    const sourcePath = path.resolve(__dirname, '../src/pr-lifecycle-authority.js');
    const script = `
      const { createPrLifecycleAuthority } = require(${JSON.stringify(sourcePath)});
      const authority = createPrLifecycleAuthority({
        provider: {
          runIssueOperation: async () => null,
          recordPrLinkage: async () => null,
          readTrace: async () => ({ pull_requests: [] }),
          readIssue: async () => new Promise(() => {}),
        },
        timeoutMs: 25,
      });
      authority.issueWorkPacket({ issue_id: 'issue-1', repository_id: 'github.com/example/forge', actor_id: 'agent-1' })
        .then(() => process.exitCode = 2)
        .catch(error => process.stdout.write(error.code));
    `;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 1000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('PR_LIFECYCLE_UNAVAILABLE');
  });

  test('accepts real home git directories only in the trusted linkage field', async () => {
    for (const gitCommonDir of ['C:\\Users\\alice\\repo\\.git', '/Users/alice/repo/.git', '/home/alice/repo/.git']) {
      const workPacket = packet({ payload: { target: { pr_number: 514, branch: 'codex/test', git_common_dir: gitCommonDir, url: 'https://example.test/pull/514' } } });
      let seenGitCommonDir;
      const authority = createPrLifecycleAuthority({
        provider: provider({ recordPrLinkage: async value => { seenGitCommonDir = value.git_common_dir; return { ok: true }; } }),
      });
      const accepted = await authority.acceptRunReceipt({ packet: workPacket, receipt: receipt(workPacket) });
      expect(accepted).toMatchObject({ accepted: true });
      expect(seenGitCommonDir).toBe(gitCommonDir);
      expect(JSON.stringify(accepted)).not.toContain(gitCommonDir);
    }
    const authority = createPrLifecycleAuthority({ provider: provider() });
    await expect(authority.issueWorkPacket({
      issue_id: ISSUE_ID,
      repository_id: REPOSITORY_ID,
      actor_id: 'agent-1',
      target: { git_common_dir: '/Users/alice/repo/.git' },
      objective: '/Users/alice/repo/.git',
    })).rejects.toMatchObject({ code: 'PR_LIFECYCLE_PRIVACY_REJECTED' });
  });

  test('rejects traversal, encoded traversal, and secret-bearing trusted path segments before linkage', async () => {
    for (const gitCommonDir of [
      '/home/alice/../repo/.git',
      'C:\\Users\\alice\\..\\repo\\.git',
      '/home/alice/%2e%2e/repo/.git',
      '/home/sk-live_1234567890123456/repo/.git',
    ]) {
      let writes = 0;
      const authority = createPrLifecycleAuthority({
        provider: provider({ recordPrLinkage: async () => { writes += 1; return { ok: true }; } }),
      });
      const workPacket = packet({ payload: { target: { pr_number: 514, branch: 'codex/test', git_common_dir: gitCommonDir, url: 'https://example.test/pull/514' } } });
      await expect(authority.acceptRunReceipt({ packet: workPacket, receipt: receipt(workPacket) }))
        .rejects.toMatchObject({ code: 'PR_LIFECYCLE_PRIVACY_REJECTED' });
      expect(writes).toBe(0);
    }
  });

  test('preserves stable input errors and rejects missing merge linkage URL before writing', async () => {
    const stable = createPrLifecycleAuthority({ provider: provider() });
    const invalid = { ...packet(), payload: { ...packet().payload, receipt_requirements: [] } };
    invalid.content_hash = computeContentHash(invalid);
    await expect(stable.acceptRunReceipt({ packet: invalid, receipt: receipt(invalid) }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_CONTRACT_INVALID' });

    let writes = 0;
    const workPacket = packet({ payload: { target: { pr_number: 514, branch: 'codex/test', git_common_dir: '/repo/.git' } } });
    const authority = createPrLifecycleAuthority({ provider: provider({ recordPrLinkage: async () => { writes += 1; } }) });
    await expect(authority.acceptRunReceipt({ packet: workPacket, receipt: receipt(workPacket) }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_LINKAGE_UNAVAILABLE' });
    expect(writes).toBe(0);

    const stableProvider = provider({
      recordPrLinkage: async () => {
        throw new PrLifecycleAuthorityError('PR_LIFECYCLE_LINKAGE_CONFLICT', 'stable provider error');
      },
    });
    const stableAuthority = createPrLifecycleAuthority({ provider: stableProvider });
    const stablePacket = packet();
    await expect(stableAuthority.acceptRunReceipt({ packet: stablePacket, receipt: receipt(stablePacket) }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_LINKAGE_CONFLICT' });
  });

  test('issues a hash-valid packet only after live readiness and ownership checks', async () => {
    const calls = [];
    const authority = createPrLifecycleAuthority({
      provider: provider({
        readIssue: async (...args) => { calls.push('issue'); return provider().readIssue(...args); },
        readOwnership: async (...args) => { calls.push('ownership'); return provider().readOwnership(...args); },
      }),
    });
    const result = await authority.issueWorkPacket({ issue_id: ISSUE_ID, repository_id: REPOSITORY_ID, actor_id: 'agent-1' });
    expect(validateContractStructure(result.packet).ok).toBe(true);
    expect(result.packet.payload.target_head).toBe(HEAD);
    expect(result.packet.provenance).toEqual({ source_kind: 'kernel', actor_class: 'agent', actor_id: 'agent-1' });
    expect(calls).toEqual(['issue', 'ownership']);
    expect(result.packet.payload).not.toHaveProperty('lease_epoch');
  });

  test('fails closed when ownership is stale at issuance', async () => {
    const authority = createPrLifecycleAuthority({ provider: provider({ readOwnership: async () => ({ owned: false }) }) });
    await expect(authority.issueWorkPacket({ issue_id: ISSUE_ID, repository_id: REPOSITORY_ID, actor_id: 'agent-1' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_OWNERSHIP_STALE' });
  });

  test('requires an explicit issuance actor that matches fresh ownership', async () => {
    const authority = createPrLifecycleAuthority({ provider: provider() });
    await expect(authority.issueWorkPacket({ issue_id: ISSUE_ID, repository_id: REPOSITORY_ID }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_INVALID_INPUT' });
    await expect(authority.issueWorkPacket({ issue_id: ISSUE_ID, repository_id: REPOSITORY_ID, actor_id: 'agent-2' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_OWNERSHIP_STALE' });
  });

  test('binds explicit session probes to fresh ownership without adding session to packets', async () => {
    const staleSession = createPrLifecycleAuthority({
      provider: provider({ readOwnership: async () => ({ owned: true, actor_id: 'agent-1', session_id: 'session-2' }) }),
    });
    await expect(staleSession.issueWorkPacket({
      issue_id: ISSUE_ID,
      repository_id: REPOSITORY_ID,
      actor_id: 'agent-1',
      session_id: 'session-1',
    })).rejects.toMatchObject({ code: 'PR_LIFECYCLE_OWNERSHIP_STALE' });
    const workPacket = packet();
    const runReceipt = receipt(workPacket);
    const authority = createPrLifecycleAuthority({ provider: provider() });
    const accepted = await authority.acceptRunReceipt({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' });
    expect(accepted.accepted).toBe(true);
    await authority.mergeWorkPacket({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' });
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

  test('binds acceptance ownership to the issuance actor, ignoring caller actor overrides', async () => {
    const workPacket = packet();
    const runReceipt = receipt(workPacket);
    const authority = createPrLifecycleAuthority({
      provider: provider({ readOwnership: async () => ({ owned: true, actor_id: 'agent-2', session_id: 'session-2' }) }),
    });
    await expect(authority.acceptRunReceipt({
      packet: workPacket,
      receipt: runReceipt,
      actor_id: 'agent-2',
      session_id: 'session-2',
    })).rejects.toMatchObject({ code: 'PR_LIFECYCLE_OWNERSHIP_STALE' });
  });

  test('uses only authoritative live config, never packet or caller config preference', async () => {
    const authority = createPrLifecycleAuthority({
      provider: provider({ readCapability: async () => ({ digest: DIGEST, approved: true, available: true, probed: true, expires_at: '2099-01-01T00:00:00.000Z', config_revision: 'config-2' }) }),
    });
    await expect(authority.issueWorkPacket({
      issue_id: ISSUE_ID,
      repository_id: REPOSITORY_ID,
      actor_id: 'agent-1',
      workflow_config_revision: CONFIG_REVISION,
    })).rejects.toMatchObject({ code: 'PR_LIFECYCLE_REVISION_STALE' });
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
        recordPrLinkage: async () => { recorded += 1; },
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
        recordPrLinkage: async (value) => { recorded += 1; return { accepted: true, receipt: value }; },
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
    const workPacket = packet({ payload: { target: { pr_number: 514, branch: 'codex/test', git_common_dir: '/repo/.git', url: 'https://example.test/pull/514' } } });
    const runReceipt = receipt(workPacket);
    const authority = createPrLifecycleAuthority({
      provider: provider({ mergePr: async (value) => { merges += 1; return { merged: true, linkage: value }; } }),
    });
    await authority.acceptRunReceipt({ packet: workPacket, receipt: runReceipt });
    const result = await authority.mergeWorkPacket({ packet: workPacket, receipt: runReceipt });
    expect(result.merged).toBe(true);
    expect(merges).toBe(1);
    expect(result.linkage).toMatchObject({ issue_id: ISSUE_ID, repository_id: REPOSITORY_ID, head: HEAD });
  });

  test('requires a completed merged phase before invoking merge or merged linkage', async () => {
    let merges = 0;
    const workPacket = packet({ payload: { allowed_mutations: ['pr.opened'] } });
    const runReceipt = receipt(workPacket, { payload: {
      mutations_attempted: ['pr.opened'],
      mutations_authorized: ['pr.opened'],
    } });
    const authority = createPrLifecycleAuthority({
      provider: provider({ mergePr: async () => { merges += 1; return { merged: true }; } }),
    });
    await authority.acceptRunReceipt({ packet: workPacket, receipt: runReceipt });
    await expect(authority.mergeWorkPacket({ packet: workPacket, receipt: runReceipt }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_MUTATION_UNAUTHORIZED' });
    expect(merges).toBe(0);
  });

  test('rejects an unlinked merge before invoking the merge provider', async () => {
    let merges = 0;
    const workPacket = packet();
    delete workPacket.payload.target;
    workPacket.content_hash = computeContentHash(workPacket);
    const runReceipt = receipt(workPacket);
    const authority = createPrLifecycleAuthority({
      provider: provider({ mergePr: async () => { merges += 1; return { merged: true }; } }),
    });
    await expect(authority.acceptRunReceipt({ packet: workPacket, receipt: runReceipt }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_LINKAGE_UNAVAILABLE' });
    expect(merges).toBe(0);
  });

  test('requires durable accepted linkage before returning receipt acceptance', async () => {
    let writes = 0;
    let linkageWrite;
    const workPacket = packet({ payload: {
      target: { pr_number: 514, branch: 'codex/test', git_common_dir: '/repo/.git', url: 'https://example.test/pull/514' },
    } });
    const authority = createPrLifecycleAuthority({
      provider: provider({
        recordPrLinkage: async (value) => { writes += 1; linkageWrite = value; return { ok: true }; },
        readTrace: async () => linkageWrite ? {
          pull_requests: [{ number: 514, repo: REPOSITORY_ID, head_sha: HEAD, issue_id: ISSUE_ID, iterations: [{
            work_packet_hash: linkageWrite.work_packet.content_hash,
            run_receipt_hash: linkageWrite.run_receipt.content_hash,
          }] }],
        } : { pull_requests: [] },
      }),
    });
    const result = await authority.acceptRunReceipt({ packet: workPacket, receipt: receipt(workPacket) });
    expect(result.accepted).toBe(true);
    expect(writes).toBe(1);
  });

  test('fails closed when durable accepted linkage cannot be written or proved', async () => {
    const workPacket = packet({ payload: {
      target: { pr_number: 514, branch: 'codex/test', git_common_dir: '/repo/.git', url: 'https://example.test/pull/514' },
    } });
    const writeFails = createPrLifecycleAuthority({
      provider: provider({ recordPrLinkage: async () => { throw new Error('write failed'); } }),
    });
    await expect(writeFails.acceptRunReceipt({ packet: workPacket, receipt: receipt(workPacket) }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_UNAVAILABLE' });
    const traceMissing = createPrLifecycleAuthority({
      provider: provider({ recordPrLinkage: async () => ({ ok: true }), readTrace: async () => ({ pull_requests: [] }) }),
    });
    await expect(traceMissing.acceptRunReceipt({ packet: workPacket, receipt: receipt(workPacket) }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_LINKAGE_CONFLICT' });
  });

  test('uses only broker-compatible opened or merged linkage phases', async () => {
    const phases = [];
    let linkageWrite;
    const workPacket = packet({ payload: { allowed_mutations: ['pr.merged'] } });
    const authority = createPrLifecycleAuthority({
      provider: provider({
        recordPrLinkage: async (value) => {
          phases.push(value.phase);
          if (!['opened', 'merged'].includes(value.phase)) throw new Error('unsupported lifecycle phase');
          linkageWrite = value;
          return { ok: true };
        },
        readTrace: async () => linkageWrite ? {
          pull_requests: [{ number: 514, repo: REPOSITORY_ID, head_sha: HEAD, issue_id: ISSUE_ID, iterations: [{
            work_packet_hash: linkageWrite.work_packet.content_hash,
            run_receipt_hash: linkageWrite.run_receipt.content_hash,
          }] }],
        } : { pull_requests: [] },
      }),
    });
    const result = await authority.acceptRunReceipt({ packet: workPacket, receipt: receipt(workPacket, { payload: {
      mutations_attempted: ['pr.merged'],
      mutations_authorized: ['pr.merged'],
    } }) });
    expect(result.accepted).toBe(true);
    expect(phases).toEqual(['merged']);
  });

  test('returns provider ready order without reranking', async () => {
    const ready = [{ id: 'z', rank: 10 }, { id: 'a', rank: 1 }];
    const authority = createPrLifecycleAuthority({ provider: provider({ listReadyWork: async () => ready }) });
    const result = await authority.requestNextWork();
    expect(result).toEqual(ready);
  });

  test('uses the public ready operation when provider has no ready method', async () => {
    const base = provider();
    delete base.listReadyWork;
    base.runIssueOperation = async (operation) => operation === 'ready'
      ? { ok: true, data: [{ id: 'z' }, { id: 'a' }] }
      : null;
    const authority = createPrLifecycleAuthority({ provider: base });
    await expect(authority.requestNextWork({ issue_id: ISSUE_ID })).resolves.toEqual([{ id: 'z' }, { id: 'a' }]);
  });

  test('rejects ambiguous duplicate PR trace rows before merge side effects', async () => {
    let merges = 0;
    let durable;
    let traceReads = 0;
    const workPacket = packet();
    const runReceipt = receipt(workPacket);
    const row = () => ({ number: 514, repo: REPOSITORY_ID, head_sha: HEAD, issue_id: ISSUE_ID, iterations: [{
      work_packet_hash: durable.work_packet.content_hash,
      run_receipt_hash: durable.run_receipt.content_hash,
    }] });
    const authority = createPrLifecycleAuthority({
      provider: provider({
        recordPrLinkage: async (value) => { durable = value; return { ok: true }; },
        readTrace: async () => {
          traceReads += 1;
          if (traceReads < 2) return { pull_requests: [] };
          if (traceReads === 2) return { pull_requests: [row()] };
          return { pull_requests: [row(), row()] };
        },
        mergePr: async () => { merges += 1; return { merged: true }; },
      }),
    });
    await authority.acceptRunReceipt({ packet: workPacket, receipt: runReceipt });
    await expect(authority.mergeWorkPacket({ packet: workPacket, receipt: runReceipt }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_LINKAGE_CONFLICT' });
    expect(merges).toBe(0);
  });

  test('rejects non-array acceptance criteria and prohibited actions at issuance', async () => {
    const authority = createPrLifecycleAuthority({ provider: provider() });
    for (const field of ['acceptance_criteria', 'prohibited_actions']) {
      await expect(authority.issueWorkPacket({
        issue_id: ISSUE_ID,
        repository_id: REPOSITORY_ID,
        actor_id: 'agent-1',
        [field]: 'not-an-array',
      })).rejects.toMatchObject({ code: 'PR_LIFECYCLE_INVALID_INPUT' });
    }
  });

  test('requires compatible attempted and authorized mutation evidence', async () => {
    const workPacket = packet();
    const authority = createPrLifecycleAuthority({ provider: provider() });
    await expect(authority.acceptRunReceipt({
      packet: workPacket,
      receipt: receipt(workPacket, { payload: { mutations_attempted: ['pr.merge', 'files'], mutations_authorized: ['pr.merge'] } }),
    })).rejects.toMatchObject({ code: 'PR_LIFECYCLE_MUTATION_UNAUTHORIZED' });
    await expect(authority.acceptRunReceipt({
      packet: workPacket,
      receipt: receipt(workPacket, { payload: { mutations_attempted: ['pr.merge'], mutations_authorized: ['pr.merge', 'files'] } }),
    })).rejects.toMatchObject({ code: 'PR_LIFECYCLE_MUTATION_UNAUTHORIZED' });
  });

  test('rejects pr.merge-only evidence before durable linkage', async () => {
    let writes = 0;
    const workPacket = packet({ payload: { allowed_mutations: ['pr.merge'] } });
    const authority = createPrLifecycleAuthority({
      provider: provider({ recordPrLinkage: async () => { writes += 1; return { ok: true }; } }),
    });
    await expect(authority.acceptRunReceipt({
      packet: workPacket,
      receipt: receipt(workPacket, { payload: {
        mutations_attempted: ['pr.merge'],
        mutations_authorized: ['pr.merge'],
      } }),
    })).rejects.toMatchObject({ code: 'PR_LIFECYCLE_MUTATION_UNAUTHORIZED' });
    expect(writes).toBe(0);
  });

  test('requires receipt provenance to match the packet and live owner actor', async () => {
    const workPacket = packet();
    const authority = createPrLifecycleAuthority({ provider: provider() });
    await expect(authority.acceptRunReceipt({
      packet: workPacket,
      receipt: receipt(workPacket, { provenance: { source_kind: 'flow', actor_class: 'agent', actor_id: 'agent-2' } }),
    })).rejects.toMatchObject({ code: 'PR_LIFECYCLE_OWNERSHIP_STALE' });
  });

  test('rejects invented runIssueOperation live probe operations', async () => {
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
    await expect(authority.issueWorkPacket({ issue_id: ISSUE_ID, repository_id: REPOSITORY_ID, actor_id: 'agent-1' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_UNAVAILABLE' });
  });

  test('accepts explicit trusted live probes instead of invented issue operations', async () => {
    const base = provider();
    for (const method of ['readIssue', 'readOwnership', 'readHead', 'readCapability', 'readRisk', 'readGates']) delete base[method];
    base.runIssueOperation = async () => { throw new Error('must not probe live state through issue operations'); };
    const authority = createPrLifecycleAuthority({
      provider: base,
      liveProbes: {
        readIssue: async () => ({ id: ISSUE_ID, revision: 7, status: 'open', ready: true }),
        readOwnership: async () => ({ owned: true, actor_id: 'agent-1', session_id: 'session-1' }),
        readHead: async () => ({ repository_id: REPOSITORY_ID, head: HEAD }),
        readCapability: async () => ({ digest: DIGEST, approved: true, available: true, probed: true, expires_at: '2099-01-01T00:00:00.000Z', config_revision: CONFIG_REVISION }),
        readRisk: async () => ({ approved: true, digest: 'c'.repeat(64) }),
        readGates: async () => ({ complete: true, approved: true, ids: ['gate-1'] }),
      },
    });
    const result = await authority.issueWorkPacket({ issue_id: ISSUE_ID, repository_id: REPOSITORY_ID, actor_id: 'agent-1' });
    expect(result.packet.payload.target_head).toBe(HEAD);
  });

  test('uses the public recordPrLinkage operation for merge persistence', async () => {
    const calls = [];
    const base = provider({
      mergePr: undefined,
      recordPrLinkage: async (value) => { calls.push(value); return { link: { id: 'pr-1' } }; },
    });
    const workPacket = packet({ payload: {
      target: { pr_number: 514, branch: 'codex/test', git_common_dir: '/repo/.git', url: 'https://example.test/pull/514' },
      allowed_mutations: ['pr.merge', 'pr.merged'],
    } });
    const runReceipt = receipt(workPacket, { payload: {
      mutations_attempted: ['pr.merged'],
      mutations_authorized: ['pr.merged'],
    } });
    const authority = createPrLifecycleAuthority({ provider: base });
    await authority.acceptRunReceipt({ packet: workPacket, receipt: runReceipt });
    await authority.mergeWorkPacket({ packet: workPacket, receipt: runReceipt });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ phase: 'merged', repo: REPOSITORY_ID, number: 514 });
    expect(calls[1]).toMatchObject({ phase: 'merged', repo: REPOSITORY_ID, number: 514 });
    expect(calls[1].work_packet).toEqual(workPacket);
    expect(calls[1].run_receipt).toEqual(runReceipt);
  });

  test('reads the public trace seam before using accepted linkage for merge', async () => {
    let traceReads = 0;
    const workPacket = packet({ payload: { target: { pr_number: 514, branch: 'codex/test', git_common_dir: '/repo/.git', url: 'https://example.test/pull/514' } } });
    const runReceipt = receipt(workPacket);
    const base = provider();
    const readTrace = base.readTrace;
    base.readTrace = async (...args) => { traceReads += 1; return readTrace(...args); };
    const authority = createPrLifecycleAuthority({
      provider: base,
    });
    await authority.acceptRunReceipt({ packet: workPacket, receipt: runReceipt });
    await authority.mergeWorkPacket({ packet: workPacket, receipt: runReceipt });
    expect(traceReads).toBe(3);
  });

  test('reconstructs replay authority from durable trace across facade instances', async () => {
    let durable = null;
    const durableProvider = provider({
      recordPrLinkage: async ({ work_packet: acceptedPacket, run_receipt: acceptedReceipt }) => {
        durable = { packet: acceptedPacket, receipt: acceptedReceipt };
        return { accepted: true };
      },
      readTrace: async () => durable ? {
        pull_requests: [{
          number: 514,
          repo: REPOSITORY_ID,
          head_sha: durable.packet.payload.target_head,
          issue_id: durable.packet.payload.issue_id,
          iterations: [{
            work_packet_hash: durable.packet.content_hash,
            run_receipt_hash: durable.receipt.content_hash,
            packet: durable.packet,
            receipt: durable.receipt,
          }],
        }],
      } : { pull_requests: [] },
    });
    const workPacket = packet({ payload: { target: { pr_number: 514, branch: 'codex/test', git_common_dir: '/repo/.git', url: 'https://example.test/pull/514' } } });
    const runReceipt = receipt(workPacket);
    const first = createPrLifecycleAuthority({ provider: durableProvider });
    await first.acceptRunReceipt({ packet: workPacket, receipt: runReceipt });
    const second = createPrLifecycleAuthority({ provider: durableProvider });
    const replay = await second.acceptRunReceipt({ packet: workPacket, receipt: runReceipt });
    expect(replay.accepted).toBe(true);
    await second.mergeWorkPacket({ packet: workPacket, receipt: runReceipt });
    const divergent = receipt(workPacket, { payload: { validation: { status: 'PASS', note: 'different' } } });
    await expect(second.acceptRunReceipt({ packet: workPacket, receipt: divergent }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_REPLAY_CONFLICT' });
  });

  test('does not return raw provider receipt or merge objects and rejects hostile probe data', async () => {
    const workPacket = packet();
    const runReceipt = receipt(workPacket);
    const authority = createPrLifecycleAuthority({
      provider: provider({ recordPrLinkage: async () => ({ token: 'sk-live_1234567890123456', 'sk-live_1234567890123456': 'hidden' }) }),
    });
    const accepted = await authority.acceptRunReceipt({ packet: workPacket, receipt: runReceipt });
    expect(JSON.stringify(accepted)).not.toContain('sk-live_');
    const hostile = createPrLifecycleAuthority({
      provider: provider({ readIssue: async () => ({ id: ISSUE_ID, revision: 7, status: 'open', ready: true, objective: 'C:\\Users\\alice\\secret' }) }),
    });
    await expect(hostile.issueWorkPacket({ issue_id: ISSUE_ID, repository_id: REPOSITORY_ID, actor_id: 'agent-1' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_PRIVACY_REJECTED' });
    for (const readIssue of [
      async () => ({ id: ISSUE_ID, revision: 7, status: 'open', ready: true, 'sk-live_1234567890123456': 'present' }),
      async () => ({ id: ISSUE_ID, revision: 7, status: 'open', ready: true, objective: 'sk-live_1234567890123456' }),
    ]) {
      const secretAuthority = createPrLifecycleAuthority({ provider: provider({ readIssue }) });
      await expect(secretAuthority.issueWorkPacket({ issue_id: ISSUE_ID, repository_id: REPOSITORY_ID, actor_id: 'agent-1' }))
        .rejects.toMatchObject({ code: 'PR_LIFECYCLE_PRIVACY_REJECTED' });
    }
  });

  test('requires a positively approved, available, probed, non-expired capability', async () => {
    const workPacket = packet();
    const runReceipt = receipt(workPacket);
    for (const capability of [
      { digest: DIGEST, approved: true },
      { digest: DIGEST, approved: true, available: true, probed: false, expires_at: '2099-01-01T00:00:00.000Z', config_revision: CONFIG_REVISION },
      { digest: DIGEST, approved: true, available: true, probed: true, expires_at: '2020-01-01T00:00:00.000Z', config_revision: CONFIG_REVISION },
    ]) {
      const authority = createPrLifecycleAuthority({ provider: provider({ readCapability: async () => capability }) });
      await expect(authority.acceptRunReceipt({ packet: workPacket, receipt: runReceipt }))
        .rejects.toMatchObject({ code: 'PR_LIFECYCLE_CAPABILITY_INVALID' });
    }
  });

  test('rejects a divergent receipt at merge even when the run id is reused', async () => {
    let merges = 0;
    const workPacket = packet({ payload: { target: { pr_number: 514, branch: 'codex/test', git_common_dir: '/repo/.git', url: 'https://example.test/pull/514' } } });
    const runReceipt = receipt(workPacket);
    const authority = createPrLifecycleAuthority({ provider: provider({ mergePr: async () => { merges += 1; return { ok: true }; } }) });
    await authority.acceptRunReceipt({ packet: workPacket, receipt: runReceipt });
    const divergent = receipt(workPacket, { payload: { validation: { status: 'PASS', note: 'different' } } });
    await expect(authority.mergeWorkPacket({ packet: workPacket, receipt: divergent }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_REPLAY_CONFLICT' });
    expect(merges).toBe(0);
  });
});
