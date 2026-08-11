'use strict';

const { createHash, randomUUID } = require('node:crypto');
const {
  canonicalize,
  computeContentHash,
  validateContract,
  validateContractStructure,
} = require('@forge/memory-contracts');

const WORK_PACKET_SCHEMA = 'forge.memory.work-packet.v1';
const RUN_RECEIPT_SCHEMA = 'forge.memory.run-receipt.v1';
const HEAD_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAX_SNAPSHOT_DEPTH = 10;
const MAX_SNAPSHOT_NODES = 2_000;
const MAX_SNAPSHOT_BYTES = 65_536;

const PR_LIFECYCLE_PROVIDER_METHODS = Object.freeze([
  'readIssue',
  'readOwnership',
  'readHead',
  'readCapability',
  'readRisk',
  'readGates',
  'recordRunReceipt',
  'mergePr',
  'listReadyWork',
]);

class PrLifecycleAuthorityError extends Error {
  constructor(code, message, options = {}) {
    super(message, Object.hasOwn(options, 'cause') ? { cause: options.cause } : undefined);
    this.name = 'PrLifecycleAuthorityError';
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new PrLifecycleAuthorityError(code, message, options);
}

function snapshot(value, label) {
  try {
    const serialized = canonicalize(value, {
      maxDepth: MAX_SNAPSHOT_DEPTH,
      maxNodes: MAX_SNAPSHOT_NODES,
      maxBytes: MAX_SNAPSHOT_BYTES,
    });
    return JSON.parse(serialized);
  } catch (error) {
    fail('PR_LIFECYCLE_INVALID_INPUT', `${label} must be bounded plain JSON`, { cause: error });
  }
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    fail('PR_LIFECYCLE_INVALID_INPUT', `${label} must be a bounded non-empty string`);
  }
  return value;
}

function requiredHead(value, label) {
  if (typeof value !== 'string' || !HEAD_PATTERN.test(value)) {
    fail('PR_LIFECYCLE_HEAD_STALE', `${label} is not a valid exact head`);
  }
  return value;
}

function requiredLinkageHead(value) {
  requiredHead(value, 'PR linkage exact head');
  if (value.length !== 40) fail('PR_LIFECYCLE_HEAD_STALE', 'PR linkage requires a 40-character commit head');
  return value;
}

function requiredHash(value, label) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    fail('PR_LIFECYCLE_CONTRACT_INVALID', `${label} is not a valid digest`);
  }
  return value;
}

function callProvider(provider, names, args, label, fallbackName = names[0]) {
  const name = names.find((candidate) => typeof provider[candidate] === 'function');
  const operation = name || (typeof provider.runIssueOperation === 'function' ? 'runIssueOperation' : null);
  if (!operation) fail('PR_LIFECYCLE_UNAVAILABLE', `${label} provider operation is unavailable`);
  let result;
  try {
    if (operation === 'runIssueOperation') {
      let operationArgs = args;
      let context = {};
      if (fallbackName === 'owns' && args[0] && typeof args[0] === 'object') {
        operationArgs = [args[0].issue_id];
        context = { actor: args[0].actor_id, sessionId: args[0].session_id };
      }
      result = provider.runIssueOperation(fallbackName, operationArgs, context);
    } else {
      result = provider[operation](...args);
    }
  } catch (error) {
    fail('PR_LIFECYCLE_UNAVAILABLE', `${label} provider operation failed`, { cause: error });
  }
  return Promise.resolve(result).then((value) => {
    const bounded = snapshot(value, `${label} provider response`);
    if (operation === 'runIssueOperation' && bounded?.ok === true && bounded.data !== undefined) {
      return bounded.data;
    }
    return bounded;
  }, (error) => {
    if (error instanceof PrLifecycleAuthorityError) throw error;
    fail('PR_LIFECYCLE_UNAVAILABLE', `${label} provider operation failed`, { cause: error });
  });
}

function providerIssueRevision(issue) {
  const revision = issue?.revision ?? issue?.issue_revision;
  if (!Number.isInteger(revision) || revision < 0) fail('PR_LIFECYCLE_REVISION_STALE', 'live issue revision is unavailable');
  return revision;
}

