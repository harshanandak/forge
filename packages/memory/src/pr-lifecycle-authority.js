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
const SECRET_PATTERN = /(?:gh[pousr]_[A-Za-z0-9]{20,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S{8,})/i;
const USER_PATH_PATTERN = /(?:[A-Za-z]:\\Users\\[^\\\s]+|\/(?:Users|home)\/[^/\s]+\/)/i;

// This list describes optional provider capabilities; the mandatory provider surface remains
// runIssueOperation, recordPrLinkage, and readTrace (see authority-provider.js).
const PR_LIFECYCLE_PROVIDER_METHODS = Object.freeze([
  'readIssue',
  'readOwnership',
  'readHead',
  'readCapability',
  'readRisk',
  'readGates',
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

function containsForbidden(value) {
  if (typeof value === 'string') return SECRET_PATTERN.test(value) || USER_PATH_PATTERN.test(value);
  if (Array.isArray(value)) return value.some(containsForbidden);
  if (value && typeof value === 'object') return Object.values(value).some(containsForbidden);
  return false;
}

function redactForbidden(value) {
  if (typeof value === 'string') return containsForbidden(value) ? '[redacted]' : value;
  if (Array.isArray(value)) return value.map(redactForbidden);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactForbidden(item)]));
  }
  return value;
}

