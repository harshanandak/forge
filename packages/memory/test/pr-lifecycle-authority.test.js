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
  createPrLifecycleAuthority: createPrLifecycleAuthorityRaw,
} = require('../src/pr-lifecycle-authority');

const ISSUE_ID = 'issue-1';
const REPOSITORY_ID = 'github.com/example/forge';
const HEAD = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);
const CONFIG_REVISION = 'config-1';
const NOW = '2026-08-11T00:00:00.000Z';

function createPrLifecycleAuthority(options = {}) {
  const receiptVerifier = options.receiptVerifier ?? (async identity => ({
    authenticated: true,
    ...identity,
  }));
  return createPrLifecycleAuthorityRaw({ ...options, receiptVerifier });
}

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
    producer: { product_id: 'forge-flow', product_version: '0.1.0-beta.6', instance_id: 'flow-1' },
    capabilities_used: [],
    provenance: { source_kind: 'execution', actor_class: 'system', actor_id: 'flow-1' },
    payload: basePayload,
    extensions: {},
    ...overrides,
  };
  value.payload = { ...basePayload, ...(overrides.payload || {}) };
  value.content_hash = computeContentHash(value);
  return value;
}

function packetIdentity(workPacket) {
  const payload = workPacket.payload;
  return JSON.stringify([payload.issue_id, payload.expected_issue_revision, payload.packet_id,
    payload.packet_revision, payload.repository_id, payload.target_head]);
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
        iterations: [{ type: `pr.${durable.phase ?? 'merged'}`, work_packet_hash: durable.packet.content_hash,
          work_packet_identity: packetIdentity(durable.packet), run_receipt_hash: durable.receipt.content_hash }],
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
    const result = overrideRecordPrLinkage ? await overrideRecordPrLinkage(value) : { accepted: true };
    durable = value.work_packet && value.run_receipt
      ? { phase: value.phase, packet: value.work_packet, receipt: value.run_receipt }
      : durable;
    return result;
  };
  return base;
}