function providerHead(head, repositoryId) {
  const value = typeof head === 'string' ? { head } : head;
  const exactHead = value?.head ?? value?.exact_head ?? value?.target_head;
  requiredLinkageHead(exactHead);
  const repo = value?.repository_id ?? value?.repository ?? repositoryId;
  requiredString(repo, 'repository_id');
  if (repositoryId && repo !== repositoryId) fail('PR_LIFECYCLE_HEAD_STALE', 'live repository does not match packet');
  return { head: exactHead, repository_id: repo };
}

function assertLiveIssue(issue, expectedIssueId) {
  const id = issue?.id ?? issue?.issue_id;
  if (id !== expectedIssueId) fail('PR_LIFECYCLE_READINESS_STALE', 'live issue identity does not match packet');
  const revision = providerIssueRevision(issue);
  const status = String(issue.status ?? issue.state ?? '').toLowerCase();
  const ready = issue.ready !== false && issue.is_ready !== false
    && (issue.ready === true || issue.is_ready === true || status === 'ready' || status === 'open');
  if (!ready || issue.blocked === true || issue.blockers > 0) {
    fail('PR_LIFECYCLE_READINESS_STALE', 'issue is not live-ready');
  }
  return revision;
}

function assertOwnership(ownership, input = {}) {
  if (!ownership || ownership.owned !== true || ownership.active === false) {
    fail('PR_LIFECYCLE_OWNERSHIP_STALE', 'live ownership is not held');
  }
  const actor = input.actor_id ?? input.actorId;
  const session = input.session_id ?? input.sessionId;
  if (actor && ownership.actor_id !== actor) fail('PR_LIFECYCLE_OWNERSHIP_STALE', 'live ownership actor mismatch');
  if (session && ownership.session_id !== session) fail('PR_LIFECYCLE_OWNERSHIP_STALE', 'live ownership session mismatch');
  return ownership;
}

function capabilityDigest(capability) {
  const digest = capability?.manifest_digest ?? capability?.digest ?? capability?.capability_manifest_digest;
  requiredHash(digest, 'live capability manifest digest');
  if (capability.approved === false || capability.available === false || capability.status === 'unavailable') {
    fail('PR_LIFECYCLE_CAPABILITY_INVALID', 'live capability is unavailable');
  }
  return digest;
}

function assertRisk(risk, expectedDigest) {
  const approved = risk?.approved === true || risk?.status === 'approved' || risk?.status === 'PASS';
  if (!approved) fail('PR_LIFECYCLE_RISK_INVALID', 'live risk evidence is incomplete or unapproved');
  const digest = risk?.risk_manifest_digest ?? risk?.digest;
  requiredHash(digest, 'live risk manifest digest');
  if (expectedDigest && digest && digest !== expectedDigest) {
    fail('PR_LIFECYCLE_RISK_INVALID', 'live risk digest does not match packet');
  }
  return { approved: true, ...(digest ? { digest } : {}) };
}

function assertGates(gates) {
  const value = Array.isArray(gates) ? { gates } : gates;
  const approved = value?.approved === true || value?.status === 'approved' || value?.status === 'PASS';
  const complete = value?.complete === true || value?.complete === undefined && Array.isArray(value?.gates);
  if (!approved || !complete || value?.conflict === true || value?.stale === true) {
    fail('PR_LIFECYCLE_GATE_INVALID', 'live gates are incomplete, stale, or conflicting');
  }
  const ids = Array.isArray(value.ids) ? value.ids : Array.isArray(value.gate_ids) ? value.gate_ids : [];
  if (ids.some((id) => typeof id !== 'string' || id.length === 0)) {
    fail('PR_LIFECYCLE_GATE_INVALID', 'live gate ids are malformed');
  }
  return { approved: true, complete: true, ids: [...ids] };
}

function assertContract(value, schema, expected) {
  const structural = validateContractStructure(value);
  if (!structural.ok || value?.schema_id !== schema) {
    fail('PR_LIFECYCLE_CONTRACT_INVALID', `${schema} contract is malformed`);
  }
  const result = expected === undefined
    ? validateContractStructure(value)
    : validateContract(value, { expected });
  if (!result.ok) {
    const codes = new Set(result.errors.map(item => item.code));
    const liveCode = codes.has('STALE_EXACT_HEAD')
      ? 'PR_LIFECYCLE_HEAD_STALE'
      : codes.has('STALE_ISSUE_REVISION')
        ? 'PR_LIFECYCLE_REVISION_STALE'
        : codes.has('WRONG_CAPABILITY_DIGEST')
          ? 'PR_LIFECYCLE_CAPABILITY_INVALID'
          : codes.has('STALE_WORKFLOW_CONFIG') ? 'PR_LIFECYCLE_REVISION_STALE' : null;
    if (liveCode) fail(liveCode, `${schema} live binding is stale`);
    const error = new PrLifecycleAuthorityError(
      'PR_LIFECYCLE_CONTRACT_INVALID',
      `${schema} contract failed live validation`,
    );
    error.errors = result.errors;
    throw error;
  }
  return value;
}