function snapshot(value, label, options = {}) {
  try {
    const serialized = canonicalize(value, {
      maxDepth: MAX_SNAPSHOT_DEPTH,
      maxNodes: MAX_SNAPSHOT_NODES,
      maxBytes: MAX_SNAPSHOT_BYTES,
    });
    const bounded = JSON.parse(serialized);
    if (options.privacy !== 'sanitize' && containsForbidden(bounded)) {
      fail('PR_LIFECYCLE_PRIVACY_REJECTED', `${label} contains a secret or absolute user path`);
    }
    return options.privacy === 'sanitize' ? redactForbidden(bounded) : bounded;
  } catch (error) {
    if (error instanceof PrLifecycleAuthorityError) throw error;
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

async function callMethod(target, method, args, label, options = {}) {
  let result;
  try {
    result = target[method](...args);
  } catch (error) {
    fail('PR_LIFECYCLE_UNAVAILABLE', `${label} provider operation failed`, { cause: error });
  }
  try {
    const bounded = snapshot(await Promise.resolve(result), `${label} provider response`, {
      privacy: options.sanitize ? 'sanitize' : undefined,
    });
    if (options.unwrap && bounded?.ok === true && bounded.data !== undefined) return bounded.data;
    if (options.unwrap && bounded?.ok === false) fail('PR_LIFECYCLE_UNAVAILABLE', `${label} provider rejected operation`);
    return bounded;
  } catch (error) {
    if (error instanceof PrLifecycleAuthorityError) throw error;
    fail('PR_LIFECYCLE_UNAVAILABLE', `${label} provider operation failed`, { cause: error });
  }
}

async function callProbe(provider, probes, names, args, label, fallbackName) {
  const injected = names.find((name) => typeof probes?.[name] === 'function');
  if (injected) return snapshot(await Promise.resolve(probes[injected](...args)), `${label} live probe response`);
  const direct = names.find((name) => typeof provider[name] === 'function');
  if (direct) return callMethod(provider, direct, args, label);
  // Issue read/ownership may use the public operation broker. No invented live-state
  // operation names are permitted for head, capability, risk, or gate evidence.
  if (fallbackName && typeof provider.runIssueOperation === 'function') {
    let operationArgs = args;
    let context = {};
    if (fallbackName === 'owns' && args[0] && typeof args[0] === 'object') {
      operationArgs = [args[0].issue_id];
      context = { actor: args[0].actor_id, sessionId: args[0].session_id };
    }
    return callMethod(provider, 'runIssueOperation', [fallbackName, operationArgs, context], label, { unwrap: true });
  }
  fail('PR_LIFECYCLE_UNAVAILABLE', `${label} live probe is unavailable`);
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

// 0.1 limitation: LeaseReceipt/lease_epoch is deferred. Same actor/session release and
// reacquire is ABA-indistinguishable, so every operation re-probes ownership and receipts
// never confer continuing authority.
function assertOwnership(ownership, expected = {}) {
  if (!ownership || ownership.owned !== true || ownership.active === false) {
    fail('PR_LIFECYCLE_OWNERSHIP_STALE', 'live ownership is not held');
  }
  const actorId = ownership.actor_id ?? ownership.claimed_by;
  if (expected.actor_id && actorId !== expected.actor_id) {
    fail('PR_LIFECYCLE_OWNERSHIP_STALE', 'live ownership actor mismatch');
  }
  if (expected.session_id && ownership.session_id !== expected.session_id) {
    fail('PR_LIFECYCLE_OWNERSHIP_STALE', 'live ownership session mismatch');
  }
  requiredString(actorId, 'live ownership actor_id');
  return { ...ownership, actor_id: actorId };
}

function capabilityDigest(capability) {
  const digest = capability?.manifest_digest ?? capability?.digest ?? capability?.capability_manifest_digest;
  requiredHash(digest, 'live capability manifest digest');
  if (capability.approved !== true || capability.available !== true || capability.probed !== true) {
    fail('PR_LIFECYCLE_CAPABILITY_INVALID', 'live capability must be approved, available, and positively probed');
  }
  const expiresAt = capability.expires_at ?? capability.expiresAt;
  if (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) {
    fail('PR_LIFECYCLE_CAPABILITY_INVALID', 'live capability is expired or missing expiry evidence');
  }
  return digest;
}

function assertRisk(risk, expectedDigest) {
  const approved = risk?.approved === true || risk?.status === 'approved' || risk?.status === 'PASS';
  if (!approved) fail('PR_LIFECYCLE_RISK_INVALID', 'live risk evidence is incomplete or unapproved');
  const digest = risk?.risk_manifest_digest ?? risk?.digest;
  requiredHash(digest, 'live risk manifest digest');
  if (expectedDigest && digest !== expectedDigest) fail('PR_LIFECYCLE_RISK_INVALID', 'live risk digest does not match packet');
  return { approved: true, digest };
}

function assertGates(gates) {
  const value = Array.isArray(gates) ? { gates } : gates;
  const approved = value?.approved === true || value?.status === 'approved' || value?.status === 'PASS';
  const complete = value?.complete === true || value?.complete === undefined && Array.isArray(value?.gates);
  if (!approved || !complete || value?.conflict === true || value?.stale === true) {
    fail('PR_LIFECYCLE_GATE_INVALID', 'live gates are incomplete, stale, or conflicting');
  }
  const ids = Array.isArray(value.ids) ? value.ids : Array.isArray(value.gate_ids) ? value.gate_ids : [];
  if (ids.length === 0 || ids.some((id) => typeof id !== 'string' || id.length === 0)) {
    fail('PR_LIFECYCLE_GATE_INVALID', 'live gate ids are malformed');
  }
  return { approved: true, complete: true, ids: [...ids] };
}

function assertContract(value, schema, expected) {
  const structural = validateContractStructure(value);
  if (!structural.ok || value?.schema_id !== schema) fail('PR_LIFECYCLE_CONTRACT_INVALID', `${schema} contract is malformed`);
  const result = expected === undefined ? structural : validateContract(value, { expected });
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
    const error = new PrLifecycleAuthorityError('PR_LIFECYCLE_CONTRACT_INVALID', `${schema} contract failed live validation`);
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
  const repositoryId = requiredString(input.repository_id ?? input.repositoryId ?? live.head.repository_id, 'repository_id');
  const packetId = requiredString(input.packet_id ?? input.packetId ?? `packet-${issueId}-${live.issueRevision}-${live.head.head}`, 'packet_id');
  const createdAt = input.created_at ?? input.createdAt ?? new Date().toISOString();
  const objective = requiredString(input.objective ?? live.issue.objective ?? 'PR lifecycle operation', 'objective');
  const allowedMutations = input.allowed_mutations ?? input.allowedMutations ?? ['pr.merged'];
  if (!Array.isArray(allowedMutations) || allowedMutations.length === 0 || allowedMutations.some((item) => typeof item !== 'string' || item.length === 0)) {
    fail('PR_LIFECYCLE_MUTATION_UNAUTHORIZED', 'allowed mutations are malformed');
  }
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
    provenance: {
      source_kind: 'kernel', actor_class: 'agent', actor_id: live.ownership.actor_id,
    },
    payload: {
      issue_id: issueId,
      expected_issue_revision: live.issueRevision,
      packet_id: packetId,
      packet_revision: Number.isInteger(input.packet_revision ?? input.packetRevision) ? input.packet_revision ?? input.packetRevision : 1,
      repository_id: repositoryId,
      target_head: live.head.head,
      objective,
      authority: { kind: 'kernel', issue_revision: live.issueRevision },
      allowed_mutations: [...allowedMutations],
      workflow_config_revision: live.workflowConfigRevision,
      capability_manifest_digest: live.capabilityDigest,
      ...(input.acceptance_criteria ? { acceptance_criteria: [...input.acceptance_criteria] } : {}),
      ...(input.prohibited_actions ? { prohibited_actions: [...input.prohibited_actions] } : {}),
      ...(input.risk ?? live.risk ? { risk: input.risk ?? live.risk } : {}),
      ...(live.risk.digest ? { risk_manifest_digest: live.risk.digest } : {}),
      ...(input.target ? { target: input.target } : {}),
      receipt_requirements: { terminal: true, gate_ids: [...live.gates.ids], ...(input.receipt_requirements ?? {}) },
    },
    extensions: {},
  };
  packet.content_hash = computeContentHash(packet);
  return packet;
}

function assertReceiptEvidence(packet, receipt) {
  if (receipt.payload.status !== 'PASS') fail('PR_LIFECYCLE_TERMINAL_INVALID', 'RunReceipt is not terminal PASS');
  const attempted = receipt.payload.mutations_attempted ?? [];
  const authorized = receipt.payload.mutations_authorized ?? [];
  const allowed = packet.payload.allowed_mutations ?? [];
  const sameMutations = attempted.length === authorized.length
    && attempted.every((mutation, index) => mutation === authorized[index]);
  const mutation = ['pr.opened', 'pr.merged', 'pr.merge'].find((candidate) => (
    allowed.includes(candidate) && attempted.includes(candidate) && authorized.includes(candidate)
  ));
  if (!mutation || !sameMutations || attempted.some((entry) => !allowed.includes(entry))) {
    fail('PR_LIFECYCLE_MUTATION_UNAUTHORIZED', 'RunReceipt mutation evidence is incomplete or incompatible');
  }
  if (receipt.payload.lease_epoch !== undefined) fail('PR_LIFECYCLE_AUTHORITY_UNSUPPORTED', 'lease_epoch is deferred for 0.1');
  if (receipt.payload.validation?.status !== 'PASS' || receipt.payload.cleanup?.status !== 'PASS') fail('PR_LIFECYCLE_TERMINAL_INVALID', 'RunReceipt terminal validation or cleanup is incomplete');
  if (!Array.isArray(receipt.payload.evidence_refs) || receipt.payload.evidence_refs.length === 0) fail('PR_LIFECYCLE_TERMINAL_INVALID', 'RunReceipt terminal evidence is missing');
}

function assertPacketLiveBindings(packet, live) {
  const requiredGateIds = packet.payload.receipt_requirements?.gate_ids;
  if (!Array.isArray(requiredGateIds) || requiredGateIds.length === 0 || requiredGateIds.some((id) => typeof id !== 'string' || id.length === 0) || new Set(requiredGateIds).size !== requiredGateIds.length) fail('PR_LIFECYCLE_GATE_INVALID', 'WorkPacket gate requirements are incomplete');
  if (requiredGateIds.length !== live.gates.ids.length || requiredGateIds.some((id) => !live.gates.ids.includes(id))) fail('PR_LIFECYCLE_GATE_INVALID', 'WorkPacket gate requirements do not match live gates');
  if (!HASH_PATTERN.test(packet.payload.risk_manifest_digest || '') || packet.payload.risk_manifest_digest !== live.risk.digest) fail('PR_LIFECYCLE_RISK_INVALID', 'WorkPacket risk digest does not match live risk');
  if (!packet.payload.allowed_mutations.some((mutation) => ['pr.opened', 'pr.merge', 'pr.merged'].includes(mutation))) fail('PR_LIFECYCLE_MUTATION_UNAUTHORIZED', 'WorkPacket does not authorize a PR lifecycle mutation');
}

function deriveLinkage(packet, receipt, gates) {
  const target = packet.payload.target ?? {};
  let prNumber = Number.isInteger(target.pr_number) ? target.pr_number : undefined;
  if (prNumber === undefined) prNumber = receipt.payload.evidence_refs.find((entry) => Number.isInteger(entry?.pr_number))?.pr_number;
  return {
    issue_id: packet.payload.issue_id,
    repository_id: packet.payload.repository_id,
    head: packet.payload.target_head,
    ...(prNumber === undefined ? {} : { pr_number: prNumber }),
    gate_ids: [...gates.ids],
  };
}

function traceItems(trace) {
  const items = [];
  const requests = Array.isArray(trace?.pull_requests) ? trace.pull_requests : [];
  for (const request of requests) {
    const iterations = Array.isArray(request.iterations) ? request.iterations : [];
    items.push(...iterations.map((iteration) => ({ ...iteration, request })));
  }
  for (const list of [trace?.iterations, trace?.accepted, trace?.accepted_receipts]) {
    if (Array.isArray(list)) items.push(...list);
  }
  return items;
}

function itemPacketHash(item) {
  return item.work_packet_hash ?? item.packet_hash ?? item.packet?.content_hash;
}

function itemReceiptHash(item) {
  return item.run_receipt_hash ?? item.receipt_hash ?? item.receipt?.content_hash;
}

function durableAcceptance(trace, packet, receipt) {
  const items = traceItems(trace);
  const exact = items.find((item) => itemPacketHash(item) === packet.content_hash && itemReceiptHash(item) === receipt.content_hash);
  if (exact) return exact;
  const conflict = items.find((item) => itemPacketHash(item) === packet.content_hash
    || item.receipt?.payload?.run_id === receipt.payload.run_id
    || item.run_id === receipt.payload.run_id);
  if (conflict) fail('PR_LIFECYCLE_REPLAY_CONFLICT', 'durable trace conflicts with accepted content');
  return null;
}

function assertTraceLinkage(trace, linkage, packet, receipt) {
  if (!trace || typeof trace !== 'object' || Array.isArray(trace)) fail('PR_LIFECYCLE_UNAVAILABLE', 'public PR trace is unavailable');
  if (!Number.isInteger(linkage.pr_number) || linkage.pr_number <= 0) fail('PR_LIFECYCLE_LINKAGE_UNAVAILABLE', 'accepted packet lacks authoritative PR linkage');
  if (!Array.isArray(trace.pull_requests)) fail('PR_LIFECYCLE_LINKAGE_UNAVAILABLE', 'public PR trace has no durable pull-request linkage');
  const candidates = trace.pull_requests.filter((entry) => Number(entry?.number) === linkage.pr_number);
  if (candidates.length === 0) fail('PR_LIFECYCLE_LINKAGE_CONFLICT', 'public PR trace does not contain the accepted PR');
  const match = candidates[0];
  if (match.repo !== linkage.repository_id || match.head_sha !== linkage.head || match.issue_id !== linkage.issue_id) fail('PR_LIFECYCLE_LINKAGE_CONFLICT', 'public PR trace conflicts with accepted linkage');
  if (!durableAcceptance(trace, packet, receipt)) fail('PR_LIFECYCLE_NOT_ACCEPTED', 'public PR trace lacks accepted packet and receipt evidence');
}

function stableResult(kind, packet, receipt, linkage) {
  return kind === 'accepted'
    ? { accepted: true, packet_hash: packet.content_hash, receipt_hash: receipt.content_hash, run_id: receipt.payload.run_id, attempt_id: receipt.payload.attempt_id, linkage }
    : { merged: true, packet_hash: packet.content_hash, receipt_hash: receipt.content_hash, run_id: receipt.payload.run_id, linkage };
}

function createPrLifecycleAuthority({ provider, liveProbes = {} } = {}) {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) throw new TypeError('PR lifecycle authority requires a public provider object');
  for (const method of ['runIssueOperation', 'recordPrLinkage', 'readTrace']) {
    if (typeof provider[method] !== 'function') throw new TypeError(`PR lifecycle provider must implement ${method}()`);
  }
  if (!liveProbes || typeof liveProbes !== 'object' || Array.isArray(liveProbes)) throw new TypeError('liveProbes must be an object');

  async function readLive(input, packet = null) {
    const issueId = requiredString(input.issue_id ?? input.issueId ?? packet?.payload.issue_id, 'issue_id');
    const repositoryId = input.repository_id ?? input.repositoryId ?? packet?.payload.repository_id;
    const expectedActor = packet?.provenance?.actor_id;
    if (packet?.provenance && Object.hasOwn(packet.provenance, 'session_id')) {
      fail('PR_LIFECYCLE_CONTRACT_INVALID', 'WorkPacket provenance cannot contain session_id');
    }
    const requestedActor = packet ? expectedActor : requiredString(input.actor_id ?? input.actorId, 'actor_id');
    const requestedSession = packet ? undefined : input.session_id ?? input.sessionId;
    const issue = await callProbe(provider, liveProbes, ['readIssue', 'getIssue'], [issueId], 'issue', 'show');
    const issueRevision = assertLiveIssue(issue, issueId);
    const ownershipArgs = { issue_id: issueId, ...(requestedActor ? { actor_id: requestedActor } : {}), ...(requestedSession ? { session_id: requestedSession } : {}) };
    const ownership = assertOwnership(
      await callProbe(provider, liveProbes, ['readOwnership', 'getOwnership', 'ownsIssue'], [ownershipArgs], 'ownership', 'owns'),
      { actor_id: requestedActor },
    );
    const head = await callProbe(provider, liveProbes, ['readHead', 'getHead'], [{ issue_id: issueId, repository_id: repositoryId }], 'head');
    const normalizedHead = providerHead(head, repositoryId);
    const capability = await callProbe(provider, liveProbes, ['readCapability', 'getCapability', 'readCapabilityManifest'], [{ issue_id: issueId, repository_id: normalizedHead.repository_id }], 'capability');
    const capabilityDigestValue = capabilityDigest(capability);
    const workflowConfigRevision = requiredString(capability.workflow_config_revision ?? capability.config_revision, 'workflow_config_revision');
    if (input.workflow_config_revision && input.workflow_config_revision !== workflowConfigRevision) fail('PR_LIFECYCLE_REVISION_STALE', 'requested workflow config revision is stale');
    const risk = await callProbe(provider, liveProbes, ['readRisk', 'getRisk'], [{ issue_id: issueId }], 'risk');
    const normalizedRisk = assertRisk(risk, packet?.payload.risk_manifest_digest);
    const gates = await callProbe(provider, liveProbes, ['readGates', 'getGates'], [{ issue_id: issueId }], 'gates');
    const normalizedGates = assertGates(gates);
    return { issue, issueRevision, ownership, head: normalizedHead, capability, capabilityDigest: capabilityDigestValue, risk: normalizedRisk, gates: normalizedGates, workflowConfigRevision };
  }

  function assertCallerBinding(input, packet) {
    if (input.actor_id && input.actor_id !== packet.provenance.actor_id) fail('PR_LIFECYCLE_OWNERSHIP_STALE', 'caller actor does not match packet provenance');
    if (input.actorId && input.actorId !== packet.provenance.actor_id) fail('PR_LIFECYCLE_OWNERSHIP_STALE', 'caller actor does not match packet provenance');
    if (input.session_id || input.sessionId) fail('PR_LIFECYCLE_OWNERSHIP_STALE', 'caller session cannot assert packet authority');
  }

  async function issueWorkPacket(rawInput = {}) {
    const input = snapshot(rawInput, 'issue input');
    requiredString(input.actor_id ?? input.actorId, 'actor_id');
    const live = await readLive(input);
    const packet = buildPacket(input, live);
    assertContract(packet, WORK_PACKET_SCHEMA, { issueRevision: live.issueRevision, workflowConfigRevision: live.workflowConfigRevision, capabilityManifestDigest: live.capabilityDigest, exactHead: live.head.head });
    assertPacketLiveBindings(packet, live);
    return { packet: snapshot(packet, 'WorkPacket'), linkage: deriveLinkage(packet, { payload: { evidence_refs: [] } }, live.gates) };
  }

  async function acceptRunReceipt(rawInput = {}) {
    const input = snapshot(rawInput, 'receipt input');
    const packet = snapshot(input.packet, 'WorkPacket');
    const receipt = snapshot(input.receipt, 'RunReceipt');
    assertContract(packet, WORK_PACKET_SCHEMA);
    assertContract(receipt, RUN_RECEIPT_SCHEMA);
    assertCallerBinding(input, packet);
    const live = await readLive({ ...input, issue_id: packet.payload.issue_id }, packet);
    assertContract(packet, WORK_PACKET_SCHEMA, { issueRevision: live.issueRevision, workflowConfigRevision: live.workflowConfigRevision, capabilityManifestDigest: live.capabilityDigest, exactHead: live.head.head });
    assertPacketLiveBindings(packet, live);
    assertContract(receipt, RUN_RECEIPT_SCHEMA, { packetHash: packet.content_hash, workflowConfigRevision: packet.payload.workflow_config_revision, capabilityManifestDigest: packet.payload.capability_manifest_digest, exactHead: packet.payload.target_head });
    assertReceiptEvidence(packet, receipt);
    if (receipt.provenance.actor_id !== packet.provenance.actor_id || receipt.provenance.actor_id !== live.ownership.actor_id) {
      fail('PR_LIFECYCLE_OWNERSHIP_STALE', 'RunReceipt provenance actor does not match live ownership');
    }
    const linkage = deriveLinkage(packet, receipt, live.gates);
    const target = packet.payload.target;
    if (!target || !Number.isInteger(linkage.pr_number) || linkage.pr_number <= 0
      || typeof target.branch !== 'string' || typeof target.git_common_dir !== 'string' || typeof target.url !== 'string') {
      fail('PR_LIFECYCLE_LINKAGE_UNAVAILABLE', 'receipt acceptance requires authoritative PR linkage fields');
    }
    const traceTarget = { pr_number: linkage.pr_number, repo: linkage.repository_id, issue_id: linkage.issue_id };
    const trace = await callMethod(provider, 'readTrace', [traceTarget], 'trace');
    const durable = durableAcceptance(trace, packet, receipt);
    if (durable) {
      assertTraceLinkage(trace, linkage, packet, receipt);
    } else {
      await callMethod(provider, 'recordPrLinkage', [{
        phase: 'accepted',
        git_common_dir: target.git_common_dir,
        repo: linkage.repository_id,
        number: linkage.pr_number,
        branch: target.branch,
        url: target.url,
        occurred_at: receipt.payload.ended_at ?? receipt.created_at,
        work_packet: packet,
        run_receipt: receipt,
      }], 'PR linkage', { sanitize: true });
      const persistedTrace = await callMethod(provider, 'readTrace', [traceTarget], 'trace');
      assertTraceLinkage(persistedTrace, linkage, packet, receipt);
    }
    return stableResult('accepted', packet, receipt, linkage);
  }

  async function mergeWorkPacket(rawInput = {}) {
    const input = snapshot(rawInput, 'merge input');
    const packet = snapshot(input.packet, 'WorkPacket');
    const receipt = snapshot(input.receipt, 'RunReceipt');
    assertContract(packet, WORK_PACKET_SCHEMA);
    assertContract(receipt, RUN_RECEIPT_SCHEMA);
    assertCallerBinding(input, packet);
    const live = await readLive({ ...input, issue_id: packet.payload.issue_id }, packet);
    assertContract(packet, WORK_PACKET_SCHEMA, { issueRevision: live.issueRevision, workflowConfigRevision: live.workflowConfigRevision, capabilityManifestDigest: live.capabilityDigest, exactHead: live.head.head });
    assertPacketLiveBindings(packet, live);
    assertContract(receipt, RUN_RECEIPT_SCHEMA, { packetHash: packet.content_hash, workflowConfigRevision: packet.payload.workflow_config_revision, capabilityManifestDigest: packet.payload.capability_manifest_digest, exactHead: packet.payload.target_head });
    assertReceiptEvidence(packet, receipt);
    const linkage = deriveLinkage(packet, receipt, live.gates);
    const trace = await callMethod(provider, 'readTrace', [{ issue_id: linkage.issue_id, repository_id: linkage.repository_id, ...(linkage.pr_number ? { pr_number: linkage.pr_number, repo: linkage.repository_id } : {}) }], 'trace');
    // Compare durable packet/receipt content before linkage checks so a reused run id with
    // divergent content fails closed even when the incoming packet omitted a PR number.
    durableAcceptance(trace, packet, receipt);
    assertTraceLinkage(trace, linkage, packet, receipt);
    const target = packet.payload.target;
    if (typeof provider.mergePr === 'function' || typeof provider.merge === 'function') {
      const method = typeof provider.mergePr === 'function' ? 'mergePr' : 'merge';
      await callMethod(provider, method, [{ packet, receipt, linkage }], 'merge', { sanitize: true });
    } else {
      if (!target || typeof target.branch !== 'string' || typeof target.git_common_dir !== 'string') fail('PR_LIFECYCLE_LINKAGE_UNAVAILABLE', 'accepted packet lacks authoritative PR linkage fields');
      await callMethod(provider, 'recordPrLinkage', [{ phase: 'merged', git_common_dir: target.git_common_dir, repo: packet.payload.repository_id, number: linkage.pr_number, branch: target.branch, url: target.url, occurred_at: receipt.payload.ended_at ?? receipt.created_at, work_packet: packet, run_receipt: receipt }], 'PR linkage', { sanitize: true });
    }
    return stableResult('merged', packet, receipt, linkage);
  }

  async function requestNextWork(rawInput = {}) {
    const input = snapshot(rawInput, 'next work input');
    const method = ['listReadyWork', 'ready', 'requestNextWork'].find((name) => typeof provider[name] === 'function');
    if (!method) fail('PR_LIFECYCLE_UNAVAILABLE', 'ready provider operation is unavailable');
    const ready = await callMethod(provider, method, [input], 'ready');
    if (!Array.isArray(ready)) fail('PR_LIFECYCLE_UNAVAILABLE', 'ready provider returned a malformed queue');
    return ready;
  }

  return Object.freeze({ issueWorkPacket, acceptRunReceipt, mergeWorkPacket, requestNextWork });
}

module.exports = { PR_LIFECYCLE_PROVIDER_METHODS, PrLifecycleAuthorityError, createPrLifecycleAuthority };