describe('public PR lifecycle authority', () => {
  test('requires an independently trusted receipt verifier at construction', () => {
    expect(() => createPrLifecycleAuthorityRaw({ provider: provider() }))
      .toThrow('receiptVerifier must be a function');
  });

  test('exposes the injected facade methods', () => {
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
      actor_id: 'agent-1', session_id: 'session-1',
      receipt_requirements: { terminal: false, gate_ids: ['caller-gate'] },
    });
    expect(issued.packet.payload.receipt_requirements).toEqual({ terminal: true, gate_ids: ['gate-1'] });
    await expect(authority.issueWorkPacket({
      issue_id: ISSUE_ID,
      repository_id: REPOSITORY_ID,
      actor_id: 'agent-1', session_id: 'session-1',
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
        actor_id: 'agent-1', session_id: 'session-1',
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
      never.issueWorkPacket({ issue_id: ISSUE_ID, repository_id: REPOSITORY_ID, actor_id: 'agent-1', session_id: 'session-1' })
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
      abortable.issueWorkPacket({ issue_id: ISSUE_ID, repository_id: REPOSITORY_ID, actor_id: 'agent-1', session_id: 'session-1' })
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
        receiptVerifier: async identity => ({ authenticated: true, ...identity }),
        timeoutMs: 25,
      });
      authority.issueWorkPacket({ issue_id: 'issue-1', repository_id: 'github.com/example/forge', actor_id: 'agent-1', session_id: 'session-1' })
        .then(() => process.exitCode = 2)
        .catch(error => process.stdout.write(error.code));
    `;
    // GitHub-hosted Windows runners can spend more than a second starting Node and
    // loading the package; the provider deadline under test is still only 25ms.
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 5000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('PR_LIFECYCLE_UNAVAILABLE');
  });

  test('accepts canonical absolute git directories only in the trusted linkage field', async () => {
    for (const gitCommonDir of ['C:\\Users\\alice\\repo\\.git', '/Users/alice/repo/.git', '/home/alice/repo/.git', '/workspace/forge/.git', '/github/workspace/.git', '/tmp/project/.git']) {
      const workPacket = packet({ payload: { target: { pr_number: 514, branch: 'codex/test', git_common_dir: gitCommonDir, url: 'https://example.test/pull/514' } } });
      let seenGitCommonDir;
      const authority = createPrLifecycleAuthority({
        provider: provider({ recordPrLinkage: async value => { seenGitCommonDir = value.git_common_dir; return { ok: true }; } }),
      });
      const accepted = await authority.acceptRunReceipt({ packet: workPacket, receipt: receipt(workPacket), session_id: 'session-1' });
      expect(accepted).toMatchObject({ accepted: true });
      await authority.mergeWorkPacket({ packet: workPacket, receipt: receipt(workPacket), session_id: 'session-1' });
      expect(seenGitCommonDir).toBe(gitCommonDir);
      expect(JSON.stringify(accepted)).not.toContain(gitCommonDir);
    }
    const authority = createPrLifecycleAuthority({ provider: provider() });
    await expect(authority.issueWorkPacket({
      issue_id: ISSUE_ID,
      repository_id: REPOSITORY_ID,
      actor_id: 'agent-1', session_id: 'session-1',
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
      '/home/alice//repo/.git',
      '/home//repo/.git',
      'C:/Users//repo/.git',
      '/home/alice /repo/.git',
    ]) {
      let writes = 0;
      const authority = createPrLifecycleAuthority({
        provider: provider({ recordPrLinkage: async () => { writes += 1; return { ok: true }; } }),
      });
      const workPacket = packet({ payload: { target: { pr_number: 514, branch: 'codex/test', git_common_dir: gitCommonDir, url: 'https://example.test/pull/514' } } });
      await expect(authority.acceptRunReceipt({ packet: workPacket, receipt: receipt(workPacket), session_id: 'session-1' }))
        .rejects.toMatchObject({ code: 'PR_LIFECYCLE_PRIVACY_REJECTED' });
      expect(writes).toBe(0);
    }
  });

  test('preserves stable input errors and rejects missing merge linkage URL before writing', async () => {
    const stable = createPrLifecycleAuthority({ provider: provider() });
    const invalid = { ...packet(), payload: { ...packet().payload, receipt_requirements: [] } };
    invalid.content_hash = computeContentHash(invalid);
    await expect(stable.acceptRunReceipt({ packet: invalid, receipt: receipt(invalid), session_id: 'session-1' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_CONTRACT_INVALID' });

    let writes = 0;
    const workPacket = packet({ payload: { target: { pr_number: 514, branch: 'codex/test', git_common_dir: '/repo/.git' } } });
    const authority = createPrLifecycleAuthority({ provider: provider({ recordPrLinkage: async () => { writes += 1; } }) });
    await expect(authority.acceptRunReceipt({ packet: workPacket, receipt: receipt(workPacket), session_id: 'session-1' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_LINKAGE_UNAVAILABLE' });
    expect(writes).toBe(0);

    const stableProvider = provider({
      recordPrLinkage: async () => {
        throw new PrLifecycleAuthorityError('PR_LIFECYCLE_LINKAGE_CONFLICT', 'stable provider error');
      },
    });
    const stableAuthority = createPrLifecycleAuthority({ provider: stableProvider });
    const stablePacket = packet();
    await stableAuthority.acceptRunReceipt({ packet: stablePacket, receipt: receipt(stablePacket), session_id: 'session-1' });
    await expect(stableAuthority.mergeWorkPacket({ packet: stablePacket, receipt: receipt(stablePacket), session_id: 'session-1' }))
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
    const result = await authority.issueWorkPacket({ issue_id: ISSUE_ID, repository_id: REPOSITORY_ID, actor_id: 'agent-1', session_id: 'session-1' });
    expect(validateContractStructure(result.packet).ok).toBe(true);
    expect(result.packet.payload.target_head).toBe(HEAD);
    expect(result.packet.provenance).toEqual({ source_kind: 'kernel', actor_class: 'agent', actor_id: 'agent-1' });
    expect(calls).toEqual(['issue', 'ownership']);
    expect(result.packet.payload).not.toHaveProperty('lease_epoch');
  });

  test('fails closed when ownership is stale at issuance', async () => {
    const authority = createPrLifecycleAuthority({ provider: provider({ readOwnership: async () => ({ owned: false }) }) });
    await expect(authority.issueWorkPacket({ issue_id: ISSUE_ID, repository_id: REPOSITORY_ID, actor_id: 'agent-1', session_id: 'session-1' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_OWNERSHIP_STALE' });
  });

  test('requires an explicit issuance actor that matches fresh ownership', async () => {
    const authority = createPrLifecycleAuthority({ provider: provider() });
    await expect(authority.issueWorkPacket({ issue_id: ISSUE_ID, repository_id: REPOSITORY_ID }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_INVALID_INPUT' });
    await expect(authority.issueWorkPacket({ issue_id: ISSUE_ID, repository_id: REPOSITORY_ID, actor_id: 'agent-2', session_id: 'session-1' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_OWNERSHIP_STALE' });
  });

  test('requires and binds session probes to fresh ownership without adding session to packets', async () => {
    const authority = createPrLifecycleAuthority({ provider: provider() });
    await expect(authority.issueWorkPacket({ issue_id: ISSUE_ID, repository_id: REPOSITORY_ID, actor_id: 'agent-1' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_INVALID_INPUT' });
    const workPacket = packet();
    await expect(authority.acceptRunReceipt({ packet: workPacket, receipt: receipt(workPacket) }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_INVALID_INPUT' });
    await expect(authority.mergeWorkPacket({ packet: workPacket, receipt: receipt(workPacket) }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_INVALID_INPUT' });
    const staleSession = createPrLifecycleAuthority({
      provider: provider({ readOwnership: async () => ({ owned: true, actor_id: 'agent-1', session_id: 'session-2' }) }),
    });
    await expect(staleSession.issueWorkPacket({
      issue_id: ISSUE_ID,
      repository_id: REPOSITORY_ID,
      actor_id: 'agent-1',
      session_id: 'session-1',
    })).rejects.toMatchObject({ code: 'PR_LIFECYCLE_OWNERSHIP_STALE' });
    const runReceipt = receipt(workPacket);
    const accepted = await authority.acceptRunReceipt({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' });
    expect(accepted.accepted).toBe(true);
    await authority.mergeWorkPacket({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' });
  });

  test('proves session ownership through the Kernel owns and claims fallback', async () => {
    const base = provider();
    delete base.readOwnership;
    base.runIssueOperation = async (operation) => {
      if (operation === 'owns') return { ok: true, data: { owned: true, actor: 'agent-1', claimed_by: 'agent-1' } };
      if (operation === 'claims') return { ok: true, data: { claims: [{ issue_id: ISSUE_ID, actor: 'agent-1', session_id: 'session-1' }], count: 1 } };
      return null;
    };
    const authority = createPrLifecycleAuthority({ provider: base });
    await expect(authority.issueWorkPacket({ issue_id: ISSUE_ID, repository_id: REPOSITORY_ID, actor_id: 'agent-1', session_id: 'session-1' }))
      .resolves.toHaveProperty('packet');
    base.runIssueOperation = async (operation) => operation === 'owns'
      ? { ok: true, data: { owned: true, actor: 'agent-1', claimed_by: 'agent-1' } }
      : { ok: true, data: { claims: [{ issue_id: ISSUE_ID, actor: 'agent-1', session_id: 'session-2' }], count: 1 } };
    await expect(authority.issueWorkPacket({ issue_id: ISSUE_ID, repository_id: REPOSITORY_ID, actor_id: 'agent-1', session_id: 'session-1' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_OWNERSHIP_STALE' });
  });

  test('reconciles consequential provider completion instead of reporting a false timeout', async () => {
    let writes = 0;
    let releaseWrite;
    const writeGate = new Promise(resolve => { releaseWrite = resolve; });
    const workPacket = packet();
    const authority = createPrLifecycleAuthority({
      provider: provider({ recordPrLinkage: async () => {
        await writeGate;
        writes += 1;
        return { ok: true };
      } }),
      timeoutMs: 5,
    });
    let settled = false;
    const merge = authority.mergeWorkPacket({ packet: workPacket, receipt: receipt(workPacket), session_id: 'session-1' })
      .finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(settled).toBe(false);
    releaseWrite();
    await expect(merge).resolves.toMatchObject({ merged: true });
    expect(writes).toBe(1);
  });

  test('re-probes ownership and exact head at receipt acceptance', async () => {
    const workPacket = packet();
    const runReceipt = receipt(workPacket);
    const ownershipLost = createPrLifecycleAuthority({ provider: provider({ readOwnership: async () => ({ owned: false }) }) });
    await expect(ownershipLost.acceptRunReceipt({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_OWNERSHIP_STALE' });
    const headDrifted = createPrLifecycleAuthority({ provider: provider({ readHead: async () => ({ repository_id: REPOSITORY_ID, head: 'd'.repeat(40) }) }) });
    await expect(headDrifted.acceptRunReceipt({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' }))
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
      actor_id: 'agent-1', session_id: 'session-1',
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
      await expect(authority.acceptRunReceipt({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' }))
        .rejects.toMatchObject({ code });
    }
  });

  test('accepts a PASS receipt only with fresh ownership and terminal mutation evidence', async () => {
    const workPacket = packet();
    const authority = createPrLifecycleAuthority({ provider: provider() });
    const result = await authority.acceptRunReceipt({ packet: workPacket, receipt: receipt(workPacket), session_id: 'session-1' });
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
    await expect(authority.acceptRunReceipt({ packet: workPacket, receipt: malformed, session_id: 'session-1' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_CONTRACT_INVALID' });
    expect(recorded).toBe(0);
  });

  test('rejects unauthorized mutation, incomplete terminal evidence, and deferred lease epochs', async () => {
    const workPacket = packet();
    const authority = createPrLifecycleAuthority({ provider: provider() });
    await expect(authority.acceptRunReceipt({
      packet: workPacket,
      receipt: receipt(workPacket, { payload: { mutations_attempted: ['files'], mutations_authorized: ['files'] } }),
      session_id: 'session-1',
    })).rejects.toMatchObject({ code: 'PR_LIFECYCLE_MUTATION_UNAUTHORIZED' });
    await expect(authority.acceptRunReceipt({
      packet: workPacket,
      receipt: receipt(workPacket, { payload: { cleanup: { status: 'INCOMPLETE' } } }),
      session_id: 'session-1',
    })).rejects.toMatchObject({ code: 'PR_LIFECYCLE_TERMINAL_INVALID' });
    await expect(authority.acceptRunReceipt({
      packet: workPacket,
      receipt: receipt(workPacket, { payload: { lease_epoch: 1 } }),
      session_id: 'session-1',
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
    const first = await authority.acceptRunReceipt({ packet: workPacket, receipt: receipt(workPacket), session_id: 'session-1' });
    const replay = await authority.acceptRunReceipt({ packet: structuredClone(workPacket), receipt: receipt(workPacket), session_id: 'session-1' });
    expect(replay).toEqual(first);
    expect(recorded).toBe(0);
    await authority.mergeWorkPacket({ packet: workPacket, receipt: receipt(workPacket), session_id: 'session-1' });
    expect(recorded).toBe(1);
    const divergent = receipt(workPacket, { payload: { attempt_id: 'attempt-2' } });
    await expect(authority.acceptRunReceipt({ packet: workPacket, receipt: divergent, session_id: 'session-1' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_REPLAY_CONFLICT' });
  });

  test('rejects a persisted packet that reuses semantic identity with different content', async () => {
    const firstPacket = packet({ payload: { allowed_mutations: ['pr.opened'] } });
    const firstReceipt = receipt(firstPacket, { payload: {
      mutations_attempted: ['pr.opened'], mutations_authorized: ['pr.opened'], run_id: 'run-old',
    } });
    const secondPacket = packet({ payload: { allowed_mutations: ['pr.merged'] } });
    const authority = createPrLifecycleAuthority({ provider: provider({ readTrace: async () => ({ pull_requests: [{
      number: 514, repo: REPOSITORY_ID, head_sha: HEAD, issue_id: ISSUE_ID,
      iterations: [{ type: 'pr.opened', work_packet_hash: firstPacket.content_hash,
        work_packet_identity: packetIdentity(firstPacket), run_receipt_hash: firstReceipt.content_hash, run_id: 'run-old' }],
    }] }) }) });
    await expect(authority.acceptRunReceipt({ packet: secondPacket, receipt: receipt(secondPacket), session_id: 'session-1' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_REPLAY_CONFLICT' });
  });

  test('rejects semantic identity reuse across a different linked PR', async () => {
    let writes = 0;
    const oldPacket = packet({ payload: { allowed_mutations: ['pr.opened'] } });
    const oldReceipt = receipt(oldPacket, { payload: {
      mutations_attempted: ['pr.opened'], mutations_authorized: ['pr.opened'], run_id: 'run-old',
    } });
    const nextPacket = packet({ payload: {
      allowed_mutations: ['pr.opened'],
      target: { pr_number: 515, branch: 'codex/next', git_common_dir: '/repo/.git', url: 'https://example.test/pull/515' },
    } });
    const authority = createPrLifecycleAuthority({ provider: provider({
      recordPrLinkage: async () => { writes += 1; return { ok: true }; },
      readTrace: async () => ({ pull_requests: [{
        number: 514, repo: REPOSITORY_ID, head_sha: HEAD, issue_id: ISSUE_ID,
        iterations: [{ type: 'pr.opened', work_packet_hash: oldPacket.content_hash,
          work_packet_identity: packetIdentity(oldPacket), run_receipt_hash: oldReceipt.content_hash, run_id: 'run-old' }],
      }] }),
    }) });
    await expect(authority.acceptRunReceipt({
      packet: nextPacket,
      receipt: receipt(nextPacket, { payload: { mutations_attempted: ['pr.opened'], mutations_authorized: ['pr.opened'] } }),
      session_id: 'session-1',
    })).rejects.toMatchObject({ code: 'PR_LIFECYCLE_REPLAY_CONFLICT' });
    expect(writes).toBe(0);
  });

  test('merges only from accepted packet/receipt linkage and re-probes ownership', async () => {
    let merges = 0;
    const workPacket = packet({ payload: { target: { pr_number: 514, branch: 'codex/test', git_common_dir: '/repo/.git', url: 'https://example.test/pull/514' } } });
    const runReceipt = receipt(workPacket);
    const authority = createPrLifecycleAuthority({
      provider: provider({ mergePr: async (value) => { merges += 1; return { merged: true, linkage: value }; } }),
    });
    await authority.acceptRunReceipt({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' });
    const result = await authority.mergeWorkPacket({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' });
    expect(result.merged).toBe(true);
    expect(merges).toBe(1);
    expect(result.linkage).toMatchObject({ issue_id: ISSUE_ID, repository_id: REPOSITORY_ID, head: HEAD });
  });

  test('records terminal linkage only after an explicitly successful merge', async () => {
    const events = [];
    let durable;
    const workPacket = packet();
    const runReceipt = receipt(workPacket);
    const authority = createPrLifecycleAuthority({ provider: provider({
      mergePr: async () => { events.push('merge'); return { merged: true }; },
      recordPrLinkage: async (value) => { events.push(`record:${value.phase}`); durable = value; return { ok: true }; },
      readTrace: async () => durable ? { pull_requests: [{
        number: 514, repo: REPOSITORY_ID, head_sha: HEAD, issue_id: ISSUE_ID,
        iterations: [{ type: 'pr.merged', work_packet_hash: durable.work_packet.content_hash, run_receipt_hash: durable.run_receipt.content_hash }],
      }] } : { pull_requests: [] },
    }) });
    await authority.acceptRunReceipt({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' });
    expect(events).toEqual([]);
    await authority.mergeWorkPacket({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' });
    expect(events).toEqual(['merge', 'record:merged']);
  });

  test('serializes concurrent identical merge attempts and passes an exact idempotency key', async () => {
    let merges = 0;
    let releaseMerge;
    let durable;
    const workPacket = packet();
    const runReceipt = receipt(workPacket);
    const authority = createPrLifecycleAuthority({ provider: provider({
      mergePr: async input => {
        merges += 1;
        expect(input.idempotency_key).toMatch(/^pr-merge:[0-9a-f]{64}$/);
        await new Promise(resolve => { releaseMerge = resolve; });
        return { merged: true };
      },
      recordPrLinkage: async value => { durable = value; return { ok: true }; },
      readTrace: async () => durable ? { pull_requests: [{
        number: 514, repo: REPOSITORY_ID, head_sha: HEAD, issue_id: ISSUE_ID,
        iterations: [{ type: 'pr.merged', work_packet_hash: workPacket.content_hash,
          work_packet_identity: packetIdentity(workPacket), run_receipt_hash: runReceipt.content_hash }],
      }] } : { pull_requests: [] },
    }) });
    const first = authority.mergeWorkPacket({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' });
    while (!releaseMerge) await new Promise(resolve => setTimeout(resolve, 1));
    const second = authority.mergeWorkPacket({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' });
    releaseMerge();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(merges).toBe(1);
  });

  test('releases failed merge serialization for retry and keeps different targets independent', async () => {
    const attempts = new Map();
    const releases = new Map();
    const durable = new Map();
    const packet514 = packet();
    const receipt514 = receipt(packet514);
    const packet515 = packet({ payload: {
      packet_id: 'packet-2',
      target: { pr_number: 515, branch: 'codex/other', git_common_dir: '/repo/.git', url: 'https://example.test/pull/515' },
    } });
    const receipt515 = receipt(packet515, { payload: { run_id: 'run-2', attempt_id: 'attempt-2' } });
    const authority = createPrLifecycleAuthority({ provider: provider({
      mergePr: async input => {
        const number = input.linkage.pr_number;
        attempts.set(number, (attempts.get(number) ?? 0) + 1);
        if (number === 514 && attempts.get(number) === 1) throw new Error('transient');
        await new Promise(resolve => { releases.set(number, resolve); });
        return { merged: true };
      },
      recordPrLinkage: async value => { durable.set(value.number, value); return { ok: true }; },
      readTrace: async target => {
        const value = durable.get(target.pr_number);
        return value ? { pull_requests: [{ number: value.number, repo: REPOSITORY_ID, head_sha: HEAD, issue_id: ISSUE_ID,
          iterations: [{ type: 'pr.merged', work_packet_hash: value.work_packet.content_hash,
            work_packet_identity: packetIdentity(value.work_packet), run_receipt_hash: value.run_receipt.content_hash }] }] }
          : { pull_requests: [] };
      },
    }) });
    await expect(authority.mergeWorkPacket({ packet: packet514, receipt: receipt514, session_id: 'session-1' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_UNAVAILABLE' });
    const retry514 = authority.mergeWorkPacket({ packet: packet514, receipt: receipt514, session_id: 'session-1' });
    const merge515 = authority.mergeWorkPacket({ packet: packet515, receipt: receipt515, session_id: 'session-1' });
    while (!releases.has(514) || !releases.has(515)) await new Promise(resolve => setTimeout(resolve, 1));
    expect(attempts).toEqual(new Map([[514, 2], [515, 1]]));
    releases.get(514)();
    releases.get(515)();
    await expect(Promise.all([retry514, merge515])).resolves.toHaveLength(2);
  });

  test('rejects a divergent receipt queued behind an identical merge', async () => {
    let releaseMerge;
    let durable;
    let merges = 0;
    const workPacket = packet();
    const acceptedReceipt = receipt(workPacket);
    const divergentReceipt = receipt(workPacket, { payload: { attempt_id: 'attempt-2' } });
    const authority = createPrLifecycleAuthority({ provider: provider({
      mergePr: async () => { merges += 1; await new Promise(resolve => { releaseMerge = resolve; }); return { merged: true }; },
      recordPrLinkage: async value => { durable = value; return { ok: true }; },
      readTrace: async () => durable ? { pull_requests: [{ number: 514, repo: REPOSITORY_ID, head_sha: HEAD, issue_id: ISSUE_ID,
        iterations: [{ type: 'pr.merged', work_packet_hash: workPacket.content_hash,
          work_packet_identity: packetIdentity(workPacket), run_receipt_hash: acceptedReceipt.content_hash,
          run_id: acceptedReceipt.payload.run_id }] }] } : { pull_requests: [] },
    }) });
    const first = authority.mergeWorkPacket({ packet: workPacket, receipt: acceptedReceipt, session_id: 'session-1' });
    while (!releaseMerge) await new Promise(resolve => setTimeout(resolve, 1));
    const divergent = authority.mergeWorkPacket({ packet: workPacket, receipt: divergentReceipt, session_id: 'session-1' })
      .then(() => null, error => error);
    releaseMerge();
    await expect(first).resolves.toMatchObject({ merged: true });
    await expect(divergent).resolves.toMatchObject({ code: 'PR_LIFECYCLE_REPLAY_CONFLICT' });
    expect(merges).toBe(1);
  });

  test('does not record terminal linkage when the merge provider reports failure', async () => {
    let writes = 0;
    const workPacket = packet();
    const runReceipt = receipt(workPacket);
    const authority = createPrLifecycleAuthority({ provider: provider({
      mergePr: async () => ({ merged: false }),
      recordPrLinkage: async () => { writes += 1; return { ok: true }; },
    }) });
    await authority.acceptRunReceipt({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' });
    await expect(authority.mergeWorkPacket({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_UNAVAILABLE' });
    expect(writes).toBe(0);
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
    await authority.acceptRunReceipt({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' });
    await expect(authority.mergeWorkPacket({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' }))
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
    await expect(authority.acceptRunReceipt({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_LINKAGE_UNAVAILABLE' });
    expect(merges).toBe(0);
  });

  test('keeps receipt acceptance non-terminal until merge succeeds', async () => {
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
    const result = await authority.acceptRunReceipt({ packet: workPacket, receipt: receipt(workPacket), session_id: 'session-1' });
    expect(result.accepted).toBe(true);
    expect(writes).toBe(0);
    await authority.mergeWorkPacket({ packet: workPacket, receipt: receipt(workPacket), session_id: 'session-1' });
    expect(writes).toBe(1);
  });

  test('persists opened receipt acceptance without recording a premature merge', async () => {
    const phases = [];
    const workPacket = packet({ payload: { allowed_mutations: ['pr.opened'] } });
    const runReceipt = receipt(workPacket, { payload: {
      mutations_attempted: ['pr.opened'], mutations_authorized: ['pr.opened'],
    } });
    const authority = createPrLifecycleAuthority({ provider: provider({
      recordPrLinkage: async value => { phases.push(value.phase); return { ok: true }; },
    }) });
    await authority.acceptRunReceipt({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' });
    expect(phases).toEqual(['opened']);
  });

  test('derives opened PR linkage from terminal receipt evidence', async () => {
    let recorded;
    const workPacket = packet({ payload: {
      allowed_mutations: ['pr.opened'],
      target: { branch: 'codex/test', git_common_dir: '/repo/.git' },
    } });
    const runReceipt = receipt(workPacket, { payload: {
      mutations_attempted: ['pr.opened'], mutations_authorized: ['pr.opened'],
      evidence_refs: [{ kind: 'pr', pr_number: 515, url: 'https://example.test/pull/515' }],
    } });
    const authority = createPrLifecycleAuthority({ provider: provider({
      recordPrLinkage: async value => { recorded = value; return { ok: true }; },
      readTrace: async () => recorded ? { pull_requests: [{ number: 515, repo: REPOSITORY_ID, head_sha: HEAD,
        issue_id: ISSUE_ID, iterations: [{ type: 'pr.opened', work_packet_hash: workPacket.content_hash,
          work_packet_identity: packetIdentity(workPacket), run_receipt_hash: runReceipt.content_hash }] }] }
        : { pull_requests: [] },
    }) });
    await authority.acceptRunReceipt({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' });
    expect(recorded).toMatchObject({ phase: 'opened', number: 515, url: 'https://example.test/pull/515' });
  });

  test('rejects missing PR number and wrong receipt provenance before merge side effects', async () => {
    let merges = 0;
    const missingNumber = packet({ payload: { target: { branch: 'codex/test', git_common_dir: '/repo/.git', url: 'https://example.test/pull/514' } } });
    const wrongActor = packet();
    const wrongReceipt = receipt(wrongActor, { provenance: { source_kind: 'execution', actor_class: 'system', actor_id: 'evil-flow' },
      producer: { product_id: 'other-product', product_version: '1', instance_id: 'evil-flow' } });
    const authority = createPrLifecycleAuthority({ provider: provider({ mergePr: async () => { merges += 1; return { merged: true }; } }) });
    await expect(authority.mergeWorkPacket({ packet: missingNumber, receipt: receipt(missingNumber), session_id: 'session-1' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_LINKAGE_UNAVAILABLE' });
    await expect(authority.mergeWorkPacket({ packet: wrongActor, receipt: wrongReceipt, session_id: 'session-1' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_CONTRACT_INVALID' });
    expect(merges).toBe(0);
  });

  test('fails closed when terminal linkage cannot be written or proved after merge', async () => {
    const workPacket = packet({ payload: {
      target: { pr_number: 514, branch: 'codex/test', git_common_dir: '/repo/.git', url: 'https://example.test/pull/514' },
    } });
    const writeFails = createPrLifecycleAuthority({
      provider: provider({ recordPrLinkage: async () => { throw new Error('write failed'); } }),
    });
    await writeFails.acceptRunReceipt({ packet: workPacket, receipt: receipt(workPacket), session_id: 'session-1' });
    await expect(writeFails.mergeWorkPacket({ packet: workPacket, receipt: receipt(workPacket), session_id: 'session-1' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_UNAVAILABLE' });
    const traceMissing = createPrLifecycleAuthority({
      provider: provider({ recordPrLinkage: async () => ({ ok: true }), readTrace: async () => ({ pull_requests: [] }) }),
    });
    await traceMissing.acceptRunReceipt({ packet: workPacket, receipt: receipt(workPacket), session_id: 'session-1' });
    await expect(traceMissing.mergeWorkPacket({ packet: workPacket, receipt: receipt(workPacket), session_id: 'session-1' }))
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
    } }), session_id: 'session-1' });
    expect(result.accepted).toBe(true);
    expect(phases).toEqual([]);
    await authority.mergeWorkPacket({ packet: workPacket, receipt: receipt(workPacket), session_id: 'session-1' });
    expect(phases).toEqual(['merged']);
  });

  test('selects merged when a receipt carries both completed lifecycle phases', async () => {
    const phases = [];
    const workPacket = packet({ payload: { allowed_mutations: ['pr.opened', 'pr.merged'] } });
    const runReceipt = receipt(workPacket, { payload: {
      mutations_attempted: ['pr.opened', 'pr.merged'],
      mutations_authorized: ['pr.opened', 'pr.merged'],
    } });
    const authority = createPrLifecycleAuthority({
      provider: provider({
        recordPrLinkage: async (value) => { phases.push(value.phase); return { ok: true }; },
      }),
    });
    await authority.acceptRunReceipt({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' });
    await expect(authority.mergeWorkPacket({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' }))
      .resolves.toMatchObject({ merged: true });
    expect(phases[0]).toBe('merged');
  });

  test('scopes durable evidence and trace targets to the accepted PR', async () => {
    let traceTargetSeen;
    const workPacket = packet();
    const runReceipt = receipt(workPacket);
    const other = packet({ payload: { target: { ...packet().payload.target, pr_number: 515 } } });
    const otherReceipt = receipt(other);
    const authority = createPrLifecycleAuthority({
      provider: provider({
        recordPrLinkage: async () => ({ ok: true }),
        readTrace: async (target) => {
          traceTargetSeen = target;
          return {
            artifacts: { plan: { content: 'x'.repeat(65_537) } },
            pull_requests: [
              { number: 514, repo: REPOSITORY_ID, head_sha: HEAD, issue_id: ISSUE_ID, iterations: [] },
              { number: 515, repo: REPOSITORY_ID, head_sha: HEAD, issue_id: ISSUE_ID, iterations: [{ work_packet_hash: other.content_hash, run_receipt_hash: otherReceipt.content_hash }] },
            ],
          };
        },
      }),
    });
    await authority.acceptRunReceipt({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' });
    await expect(authority.mergeWorkPacket({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_NOT_ACCEPTED' });
    expect(traceTargetSeen).toEqual({ issue_id: ISSUE_ID, repository_id: REPOSITORY_ID, repo: REPOSITORY_ID, pr_number: 514, git_common_dir: '/repo/.git' });
  });

  test('bounds provider trace row scanning before lifecycle projection', async () => {
    const workPacket = packet();
    const authority = createPrLifecycleAuthority({
      provider: provider({
        readTrace: async () => ({ pull_requests: Array.from({ length: 129 }, (_, index) => ({ number: index + 1 })) }),
      }),
    });
    await expect(authority.acceptRunReceipt({ packet: workPacket, receipt: receipt(workPacket), session_id: 'session-1' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_INVALID_INPUT' });
  });

  test('rejects authoritative trace truncation before lifecycle side effects', async () => {
    let merges = 0;
    let writes = 0;
    const workPacket = packet();
    const authority = createPrLifecycleAuthority({ provider: provider({
      mergePr: async () => { merges += 1; return { merged: true }; },
      recordPrLinkage: async () => { writes += 1; return { ok: true }; },
      readTrace: async () => ({ gaps: ['pull_requests:overflow'], pull_requests: [] }),
    }) });
    await expect(authority.mergeWorkPacket({ packet: workPacket, receipt: receipt(workPacket), session_id: 'session-1' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_REPLAY_CONFLICT' });
    expect({ merges, writes }).toEqual({ merges: 0, writes: 0 });
  });

  test('retries linkage persistence after a confirmed merge without invoking merge twice', async () => {
    let merges = 0;
    let writes = 0;
    let durable;
    const workPacket = packet();
    const runReceipt = receipt(workPacket);
    const authority = createPrLifecycleAuthority({ provider: provider({
      mergePr: async () => { merges += 1; return { merged: true }; },
      recordPrLinkage: async value => {
        writes += 1;
        if (writes === 1) throw new Error('transient Kernel write');
        durable = value;
        return { ok: true };
      },
      readTrace: async () => durable ? { pull_requests: [{ number: 514, repo: REPOSITORY_ID, head_sha: HEAD, issue_id: ISSUE_ID,
        iterations: [{ type: 'pr.merged', work_packet_hash: workPacket.content_hash,
          work_packet_identity: packetIdentity(workPacket), run_receipt_hash: runReceipt.content_hash }] }] }
        : { pull_requests: [] },
    }) });
    await expect(authority.mergeWorkPacket({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_UNAVAILABLE' });
    await expect(authority.mergeWorkPacket({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' }))
      .resolves.toMatchObject({ merged: true });
    expect({ merges, writes }).toEqual({ merges: 1, writes: 2 });
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

  test('unwraps the Kernel ready envelope without reranking', async () => {
    const base = provider();
    delete base.listReadyWork;
    base.runIssueOperation = async () => ({ ok: true, data: { issues: [{ id: 'z' }, { id: 'a' }], count: 2 } });
    const authority = createPrLifecycleAuthority({ provider: base });
    await expect(authority.requestNextWork()).resolves.toEqual([{ id: 'z' }, { id: 'a' }]);
  });

  test('projects an ordered bounded ready subset before snapshotting the Kernel envelope', async () => {
    const base = provider();
    delete base.listReadyWork;
    base.runIssueOperation = async () => ({ ok: true, data: { issues: Array.from({ length: 140 }, (_, index) => ({
      id: `issue-${index}`, title: `title-${index}`, body: 'x'.repeat(1_000), rank: index,
    })), count: 140 } });
    const authority = createPrLifecycleAuthority({ provider: base });
    const ready = await authority.requestNextWork();
    expect(ready.length).toBeGreaterThan(0);
    expect(ready.length).toBeLessThanOrEqual(128);
    expect(ready.length).toBeLessThan(140);
    expect(ready[0].id).toBe('issue-0');
    expect(ready.at(-1).id).toBe(`issue-${ready.length - 1}`);
  });

  test('does not conceal malformed ready entries behind bounded projection', async () => {
    const malformed = {};
    Object.defineProperty(malformed, 'id', { enumerable: true, get: () => 'issue-1' });
    const base = provider({ listReadyWork: async () => [{ id: 'issue-0' }, malformed] });
    const authority = createPrLifecycleAuthority({ provider: base });
    await expect(authority.requestNextWork()).rejects.toMatchObject({ code: 'PR_LIFECYCLE_UNAVAILABLE' });
  });

  test('does not treat durable opened evidence as a completed merge replay', async () => {
    let merges = 0;
    const workPacket = packet({ payload: { allowed_mutations: ['pr.opened', 'pr.merged'] } });
    const runReceipt = receipt(workPacket, { payload: {
      mutations_attempted: ['pr.opened', 'pr.merged'], mutations_authorized: ['pr.opened', 'pr.merged'],
    } });
    let phase = 'opened';
    const authority = createPrLifecycleAuthority({ provider: provider({
      mergePr: async () => { merges += 1; return { merged: true }; },
      recordPrLinkage: async value => { phase = value.phase; return { ok: true }; },
      readTrace: async () => ({ pull_requests: [{ number: 514, repo: REPOSITORY_ID, head_sha: HEAD, issue_id: ISSUE_ID,
        iterations: [{ type: `pr.${phase}`, work_packet_hash: workPacket.content_hash,
          work_packet_identity: packetIdentity(workPacket), run_receipt_hash: runReceipt.content_hash }] }] }),
    }) });
    await authority.mergeWorkPacket({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' });
    expect(merges).toBe(1);
    expect(phase).toBe('merged');
  });

  test('rejects contradictory packet prohibitions before lifecycle side effects', async () => {
    let writes = 0;
    let merges = 0;
    const workPacket = packet({ payload: { prohibited_actions: ['pr.merged'] } });
    const runReceipt = receipt(workPacket);
    const authority = createPrLifecycleAuthority({ provider: provider({
      recordPrLinkage: async () => { writes += 1; return { ok: true }; },
      mergePr: async () => { merges += 1; return { merged: true }; },
    }) });
    await expect(authority.acceptRunReceipt({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_MUTATION_UNAUTHORIZED' });
    await expect(authority.mergeWorkPacket({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_MUTATION_UNAUTHORIZED' });
    expect(writes).toBe(0);
    expect(merges).toBe(0);
  });

  test('rejects ambiguous duplicate PR trace rows before merge side effects', async () => {
    let merges = 0;
    const workPacket = packet();
    const runReceipt = receipt(workPacket);
    const row = () => ({ number: 514, repo: REPOSITORY_ID, head_sha: HEAD, issue_id: ISSUE_ID, iterations: [] });
    const authority = createPrLifecycleAuthority({
      provider: provider({
        readTrace: async () => ({ pull_requests: [row(), row()] }),
        mergePr: async () => { merges += 1; return { merged: true }; },
      }),
    });
    await expect(authority.acceptRunReceipt({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_LINKAGE_CONFLICT' });
    expect(merges).toBe(0);
  });

  test('rejects non-array acceptance criteria and prohibited actions at issuance', async () => {
    const authority = createPrLifecycleAuthority({ provider: provider() });
    for (const field of ['acceptance_criteria', 'prohibited_actions']) {
      await expect(authority.issueWorkPacket({
        issue_id: ISSUE_ID,
        repository_id: REPOSITORY_ID,
        actor_id: 'agent-1', session_id: 'session-1',
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
      session_id: 'session-1',
    })).rejects.toMatchObject({ code: 'PR_LIFECYCLE_MUTATION_UNAUTHORIZED' });
    await expect(authority.acceptRunReceipt({
      packet: workPacket,
      receipt: receipt(workPacket, { payload: { mutations_attempted: ['pr.merge'], mutations_authorized: ['pr.merge', 'files'] } }),
      session_id: 'session-1',
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
      session_id: 'session-1',
    })).rejects.toMatchObject({ code: 'PR_LIFECYCLE_MUTATION_UNAUTHORIZED' });
    expect(writes).toBe(0);
  });

  test('requires receipt provenance to match its trusted Flow producer', async () => {
    const workPacket = packet();
    const authority = createPrLifecycleAuthority({ provider: provider() });
    await expect(authority.acceptRunReceipt({
      packet: workPacket,
      receipt: receipt(workPacket, { provenance: { source_kind: 'execution', actor_class: 'system', actor_id: 'flow-2' } }),
      session_id: 'session-1',
    })).rejects.toMatchObject({ code: 'PR_LIFECYCLE_CONTRACT_INVALID' });
  });

  test('rejects a caller-forged Flow receipt without authenticated verifier evidence', async () => {
    let merges = 0;
    let writes = 0;
    const workPacket = packet();
    const forged = receipt(workPacket);
    const authority = createPrLifecycleAuthority({
      provider: provider({
        mergePr: async () => { merges += 1; return { merged: true }; },
        recordPrLinkage: async () => { writes += 1; return { ok: true }; },
      }),
      receiptVerifier: async identity => ({
        authenticated: false,
        ...identity,
      }),
    });
    await expect(authority.acceptRunReceipt({ packet: workPacket, receipt: forged, session_id: 'session-1' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_CONTRACT_INVALID' });
    await expect(authority.mergeWorkPacket({ packet: workPacket, receipt: forged, session_id: 'session-1' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_CONTRACT_INVALID' });
    expect({ merges, writes }).toEqual({ merges: 0, writes: 0 });

    const mismatchedVerifier = createPrLifecycleAuthority({
      provider: provider({ mergePr: async () => { merges += 1; return { merged: true }; } }),
      receiptVerifier: async identity => ({ authenticated: true, ...identity, packet_hash: 'f'.repeat(64) }),
    });
    await expect(mismatchedVerifier.mergeWorkPacket({ packet: workPacket, receipt: forged, session_id: 'session-1' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_CONTRACT_INVALID' });
    expect(merges).toBe(0);
  });

  test('projects oversized direct and Kernel issue responses before snapshotting', async () => {
    const oversizedIssue = { id: ISSUE_ID, revision: 7, status: 'open', ready: true,
      objective: 'merge a ready PR', comments: Array.from({ length: 200 }, () => ({ body: 'x'.repeat(1_000) })) };
    const direct = createPrLifecycleAuthority({ provider: provider({ readIssue: async () => oversizedIssue }) });
    await expect(direct.issueWorkPacket({ issue_id: ISSUE_ID, repository_id: REPOSITORY_ID,
      actor_id: 'agent-1', session_id: 'session-1' })).resolves.toHaveProperty('packet');

    const fallbackProvider = provider();
    delete fallbackProvider.readIssue;
    fallbackProvider.runIssueOperation = async operation => operation === 'show'
      ? { ok: true, data: oversizedIssue }
      : null;
    const fallback = createPrLifecycleAuthority({ provider: fallbackProvider });
    await expect(fallback.issueWorkPacket({ issue_id: ISSUE_ID, repository_id: REPOSITORY_ID,
      actor_id: 'agent-1', session_id: 'session-1' })).resolves.toHaveProperty('packet');
  });

  test('rejects invented runIssueOperation live probe operations', async () => {
    const base = provider();
    for (const method of ['readIssue', 'readOwnership', 'readHead', 'readCapability', 'readRisk', 'readGates']) {
      delete base[method];
    }
    base.runIssueOperation = async (operation, args) => {
      if (operation === 'show') return { ok: true, data: { id: args[0], revision: 7, status: 'open', ready: true } };
      if (operation === 'owns') return { ok: true, data: { owned: true, actor_id: 'agent-1', session_id: 'session-1' } };
      if (operation === 'readHead') return { repository_id: REPOSITORY_ID, head: HEAD };
      if (operation === 'readCapability') return { digest: DIGEST, approved: true, config_revision: CONFIG_REVISION };
      if (operation === 'readRisk') return { approved: true, digest: 'c'.repeat(64) };
      if (operation === 'readGates') return { complete: true, approved: true, ids: ['gate-1'] };
      throw new Error(`unexpected operation ${operation}`);
    };
    const authority = createPrLifecycleAuthority({ provider: base });
    await expect(authority.issueWorkPacket({ issue_id: ISSUE_ID, repository_id: REPOSITORY_ID, actor_id: 'agent-1', session_id: 'session-1' }))
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
    const result = await authority.issueWorkPacket({ issue_id: ISSUE_ID, repository_id: REPOSITORY_ID, actor_id: 'agent-1', session_id: 'session-1' });
    expect(result.packet.payload.target_head).toBe(HEAD);
  });

  test('requires an explicit merge provider before public merge persistence', async () => {
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
    await authority.acceptRunReceipt({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' });
    await expect(authority.mergeWorkPacket({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_UNAVAILABLE' });
    expect(calls).toHaveLength(0);
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
    await authority.acceptRunReceipt({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' });
    await authority.mergeWorkPacket({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' });
    expect(traceReads).toBe(3);
  });

  test('reconstructs replay authority from durable trace across facade instances', async () => {
    let durable = null;
    const durableProvider = provider({
      recordPrLinkage: async ({ phase, work_packet: acceptedPacket, run_receipt: acceptedReceipt }) => {
        durable = { phase, packet: acceptedPacket, receipt: acceptedReceipt };
        return { accepted: true };
      },
      readTrace: async () => durable ? {
        pull_requests: [{
          number: 514,
          repo: REPOSITORY_ID,
          head_sha: durable.packet.payload.target_head,
          issue_id: durable.packet.payload.issue_id,
          iterations: [{
            type: `pr.${durable.phase}`,
            work_packet_hash: durable.packet.content_hash,
            work_packet_identity: packetIdentity(durable.packet),
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
    await first.acceptRunReceipt({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' });
    await first.mergeWorkPacket({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' });
    const second = createPrLifecycleAuthority({ provider: durableProvider });
    const replay = await second.acceptRunReceipt({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' });
    expect(replay.accepted).toBe(true);
    await second.mergeWorkPacket({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' });
    const divergent = receipt(workPacket, { payload: { validation: { status: 'PASS', note: 'different' } } });
    await expect(second.acceptRunReceipt({ packet: workPacket, receipt: divergent, session_id: 'session-1' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_REPLAY_CONFLICT' });
  });

  test('does not return raw provider receipt or merge objects and rejects hostile probe data', async () => {
    const workPacket = packet();
    const runReceipt = receipt(workPacket);
    const authority = createPrLifecycleAuthority({
      provider: provider({ recordPrLinkage: async () => ({ token: 'sk-live_1234567890123456', 'sk-live_1234567890123456': 'hidden' }) }),
    });
    const accepted = await authority.acceptRunReceipt({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' });
    expect(JSON.stringify(accepted)).not.toContain('sk-live_');
    const hostile = createPrLifecycleAuthority({
      provider: provider({ readIssue: async () => ({ id: ISSUE_ID, revision: 7, status: 'open', ready: true, objective: 'C:\\Users\\alice\\secret' }) }),
    });
    await expect(hostile.issueWorkPacket({ issue_id: ISSUE_ID, repository_id: REPOSITORY_ID, actor_id: 'agent-1', session_id: 'session-1' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_PRIVACY_REJECTED' });
    for (const readIssue of [
      async () => ({ id: ISSUE_ID, revision: 7, status: 'open', ready: true, objective: 'sk-live_1234567890123456' }),
    ]) {
      const secretAuthority = createPrLifecycleAuthority({ provider: provider({ readIssue }) });
      await expect(secretAuthority.issueWorkPacket({ issue_id: ISSUE_ID, repository_id: REPOSITORY_ID, actor_id: 'agent-1', session_id: 'session-1' }))
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
      await expect(authority.acceptRunReceipt({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' }))
        .rejects.toMatchObject({ code: 'PR_LIFECYCLE_CAPABILITY_INVALID' });
    }
  });

  test('rejects a divergent receipt at merge even when the run id is reused', async () => {
    let merges = 0;
    const workPacket = packet({ payload: { target: { pr_number: 514, branch: 'codex/test', git_common_dir: '/repo/.git', url: 'https://example.test/pull/514' } } });
    const runReceipt = receipt(workPacket);
    let durable;
    const authority = createPrLifecycleAuthority({ provider: provider({
      mergePr: async () => { merges += 1; return { merged: true }; },
      recordPrLinkage: async value => { durable = value; return { ok: true }; },
      readTrace: async () => durable ? { pull_requests: [{ number: 514, repo: REPOSITORY_ID, head_sha: HEAD,
        issue_id: ISSUE_ID, iterations: [{ type: 'pr.merged', work_packet_hash: durable.work_packet.content_hash,
          work_packet_identity: packetIdentity(durable.work_packet), run_receipt_hash: durable.run_receipt.content_hash }] }] }
        : { pull_requests: [] },
    }) });
    await authority.acceptRunReceipt({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' });
    await authority.mergeWorkPacket({ packet: workPacket, receipt: runReceipt, session_id: 'session-1' });
    const divergent = receipt(workPacket, { payload: { validation: { status: 'PASS', note: 'different' } } });
    await expect(authority.mergeWorkPacket({ packet: workPacket, receipt: divergent, session_id: 'session-1' }))
      .rejects.toMatchObject({ code: 'PR_LIFECYCLE_REPLAY_CONFLICT' });
    expect(merges).toBe(1);
  });
});