function uuidFromSeed(seed) {
  const hash = createHash('sha256').update(seed).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function buildPacket(input, live) {
  const issueId = requiredString(input.issue_id ?? input.issueId, 'issue_id');
  const repositoryId = requiredString(
    input.repository_id ?? input.repositoryId ?? live.head.repository_id,
    'repository_id',
  );
  const packetId = requiredString(
    input.packet_id ?? input.packetId ?? `packet-${issueId}-${live.issueRevision}-${live.head.head}`,
    'packet_id',
  );
  const createdAt = input.created_at ?? input.createdAt ?? new Date().toISOString();
  const objective = requiredString(input.objective ?? live.issue.objective ?? 'PR lifecycle operation', 'objective');
  const allowedMutations = input.allowed_mutations ?? input.allowedMutations ?? ['pr.merged'];
  if (!Array.isArray(allowedMutations) || allowedMutations.length === 0
    || allowedMutations.some((mutation) => typeof mutation !== 'string' || mutation.length === 0)) {
    fail('PR_LIFECYCLE_MUTATION_UNAUTHORIZED', 'allowed mutations are malformed');
  }
  const actorId = requiredString(input.actor_id ?? input.actorId ?? live.ownership.actor_id ?? 'unknown', 'actor_id');
  const packet = {
    schema_id: WORK_PACKET_SCHEMA,
    schema_version: 1,
    object_id: input.object_id ?? input.objectId ?? uuidFromSeed(`${issueId}:${packetId}:${live.head.head}`),
    created_at: createdAt,
    producer: {
      product_id: input.product_id ?? 'forge-memory',
      product_version: input.product_version ?? '0.1.0-beta.6',
      instance_id: input.instance_id ?? input.instanceId ?? randomUUID(),
    },
    capabilities_used: Array.isArray(input.capabilities_used) ? input.capabilities_used : [],
    provenance: { source_kind: 'kernel', actor_class: 'agent', actor_id: actorId },
    payload: {
      issue_id: issueId,
      expected_issue_revision: live.issueRevision,
      packet_id: packetId,
      packet_revision: Number.isInteger(input.packet_revision ?? input.packetRevision)
        ? input.packet_revision ?? input.packetRevision : 1,
      repository_id: repositoryId,
      target_head: live.head.head,
      objective,
      authority: { kind: 'kernel', issue_revision: live.issueRevision },
      allowed_mutations: [...allowedMutations],
      workflow_config_revision: requiredString(
        input.workflow_config_revision ?? input.workflowConfigRevision ?? live.workflowConfigRevision,
        'workflow_config_revision',
      ),
      capability_manifest_digest: live.capabilityDigest,
      ...(input.acceptance_criteria ? { acceptance_criteria: [...input.acceptance_criteria] } : {}),
      ...(input.prohibited_actions ? { prohibited_actions: [...input.prohibited_actions] } : {}),
      ...(input.risk ?? live.risk ? { risk: input.risk ?? live.risk } : {}),
      ...(live.risk.digest ? { risk_manifest_digest: live.risk.digest } : {}),
      ...(input.target ? { target: input.target } : {}),
      receipt_requirements: {
        terminal: true,
        gate_ids: [...live.gates.ids],
        ...(input.receipt_requirements ?? {}),
      },
    },
    extensions: {},
  };
  packet.content_hash = computeContentHash(packet);
  return packet;
}

function runIdentity(packet, receipt) {
  return `${packet.payload.issue_id}:${packet.content_hash}:${receipt.payload.run_id}:${receipt.payload.exact_head}`;
}

function assertReceiptEvidence(packet, receipt) {
  if (receipt.payload.status !== 'PASS') fail('PR_LIFECYCLE_TERMINAL_INVALID', 'RunReceipt is not terminal PASS');
  const attempted = receipt.payload.mutations_attempted ?? [];
  const authorized = receipt.payload.mutations_authorized ?? [];
  const mutation = packet.payload.allowed_mutations.includes('pr.merged')
    && attempted.includes('pr.merged')
    ? 'pr.merged'
    : packet.payload.allowed_mutations.includes('pr.merge') ? 'pr.merge' : null;
  if (!mutation) fail('PR_LIFECYCLE_MUTATION_UNAUTHORIZED', 'RunReceipt mutation phase is not authorized');
  if (!attempted.includes(mutation) || !authorized.includes(mutation)) {
    fail('PR_LIFECYCLE_MUTATION_UNAUTHORIZED', 'RunReceipt mutation evidence is incomplete');
  }
  if (receipt.payload.lease_epoch !== undefined) {
    fail('PR_LIFECYCLE_AUTHORITY_UNSUPPORTED', 'lease_epoch is deferred for 0.1');
  }
  if (receipt.payload.validation?.status !== 'PASS' || receipt.payload.cleanup?.status !== 'PASS') {
    fail('PR_LIFECYCLE_TERMINAL_INVALID', 'RunReceipt terminal validation or cleanup is incomplete');
  }
  if (!Array.isArray(receipt.payload.evidence_refs) || receipt.payload.evidence_refs.length === 0) {
    fail('PR_LIFECYCLE_TERMINAL_INVALID', 'RunReceipt terminal evidence is missing');
  }
}

function assertPacketLiveBindings(packet, live) {
  const requiredGateIds = packet.payload.receipt_requirements?.gate_ids;
  if (!Array.isArray(requiredGateIds) || requiredGateIds.length === 0
    || requiredGateIds.some((id) => typeof id !== 'string' || id.length === 0)
    || new Set(requiredGateIds).size !== requiredGateIds.length) {
    fail('PR_LIFECYCLE_GATE_INVALID', 'WorkPacket gate requirements are incomplete');
  }
  const liveIds = [...live.gates.ids];
  if (requiredGateIds.length !== liveIds.length
    || requiredGateIds.some((id) => !liveIds.includes(id))) {
    fail('PR_LIFECYCLE_GATE_INVALID', 'WorkPacket gate requirements do not match live gates');
  }
  if (!HASH_PATTERN.test(packet.payload.risk_manifest_digest || '') || !live.risk.digest
    || packet.payload.risk_manifest_digest !== live.risk.digest) {
    fail('PR_LIFECYCLE_RISK_INVALID', 'WorkPacket risk digest does not match live risk');
  }
  if (!packet.payload.allowed_mutations.includes('pr.merge')
    && !packet.payload.allowed_mutations.includes('pr.merged')) {
    fail('PR_LIFECYCLE_MUTATION_UNAUTHORIZED', 'WorkPacket does not authorize a PR merge mutation');
  }
}

function deriveLinkage(packet, receipt, gates) {
  const target = packet.payload.target ?? {};
  let prNumber = Number.isInteger(target.pr_number) ? target.pr_number : undefined;
  if (prNumber === undefined) {
    const evidence = receipt.payload.evidence_refs.find((entry) => Number.isInteger(entry?.pr_number));
    prNumber = evidence?.pr_number;
  }
  return {
    issue_id: packet.payload.issue_id,
    repository_id: packet.payload.repository_id,
    head: packet.payload.target_head,
    ...(prNumber === undefined ? {} : { pr_number: prNumber }),
    gate_ids: gates.ids,
  };
}

function assertTraceLinkage(trace, linkage) {
  if (!trace || typeof trace !== 'object' || Array.isArray(trace)) {
    fail('PR_LIFECYCLE_UNAVAILABLE', 'public PR trace is unavailable');
  }
  if (!Array.isArray(trace.pull_requests) || linkage.pr_number === undefined) return;
  const candidates = trace.pull_requests.filter((entry) => Number(entry?.number) === linkage.pr_number);
  if (candidates.length === 0) {
    fail('PR_LIFECYCLE_LINKAGE_CONFLICT', 'public PR trace does not contain the accepted PR');
  }
  const match = candidates[0];
  if ((match.head_sha && match.head_sha !== linkage.head)
    || (match.repo && match.repo !== linkage.repository_id)) {
    fail('PR_LIFECYCLE_LINKAGE_CONFLICT', 'public PR trace conflicts with accepted linkage');
  }
}

function createPrLifecycleAuthority({ provider } = {}) {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    throw new TypeError('PR lifecycle authority requires a public provider object');
  }
  for (const method of ['runIssueOperation', 'recordPrLinkage', 'readTrace']) {
    if (typeof provider[method] !== 'function') {
      throw new TypeError(`PR lifecycle provider must implement ${method}()`);
    }
  }
  const accepted = new Map();
  const merged = new Map();

  async function readLive(input, packet = null) {
    const issueId = requiredString(input.issue_id ?? input.issueId ?? packet?.payload.issue_id, 'issue_id');
    const repositoryId = input.repository_id ?? input.repositoryId ?? packet?.payload.repository_id;
    const issue = await callProvider(provider, ['readIssue', 'getIssue'], [issueId], 'issue', 'show');
    const issueRevision = assertLiveIssue(issue, issueId);
    const ownership = await callProvider(
      provider,
      ['readOwnership', 'getOwnership', 'ownsIssue'],
      [{ issue_id: issueId, actor_id: input.actor_id ?? input.actorId, session_id: input.session_id ?? input.sessionId }],
      'ownership',
      'owns',
    );
    assertOwnership(ownership, input);
    const head = await callProvider(
      provider,
      ['readHead', 'getHead'],
      [{ issue_id: issueId, repository_id: repositoryId }],
      'head',
    );
    const normalizedHead = providerHead(head, repositoryId);
    const capability = await callProvider(
      provider,
      ['readCapability', 'getCapability', 'readCapabilityManifest'],
      [{ issue_id: issueId, repository_id: normalizedHead.repository_id }],
      'capability',
    );
    const capabilityDigestValue = capabilityDigest(capability);
    const risk = await callProvider(provider, ['readRisk', 'getRisk'], [{ issue_id: issueId }], 'risk');
    const normalizedRisk = assertRisk(risk, packet?.payload.risk_manifest_digest);
    const gates = await callProvider(provider, ['readGates', 'getGates'], [{ issue_id: issueId }], 'gates');
    const normalizedGates = assertGates(gates);
    const workflowConfigRevision = requiredString(
      input.workflow_config_revision ?? input.workflowConfigRevision
        ?? packet?.payload.workflow_config_revision ?? capability.workflow_config_revision ?? capability.config_revision,
      'workflow_config_revision',
    );
    return {
      issue,
      issueRevision,
      ownership,
      head: normalizedHead,
      capability,
      capabilityDigest: capabilityDigestValue,
      risk: normalizedRisk,
      gates: normalizedGates,
      workflowConfigRevision,
    };
  }

  async function issueWorkPacket(rawInput = {}) {
    const input = snapshot(rawInput, 'issue input');
    const live = await readLive(input);
    const packet = buildPacket(input, live);
    assertContract(packet, WORK_PACKET_SCHEMA, {
      issueRevision: live.issueRevision,
      workflowConfigRevision: live.workflowConfigRevision,
      capabilityManifestDigest: live.capabilityDigest,
      exactHead: live.head.head,
    });
    assertPacketLiveBindings(packet, live);
    return { packet: snapshot(packet, 'WorkPacket'), linkage: deriveLinkage(packet, {
      payload: { evidence_refs: [] },
    }, live.gates) };
  }

  async function acceptRunReceipt(rawInput = {}) {
    const input = snapshot(rawInput, 'receipt input');
    const packet = snapshot(input.packet, 'WorkPacket');
    const receipt = snapshot(input.receipt, 'RunReceipt');
    assertContract(packet, WORK_PACKET_SCHEMA);
    assertContract(receipt, RUN_RECEIPT_SCHEMA);
    const live = await readLive({ ...input, issue_id: packet.payload.issue_id }, packet);
    assertContract(packet, WORK_PACKET_SCHEMA, {
      issueRevision: live.issueRevision,
      workflowConfigRevision: live.workflowConfigRevision,
      capabilityManifestDigest: live.capabilityDigest,
      exactHead: live.head.head,
    });
    assertPacketLiveBindings(packet, live);
    assertContract(receipt, RUN_RECEIPT_SCHEMA, {
      packetHash: packet.content_hash,
      workflowConfigRevision: packet.payload.workflow_config_revision,
      capabilityManifestDigest: packet.payload.capability_manifest_digest,
      exactHead: packet.payload.target_head,
    });
    assertReceiptEvidence(packet, receipt);
    const linkage = deriveLinkage(packet, receipt, live.gates);
    const identity = runIdentity(packet, receipt);
    const existing = accepted.get(identity);
    if (existing) {
      if (existing.receipt.content_hash !== receipt.content_hash
        || existing.packet.content_hash !== packet.content_hash) {
        fail('PR_LIFECYCLE_REPLAY_CONFLICT', 'receipt replay conflicts with accepted content');
      }
      return snapshot(existing.result, 'accepted receipt replay');
    }
    let persisted = null;
    if (['recordRunReceipt', 'recordReceipt', 'acceptRunReceipt'].some(method => typeof provider[method] === 'function')) {
      persisted = await callProvider(
        provider,
        ['recordRunReceipt', 'recordReceipt', 'acceptRunReceipt'],
        [{ packet, receipt, linkage }],
        'receipt',
      );
    }
    const result = { accepted: true, packet, receipt, linkage, provider: persisted };
    accepted.set(identity, { packet, receipt, result });
    return snapshot(result, 'accepted receipt');
  }

  async function mergeWorkPacket(rawInput = {}) {
    const input = snapshot(rawInput, 'merge input');
    const packet = snapshot(input.packet, 'WorkPacket');
    const receipt = snapshot(input.receipt, 'RunReceipt');
    const identity = runIdentity(packet, receipt);
    const acceptedResult = accepted.get(identity);
    if (!acceptedResult) fail('PR_LIFECYCLE_NOT_ACCEPTED', 'WorkPacket and RunReceipt were not accepted');
    const live = await readLive({ ...input, issue_id: packet.payload.issue_id }, packet);
    assertContract(packet, WORK_PACKET_SCHEMA, {
      issueRevision: live.issueRevision,
      workflowConfigRevision: live.workflowConfigRevision,
      capabilityManifestDigest: live.capabilityDigest,
      exactHead: live.head.head,
    });
    assertPacketLiveBindings(packet, live);
    const linkage = deriveLinkage(packet, receipt, live.gates);
    if (live.head.head !== packet.payload.target_head) fail('PR_LIFECYCLE_HEAD_STALE', 'exact head changed before merge');
    const traceTarget = linkage.pr_number === undefined
      ? { issue_id: linkage.issue_id }
      : { pr_number: linkage.pr_number, repo: linkage.repository_id };
    const trace = await callProvider(provider, ['readTrace'], [traceTarget], 'trace');
    assertTraceLinkage(trace, linkage);
    const key = `${identity}:${linkage.pr_number ?? ''}`;
    if (merged.has(key)) return snapshot(merged.get(key), 'merge replay');
    let result;
    if (typeof provider.mergePr === 'function' || typeof provider.merge === 'function') {
      result = await callProvider(provider, ['mergePr', 'merge'], [{ packet, receipt, linkage }], 'merge');
    } else {
      const target = packet.payload.target;
      if (!target || !Number.isInteger(linkage.pr_number)
        || typeof target.branch !== 'string' || typeof target.git_common_dir !== 'string') {
        fail('PR_LIFECYCLE_LINKAGE_UNAVAILABLE', 'accepted packet lacks authoritative PR linkage fields');
      }
      result = await callProvider(provider, ['recordPrLinkage'], [{
        phase: 'merged',
        git_common_dir: target.git_common_dir,
        repo: packet.payload.repository_id,
        number: linkage.pr_number,
        branch: target.branch,
        url: target.url,
        occurred_at: receipt.ended_at ?? receipt.created_at,
        work_packet: packet,
        run_receipt: receipt,
      }], 'PR linkage');
    }
    const mergedResult = { merged: true, linkage, provider: result };
    merged.set(key, mergedResult);
    return snapshot(mergedResult, 'merge result');
  }

  async function requestNextWork(rawInput = {}) {
    const input = snapshot(rawInput, 'next work input');
    const ready = await callProvider(provider, ['listReadyWork', 'ready', 'requestNextWork'], [input], 'ready');
    if (!Array.isArray(ready)) fail('PR_LIFECYCLE_UNAVAILABLE', 'ready provider returned a malformed queue');
    return snapshot(ready, 'ready queue');
  }

  const api = {
    issueWorkPacket,
    acceptRunReceipt,
    mergeWorkPacket,
    requestNextWork,
  };
  return Object.freeze(api);
}

module.exports = {
  PR_LIFECYCLE_PROVIDER_METHODS,
  PrLifecycleAuthorityError,
  createPrLifecycleAuthority,
};
