'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { types } = require('node:util');
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
const DEFAULT_PROVIDER_TIMEOUT_MS = 5_000;
const PROVIDER_DEADLINE_SENTINEL = Symbol('provider-deadline');
const MAX_PROVIDER_TIMEOUT_MS = 30_000;
const MAX_TRACE_SCAN_ROWS = 128;
const MAX_TRACE_ITERATIONS = 128;
const MAX_TRACE_TOTAL_ITERATIONS = 128;
const MAX_READY_ITEMS = 128;
const SECRET_PATTERNS = Object.freeze([
  /gh[pousr]_[A-Za-z0-9]{20,}/i,
  /sk_(?:live|test)_[A-Za-z0-9]{16,}/i,
  /sk-(?:live|test)_[A-Za-z0-9]{16,}/i,
  /sk-[A-Za-z0-9]{16,}/i,
  /AKIA[0-9A-Z]{16}/i,
  /(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S{8,}/i,
]);
const USER_PATH_PATTERN = /(?:[A-Za-z]:\\Users\\[^\\\s]+|\/(?:Users|home)\/[^/\s]+\/)/i;

// Complete accepted provider capability contract. Live probes may supply the optional reads;
// runIssueOperation, recordPrLinkage, and readTrace remain mandatory (see authority-provider.js).
const PR_LIFECYCLE_PROVIDER_METHODS = Object.freeze([
  'readIssue',
  'readOwnership',
  'readHead',
  'readCapability',
  'readRisk',
  'readGates',
  'listReadyWork',
  'runIssueOperation',
  'recordPrLinkage',
  'recordOpenedPrLinkage',
  'readTrace',
]);

function isCanonicalGitCommonDir(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false;
  const normalized = value.replaceAll('\\', '/');
  if (normalized.includes('%') || [...normalized].some(character => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  })) return false;
  const segments = normalized.split('/');
  const segmentStart = /^[A-Za-z]:$/.test(segments[0]) || segments[0] === '' ? 1 : 0;
  if (segments.slice(segmentStart).some(segment => segment.length === 0 || segment.trim() !== segment)) return false;
  if (segments.some(segment => segment === '.' || segment === '..' || containsSecret(segment))) return false;
  if (segments.at(-1)?.toLowerCase() !== '.git') return false;
  const posixAbsolute = segments[0] === '' && segments.length >= 3;
  const windowsAbsolute = /^[a-z]:$/i.test(segments[0]) && segments.length >= 3;
  return posixAbsolute || windowsAbsolute;
}

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

function containsSecret(value) {
  return typeof value === 'string' && SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

function containsForbidden(value, options = {}, context = '') {
  if (typeof value === 'string') {
    return containsSecret(value) || USER_PATH_PATTERN.test(value);
  }
  if (Array.isArray(value)) return value.some(item => containsForbidden(item, options, context));
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, nested]) => {
      if (containsSecret(key) || USER_PATH_PATTERN.test(key)) return true;
      const allowsGitCommonDir = key === 'git_common_dir'
        && (options.allowGitCommonDir === true
          || options.allowGitCommonDir === 'target' && context === 'target');
      if (allowsGitCommonDir) return !isCanonicalGitCommonDir(nested);
      return containsForbidden(nested, options, key === 'target' ? 'target' : '');
    });
  }
  return false;
}

function isForbiddenKey(key) {
  return containsSecret(key) || USER_PATH_PATTERN.test(key);
}

function redactForbidden(value, options = {}, context = '') {
  if (typeof value === 'string') return containsForbidden(value, options, context) ? '[redacted]' : value;
  if (Array.isArray(value)) return value.map(item => redactForbidden(item, options, context));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !isForbiddenKey(key))
      .map(([key, item]) => {
        const allowsGitCommonDir = key === 'git_common_dir'
          && (options.allowGitCommonDir === true
            || options.allowGitCommonDir === 'target' && context === 'target');
        return [key, allowsGitCommonDir && isCanonicalGitCommonDir(item)
          ? item
          : redactForbidden(item, options, key === 'target' ? 'target' : '')];
      }));
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
    if (options.privacy !== 'sanitize' && containsForbidden(bounded, options)) {
      fail('PR_LIFECYCLE_PRIVACY_REJECTED', `${label} contains a secret or absolute user path`);
    }
    return options.privacy === 'sanitize' ? redactForbidden(bounded, options) : bounded;
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

class ProviderDeadlineError extends Error {}

function validateProviderTimeout(timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_PROVIDER_TIMEOUT_MS) {
    fail('PR_LIFECYCLE_INVALID_INPUT', `provider timeout must be an integer from 1 to ${MAX_PROVIDER_TIMEOUT_MS} milliseconds`);
  }
  return timeoutMs;
}

async function invokeWithDeadline(target, method, args, timeoutMs, options = {}) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const methodArgs = [...args];
  // Cancellation is best-effort for backward compatibility: established provider
  // methods do not accept an options object, so only explicit signal parameters opt in.
  if (controller && target[method]?.length > args.length) methodArgs.push(controller.signal);
  let timer;
  let timedOut = false;
  const operation = Promise.resolve().then(() => target[method](...methodArgs));
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      if (options.reconcileOnTimeout) resolve(PROVIDER_DEADLINE_SENTINEL);
      else {
        controller?.abort();
        reject(new ProviderDeadlineError('provider operation deadline exceeded'));
      }
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([operation, deadline]);
    // Consequential operations must never report a timeout while a write can still
    // complete later. If cancellation did not settle it, reconcile the actual result.
    return result === PROVIDER_DEADLINE_SENTINEL ? await operation : result;
  } finally {
    clearTimeout(timer);
    if (timedOut && !options.reconcileOnTimeout) controller?.abort();
  }
}

async function callMethod(target, method, args, label, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  let result;
  try {
    const invocationArgs = options.sanitize
      ? snapshot(args, `${label} provider input`, { privacy: 'sanitize', allowGitCommonDir: options.allowGitCommonDir })
      : args;
    result = await invokeWithDeadline(target, method, invocationArgs, timeoutMs, options);
  } catch (error) {
    if (error instanceof PrLifecycleAuthorityError) throw error;
    fail('PR_LIFECYCLE_UNAVAILABLE', `${label} provider operation failed`, { cause: error });
  }
  try {
    const projected = typeof options.project === 'function' ? options.project(result) : result;
    const bounded = snapshot(projected, `${label} provider response`, {
      privacy: options.sanitize ? 'sanitize' : undefined,
      allowGitCommonDir: options.allowGitCommonDir,
    });
    if (options.unwrap && bounded?.ok === true && bounded.data !== undefined) return bounded.data;
    if (options.unwrap && bounded?.ok === false) fail('PR_LIFECYCLE_UNAVAILABLE', `${label} provider rejected operation`);
    return bounded;
  } catch (error) {
    if (error instanceof PrLifecycleAuthorityError) throw error;
    fail('PR_LIFECYCLE_UNAVAILABLE', `${label} provider operation failed`, { cause: error });
  }
}

async function callProbe(provider, probes, names, args, label, fallbackName, timeoutMs, options = {}) {
  const injected = names.find((name) => typeof probes?.[name] === 'function');
  if (injected) return callMethod(probes, injected, args, label, { timeoutMs, ...options });
  const direct = names.find((name) => typeof provider[name] === 'function');
  if (direct) return callMethod(provider, direct, args, label, { timeoutMs, ...options });
  // Issue read/ownership may use the public operation broker. No invented live-state
  // operation names are permitted for head, capability, risk, or gate evidence.
  if (fallbackName && typeof provider.runIssueOperation === 'function') {
    let operationArgs = args;
    let context = {};
    if (fallbackName === 'owns' && args[0] && typeof args[0] === 'object') {
      operationArgs = [args[0].issue_id];
      context = { actor: args[0].actor_id, sessionId: args[0].session_id };
    }
    return callMethod(provider, 'runIssueOperation', [fallbackName, operationArgs, context], label, { timeoutMs, unwrap: true, ...options });
  }
  fail('PR_LIFECYCLE_UNAVAILABLE', `${label} live probe is unavailable`);
}

async function callOwnershipProbe(provider, probes, ownershipArgs, timeoutMs) {
  if (typeof probes?.readOwnership === 'function') return callMethod(probes, 'readOwnership', [ownershipArgs], 'ownership', { timeoutMs });
  if (typeof provider.readOwnership === 'function') return callMethod(provider, 'readOwnership', [ownershipArgs], 'ownership', { timeoutMs });
  const context = { actor: ownershipArgs.actor_id, sessionId: ownershipArgs.session_id };
  const owns = await callMethod(provider, 'runIssueOperation', ['owns', [ownershipArgs.issue_id], context], 'ownership', { timeoutMs, unwrap: true });
  if (owns?.owned !== true) return owns;
  const claims = await callMethod(provider, 'runIssueOperation', ['claims', [], context], 'claims', { timeoutMs, unwrap: true });
  const matchingClaims = Array.isArray(claims?.claims) ? claims.claims.filter(claim => claim?.issue_id === ownershipArgs.issue_id
    && claim?.actor === ownershipArgs.actor_id && claim?.session_id === ownershipArgs.session_id) : [];
  if (matchingClaims.length !== 1) fail('PR_LIFECYCLE_OWNERSHIP_STALE', 'live ownership session evidence is unavailable or ambiguous');
  return { ...owns, actor_id: owns.actor ?? owns.claimed_by, session_id: matchingClaims[0].session_id };
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
  if (issue.blocked === true || issue.blockers > 0) {
    fail('PR_LIFECYCLE_READINESS_STALE', 'issue is not live-ready');
  }
  return revision;
}

async function readReadyIssue(provider, issueId, actorId, sessionId, timeoutMs) {
  const input = { issue_id: issueId, actor_id: actorId, session_id: sessionId };
  const response = typeof provider.listReadyWork === 'function'
    ? await callMethod(provider, 'listReadyWork', [input], 'ready', { timeoutMs, project: projectReadyResponse })
    : await callMethod(provider, 'runIssueOperation', ['ready', [], { actor: actorId, sessionId }], 'ready', {
      timeoutMs, unwrap: true, project: projectReadyResponse,
    });
  const ready = Array.isArray(response) ? response : response?.issues;
  if (!Array.isArray(ready)) fail('PR_LIFECYCLE_UNAVAILABLE', 'ready provider returned a malformed queue');
  const matches = ready.filter(issue => (issue?.id ?? issue?.issue_id) === issueId);
  if (matches.length !== 1) fail('PR_LIFECYCLE_READINESS_STALE', 'issue is absent or ambiguous in the authoritative ready queue');
  return matches[0];
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

function liveValidationCode(errors) {
  const codes = new Set(errors.map(item => item.code));
  if (codes.has('STALE_EXACT_HEAD')) return 'PR_LIFECYCLE_HEAD_STALE';
  if (codes.has('STALE_ISSUE_REVISION')) return 'PR_LIFECYCLE_REVISION_STALE';
  if (codes.has('WRONG_CAPABILITY_DIGEST')) return 'PR_LIFECYCLE_CAPABILITY_INVALID';
  if (codes.has('STALE_WORKFLOW_CONFIG')) return 'PR_LIFECYCLE_REVISION_STALE';
  return null;
}

function assertContract(value, schema, expected) {
  const structural = validateContractStructure(value);
  if (!structural.ok || value?.schema_id !== schema) fail('PR_LIFECYCLE_CONTRACT_INVALID', `${schema} contract is malformed`);
  const result = expected === undefined ? structural : validateContract(value, { expected });
  if (!result.ok) {
    const liveCode = liveValidationCode(result.errors);
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

function optionalArrayField(input, field) {
  if (input[field] === undefined) return {};
  if (!Array.isArray(input[field])) fail('PR_LIFECYCLE_INVALID_INPUT', `${field} must be an array`);
  return { [field]: [...input[field]] };
}

function optionalPlainObjectField(input, field) {
  if (input[field] === undefined) return {};
  if (!input[field] || typeof input[field] !== 'object' || Array.isArray(input[field])) {
    fail('PR_LIFECYCLE_INVALID_INPUT', `${field} must be a plain object`);
  }
  return { [field]: { ...input[field] } };
}

function buildPacket(input, live) {
  const issueId = requiredString(input.issue_id ?? input.issueId, 'issue_id');
  const repositoryId = requiredString(input.repository_id ?? input.repositoryId ?? live.head.repository_id, 'repository_id');
  const packetId = requiredString(input.packet_id ?? input.packetId ?? `packet-${issueId}-${live.issueRevision}-${live.head.head}`, 'packet_id');
  const createdAt = input.created_at ?? input.createdAt ?? new Date().toISOString();
  const objective = requiredString(input.objective ?? live.issue.objective ?? 'PR lifecycle operation', 'objective');
  const allowedMutations = input.allowed_mutations ?? input.allowedMutations ?? ['pr.opened'];
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
      ...optionalArrayField(input, 'acceptance_criteria'),
      ...optionalArrayField(input, 'prohibited_actions'),
      risk: input.risk ?? live.risk,
      ...(live.risk.digest ? { risk_manifest_digest: live.risk.digest } : {}),
      ...(input.target ? { target: input.target } : {}),
      receipt_requirements: {
        ...optionalPlainObjectField(input, 'receipt_requirements').receipt_requirements,
        terminal: true,
        gate_ids: [...live.gates.ids],
      },
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
  const prohibited = packet.payload.prohibited_actions ?? [];
  const attemptedSet = new Set(attempted);
  const authorizedSet = new Set(authorized);
  const sameMutations = attemptedSet.size === attempted.length
    && authorizedSet.size === authorized.length
    && attemptedSet.size === authorizedSet.size
    && attemptedSet.size > 0
    && [...attemptedSet].every(mutation => authorizedSet.has(mutation));
  const opened = allowed.includes('pr.opened')
    && attemptedSet.has('pr.opened')
    && authorizedSet.has('pr.opened');
  if (!opened || !sameMutations || attempted.some((entry) => entry !== 'pr.opened'
    || !allowed.includes(entry) || prohibited.includes(entry))) {
    fail('PR_LIFECYCLE_MUTATION_UNAUTHORIZED', 'RunReceipt mutation evidence is incomplete or incompatible');
  }
  if (receipt.payload.lease_epoch !== undefined) fail('PR_LIFECYCLE_AUTHORITY_UNSUPPORTED', 'lease_epoch is deferred for 0.1');
  if (receipt.payload.validation?.status !== 'PASS' || receipt.payload.cleanup?.status !== 'PASS') fail('PR_LIFECYCLE_TERMINAL_INVALID', 'RunReceipt terminal validation or cleanup is incomplete');
  if (!Array.isArray(receipt.payload.evidence_refs) || receipt.payload.evidence_refs.length === 0) fail('PR_LIFECYCLE_TERMINAL_INVALID', 'RunReceipt terminal evidence is missing');
  return 'opened';
}

function assertReceiptExecutor(receipt) {
  const provenance = receipt.provenance;
  const producer = receipt.producer;
  if (producer?.product_id !== 'forge-flow'
    || provenance?.source_kind !== 'execution'
    || provenance?.actor_class !== 'system'
    || provenance?.actor_id !== producer?.instance_id) {
    fail('PR_LIFECYCLE_CONTRACT_INVALID', 'RunReceipt executor provenance is not trusted');
  }
}

async function authenticateReceipt(receiptVerifier, packet, receipt, timeoutMs) {
  const identity = {
    receipt_hash: receipt.content_hash,
    packet_hash: packet.content_hash,
    run_id: receipt.payload.run_id,
    attempt_id: receipt.payload.attempt_id,
    producer_instance_id: receipt.producer.instance_id,
  };
  const verification = await callMethod({ verify: receiptVerifier }, 'verify', [identity], 'receipt authentication', { timeoutMs });
  if (verification?.authenticated !== true
    || verification.receipt_hash !== identity.receipt_hash
    || verification.packet_hash !== identity.packet_hash
    || verification.run_id !== identity.run_id
    || verification.attempt_id !== identity.attempt_id
    || verification.producer_instance_id !== identity.producer_instance_id) {
    fail('PR_LIFECYCLE_CONTRACT_INVALID', 'RunReceipt lacks authenticated Flow execution evidence');
  }
}

function assertPacketLiveBindings(packet, live) {
  const requiredGateIds = packet.payload.receipt_requirements?.gate_ids;
  if (!Array.isArray(requiredGateIds) || requiredGateIds.length === 0 || requiredGateIds.some((id) => typeof id !== 'string' || id.length === 0) || new Set(requiredGateIds).size !== requiredGateIds.length) fail('PR_LIFECYCLE_GATE_INVALID', 'WorkPacket gate requirements are incomplete');
  if (requiredGateIds.length !== live.gates.ids.length || requiredGateIds.some((id) => !live.gates.ids.includes(id))) fail('PR_LIFECYCLE_GATE_INVALID', 'WorkPacket gate requirements do not match live gates');
  if (!HASH_PATTERN.test(packet.payload.risk_manifest_digest || '') || packet.payload.risk_manifest_digest !== live.risk.digest) fail('PR_LIFECYCLE_RISK_INVALID', 'WorkPacket risk digest does not match live risk');
  const prohibited = packet.payload.prohibited_actions ?? [];
  if (!Array.isArray(prohibited) || packet.payload.allowed_mutations.some(mutation => prohibited.includes(mutation))) fail('PR_LIFECYCLE_MUTATION_UNAUTHORIZED', 'WorkPacket allowed and prohibited mutations conflict');
  if (packet.payload.allowed_mutations.length !== 1 || packet.payload.allowed_mutations[0] !== 'pr.opened') fail('PR_LIFECYCLE_MUTATION_UNAUTHORIZED', 'WorkPacket may authorize only pr.opened receipt linkage');
}

function deriveLinkage(packet, receipt, gates) {
  const target = packet.payload.target ?? {};
  const prEvidence = receipt.payload.evidence_refs.filter(entry => entry?.kind === 'pr' && Number.isInteger(entry?.pr_number));
  if (prEvidence.length !== 1 || prEvidence[0].pr_number <= 0 || typeof prEvidence[0].url !== 'string') {
    fail('PR_LIFECYCLE_LINKAGE_UNAVAILABLE', 'opened receipt must contain exactly one complete PR evidence reference');
  }
  const evidenceRepository = prEvidence[0].repository_id ?? prEvidence[0].repository ?? prEvidence[0].repo;
  if (evidenceRepository !== undefined && evidenceRepository !== packet.payload.repository_id) {
    fail('PR_LIFECYCLE_LINKAGE_CONFLICT', 'receipt PR repository conflicts with packet authority');
  }
  if (Number.isInteger(target.pr_number) && prEvidence.some(entry => entry.pr_number !== target.pr_number)) {
    fail('PR_LIFECYCLE_LINKAGE_CONFLICT', 'receipt PR number conflicts with packet target');
  }
  let prNumber = Number.isInteger(target.pr_number) ? target.pr_number : undefined;
  if (prNumber === undefined) prNumber = prEvidence[0]?.pr_number;
  const matchingEvidence = prEvidence;
  if (typeof target.url === 'string' && matchingEvidence.some(entry => entry.url !== target.url)) {
    fail('PR_LIFECYCLE_LINKAGE_CONFLICT', 'receipt PR URL conflicts with packet target');
  }
  const evidenceUrl = matchingEvidence[0]?.url;
  return {
    issue_id: packet.payload.issue_id,
    repository_id: packet.payload.repository_id,
    head: packet.payload.target_head,
    ...(prNumber === undefined ? {} : { pr_number: prNumber }),
    ...(typeof target.url === 'string' || evidenceUrl ? { url: target.url ?? evidenceUrl } : {}),
    ...(typeof target.git_common_dir === 'string' ? { git_common_dir: target.git_common_dir } : {}),
    gate_ids: [...gates.ids],
  };
}

function packetLinkage(packet, gates) {
  const target = packet.payload.target ?? {};
  return {
    issue_id: packet.payload.issue_id,
    repository_id: packet.payload.repository_id,
    head: packet.payload.target_head,
    ...(Number.isInteger(target.pr_number) ? { pr_number: target.pr_number } : {}),
    ...(typeof target.url === 'string' ? { url: target.url } : {}),
    ...(typeof target.git_common_dir === 'string' ? { git_common_dir: target.git_common_dir } : {}),
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

function packetSemanticIdentity(packet) {
  const payload = packet?.payload;
  if (!payload || typeof payload !== 'object') return null;
  return JSON.stringify([
    payload.issue_id,
    payload.expected_issue_revision,
    payload.packet_id,
    payload.packet_revision,
    payload.repository_id,
    payload.target_head,
  ]);
}

function itemPacketIdentity(item) {
  return item.work_packet_identity ?? item.packet_identity ?? packetSemanticIdentity(item.packet);
}

function durableAcceptance(trace, packet, receipt) {
  const items = traceItems(trace);
  const exact = items.find((item) => itemPacketHash(item) === packet.content_hash && itemReceiptHash(item) === receipt.content_hash);
  if (exact) return exact;
  const identity = packetSemanticIdentity(packet);
  const conflict = items.find((item) => itemPacketHash(item) === packet.content_hash
    || identity && itemPacketIdentity(item) === identity
    || item.receipt?.payload?.run_id === receipt.payload.run_id
    || item.run_id === receipt.payload.run_id);
  if (conflict) fail('PR_LIFECYCLE_REPLAY_CONFLICT', 'durable trace conflicts with accepted content');
  return null;
}

function dataProperty(value, key) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) return undefined;
  return descriptor.value;
}

function projectTraceIteration(iteration) {
  const packet = dataProperty(iteration, 'packet');
  const receipt = dataProperty(iteration, 'receipt');
  const receiptPayload = dataProperty(receipt, 'payload');
  const packetHash = dataProperty(iteration, 'work_packet_hash')
    ?? dataProperty(iteration, 'packet_hash')
    ?? dataProperty(packet, 'content_hash');
  const receiptHash = dataProperty(iteration, 'run_receipt_hash')
    ?? dataProperty(iteration, 'receipt_hash')
    ?? dataProperty(receipt, 'content_hash');
  const runId = dataProperty(iteration, 'run_id') ?? dataProperty(receiptPayload, 'run_id');
  const packetIdentity = dataProperty(iteration, 'work_packet_identity')
    ?? dataProperty(iteration, 'packet_identity')
    ?? packetSemanticIdentity(packet);
  return {
    ...(dataProperty(iteration, 'type') === undefined ? {} : { type: dataProperty(iteration, 'type') }),
    ...(packetHash === undefined ? {} : { work_packet_hash: packetHash }),
    ...(receiptHash === undefined ? {} : { run_receipt_hash: receiptHash }),
    ...(runId === undefined ? {} : { run_id: runId }),
    ...(packetIdentity === null || packetIdentity === undefined ? {} : { work_packet_identity: packetIdentity }),
  };
}

function projectReadyResponse(value) {
  if (types.isProxy(value)) throw new TypeError('ready provider response cannot be a Proxy');
  const ok = dataProperty(value, 'ok');
  const data = dataProperty(value, 'data');
  const envelope = ok === true && data && !Array.isArray(data) ? data : value;
  if (types.isProxy(envelope)) throw new TypeError('ready provider envelope cannot be a Proxy');
  const issues = Array.isArray(envelope) ? envelope : dataProperty(envelope, 'issues');
  if (!Array.isArray(issues)) return value;
  if (types.isProxy(issues)) throw new TypeError('ready provider queue cannot be a Proxy');
  if (issues.length > MAX_READY_ITEMS) fail('PR_LIFECYCLE_READINESS_STALE', 'authoritative ready queue exceeds lifecycle bounds');
  const selected = [];
  const length = issues.length;
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(issues, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw new TypeError('ready provider queue must contain plain dense entries');
    }
    try {
      canonicalize([...selected, descriptor.value], {
        maxDepth: MAX_SNAPSHOT_DEPTH,
        maxNodes: MAX_SNAPSHOT_NODES,
        maxBytes: MAX_SNAPSHOT_BYTES - 1_024,
      });
      selected.push(descriptor.value);
    } catch (error) {
      if (['CANONICAL_BYTE_LIMIT', 'CANONICAL_NODE_LIMIT', 'CANONICAL_DEPTH_LIMIT'].includes(error?.code)) {
        fail('PR_LIFECYCLE_READINESS_STALE', 'authoritative ready queue exceeds lifecycle bounds');
      }
      throw error;
    }
  }
  return ok === true
    ? { ok: true, data: selected }
    : selected;
}

function projectIssueResponse(value) {
  if (types.isProxy(value)) throw new TypeError('issue provider response cannot be a Proxy');
  const ok = dataProperty(value, 'ok');
  const data = dataProperty(value, 'data');
  const issue = ok === true ? data : value;
  if (!issue || typeof issue !== 'object' || Array.isArray(issue) || types.isProxy(issue)) return value;
  const projected = {};
  for (const key of ['id', 'issue_id', 'revision', 'issue_revision', 'status', 'state', 'ready', 'is_ready',
    'blocked', 'blockers', 'readiness_state', 'objective']) {
    const field = dataProperty(issue, key);
    if (field !== undefined) projected[key] = field;
  }
  if (containsForbidden(projected)) {
    fail('PR_LIFECYCLE_PRIVACY_REJECTED', 'issue provider response contains a secret or absolute user path');
  }
  return ok === true ? { ok: true, data: projected } : projected;
}

function projectTrace(trace, target) {
  const requests = dataProperty(trace, 'pull_requests');
  if (!Array.isArray(requests)) return { pull_requests: requests };
  const gapEvidence = dataProperty(trace, 'gaps');
  if (gapEvidence !== undefined && !Array.isArray(gapEvidence)) fail('PR_LIFECYCLE_INVALID_INPUT', 'public PR trace gap evidence is malformed');
  const gaps = gapEvidence ?? [];
  if (gaps.some(gap => typeof gap === 'string'
    && (gap === 'pull_requests:overflow'
      || /^pull_requests:.*:unlinked_issue$/.test(gap)
      || /^iterations:.*:(?:missing|incomplete|overflow)$/.test(gap)))) {
    fail('PR_LIFECYCLE_REPLAY_CONFLICT', 'public PR trace authority evidence is incomplete');
  }
  if (requests.length > MAX_TRACE_SCAN_ROWS) {
    fail('PR_LIFECYCLE_INVALID_INPUT', 'public PR trace rows exceed lifecycle bounds');
  }
  const matches = [];
  let totalIterations = 0;
  for (const request of requests) {
    if (dataProperty(request, 'issue_id') !== target.issue_id
      || dataProperty(request, 'repo') !== target.repository_id) continue;
    const iterations = dataProperty(request, 'iterations');
    totalIterations += Array.isArray(iterations) ? iterations.length : 0;
    if (!Array.isArray(iterations) || iterations.length > MAX_TRACE_ITERATIONS
      || totalIterations > MAX_TRACE_TOTAL_ITERATIONS) {
      fail('PR_LIFECYCLE_INVALID_INPUT', 'public PR trace iterations exceed lifecycle bounds');
    }
    matches.push({
      number: dataProperty(request, 'number'),
      repo: dataProperty(request, 'repo'),
      ...(typeof dataProperty(request, 'git_common_dir') === 'string'
        ? { git_common_dir: dataProperty(request, 'git_common_dir') }
        : {}),
      head_sha: dataProperty(request, 'head_sha'),
      issue_id: dataProperty(request, 'issue_id'),
      iterations: iterations.map(projectTraceIteration),
    });
  }
  return { pull_requests: matches };
}

function traceTarget(linkage, gitCommonDir) {
  return {
    issue_id: linkage.issue_id,
    repository_id: linkage.repository_id,
    repo: linkage.repository_id,
    ...(Number.isInteger(linkage.pr_number) ? { pr_number: linkage.pr_number } : {}),
    ...(typeof gitCommonDir === 'string' ? { git_common_dir: gitCommonDir } : {}),
  };
}

async function readLifecycleTrace(provider, linkage, timeoutMs, gitCommonDir) {
  const target = traceTarget(linkage, gitCommonDir);
  return callMethod(provider, 'readTrace', [target], 'trace', {
    timeoutMs,
    allowGitCommonDir: true,
    project: value => projectTrace(value, target),
  });
}

function traceLinkageRow(trace, linkage) {
  if (!trace || typeof trace !== 'object' || Array.isArray(trace)) fail('PR_LIFECYCLE_UNAVAILABLE', 'public PR trace is unavailable');
  if (!Number.isInteger(linkage.pr_number) || linkage.pr_number <= 0) fail('PR_LIFECYCLE_LINKAGE_UNAVAILABLE', 'accepted packet lacks authoritative PR linkage');
  if (!Array.isArray(trace.pull_requests)) fail('PR_LIFECYCLE_LINKAGE_UNAVAILABLE', 'public PR trace has no durable pull-request linkage');
  const numbered = trace.pull_requests.filter((entry) => Number(entry?.number) === linkage.pr_number);
  const candidates = linkage.git_common_dir !== undefined && numbered.some(entry => typeof entry?.git_common_dir === 'string')
    ? numbered.filter(entry => entry.git_common_dir === linkage.git_common_dir)
    : numbered;
  if (candidates.length > 1) fail('PR_LIFECYCLE_LINKAGE_CONFLICT', 'public PR trace contains ambiguous duplicate PR rows');
  if (candidates.length === 0) return null;
  const match = candidates[0];
  if (match.repo !== linkage.repository_id || match.head_sha !== linkage.head || match.issue_id !== linkage.issue_id) fail('PR_LIFECYCLE_LINKAGE_CONFLICT', 'public PR trace conflicts with accepted linkage');
  return match;
}

function assertTraceLinkage(trace, linkage, packet, receipt) {
  const match = traceLinkageRow(trace, linkage);
  if (!match) fail('PR_LIFECYCLE_LINKAGE_CONFLICT', 'public PR trace does not contain the accepted PR');
  if (!durableAcceptance({ pull_requests: [match] }, packet, receipt)) fail('PR_LIFECYCLE_NOT_ACCEPTED', 'public PR trace lacks accepted packet and receipt evidence');
}

function stableResult(kind, packet, receipt, linkage) {
  const { git_common_dir: _gitCommonDir, ...publicLinkage } = linkage;
  return { accepted: true, packet_hash: packet.content_hash, receipt_hash: receipt.content_hash, run_id: receipt.payload.run_id, attempt_id: receipt.payload.attempt_id, linkage: publicLinkage };
}

function createPrLifecycleAuthority({ provider, liveProbes = {}, receiptVerifier, timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS } = {}) {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) throw new TypeError('PR lifecycle authority requires a public provider object');
  validateProviderTimeout(timeoutMs);
  for (const method of ['runIssueOperation', 'recordPrLinkage', 'recordOpenedPrLinkage', 'readTrace']) {
    if (typeof provider[method] !== 'function') throw new TypeError(`PR lifecycle provider must implement ${method}()`);
  }
  if (!liveProbes || typeof liveProbes !== 'object' || Array.isArray(liveProbes)) throw new TypeError('liveProbes must be an object');
  if (typeof receiptVerifier !== 'function') throw new TypeError('receiptVerifier must be a function');
  async function readLive(input, packet = null) {
    const issueId = requiredString(input.issue_id ?? input.issueId ?? packet?.payload.issue_id, 'issue_id');
    const repositoryId = input.repository_id ?? input.repositoryId ?? packet?.payload.repository_id;
    const expectedActor = packet?.provenance?.actor_id;
    if (packet?.provenance && Object.hasOwn(packet.provenance, 'session_id')) {
      fail('PR_LIFECYCLE_CONTRACT_INVALID', 'WorkPacket provenance cannot contain session_id');
    }
    const requestedActor = packet ? expectedActor : requiredString(input.actor_id ?? input.actorId, 'actor_id');
    const requestedSession = requiredString(input.session_id ?? input.sessionId, 'session_id');
    const issue = await callProbe(provider, liveProbes, ['readIssue'], [issueId], 'issue', 'show', timeoutMs, { project: projectIssueResponse });
    const issueRevision = assertLiveIssue(issue, issueId);
    const readyIssue = await readReadyIssue(provider, issueId, requestedActor, requestedSession, timeoutMs);
    const readyRevision = readyIssue.revision ?? readyIssue.issue_revision;
    if (readyRevision !== undefined && readyRevision !== issueRevision) {
      fail('PR_LIFECYCLE_REVISION_STALE', 'authoritative ready queue revision does not match live issue');
    }
    const ownershipArgs = { issue_id: issueId, ...(requestedActor ? { actor_id: requestedActor } : {}), ...(requestedSession ? { session_id: requestedSession } : {}) };
    const ownership = assertOwnership(
      await callOwnershipProbe(provider, liveProbes, ownershipArgs, timeoutMs),
      { actor_id: requestedActor, session_id: requestedSession },
    );
    const head = await callProbe(provider, liveProbes, ['readHead'], [{ issue_id: issueId, repository_id: repositoryId }], 'head', undefined, timeoutMs);
    const normalizedHead = providerHead(head, repositoryId);
    const capability = await callProbe(provider, liveProbes, ['readCapability'], [{ issue_id: issueId, repository_id: normalizedHead.repository_id }], 'capability', undefined, timeoutMs);
    const capabilityDigestValue = capabilityDigest(capability);
    const workflowConfigRevision = requiredString(capability.workflow_config_revision ?? capability.config_revision, 'workflow_config_revision');
    if (input.workflow_config_revision && input.workflow_config_revision !== workflowConfigRevision) fail('PR_LIFECYCLE_REVISION_STALE', 'requested workflow config revision is stale');
    const risk = await callProbe(provider, liveProbes, ['readRisk'], [{ issue_id: issueId }], 'risk', undefined, timeoutMs);
    const normalizedRisk = assertRisk(risk, packet?.payload.risk_manifest_digest);
    const gates = await callProbe(provider, liveProbes, ['readGates'], [{ issue_id: issueId }], 'gates', undefined, timeoutMs);
    const normalizedGates = assertGates(gates);
    return { issue, issueRevision, ownership, head: normalizedHead, capability, capabilityDigest: capabilityDigestValue, risk: normalizedRisk, gates: normalizedGates, workflowConfigRevision };
  }

  function assertCallerBinding(input, packet) {
    if (input.actor_id && input.actor_id !== packet.provenance.actor_id) fail('PR_LIFECYCLE_OWNERSHIP_STALE', 'caller actor does not match packet provenance');
    if (input.actorId && input.actorId !== packet.provenance.actor_id) fail('PR_LIFECYCLE_OWNERSHIP_STALE', 'caller actor does not match packet provenance');
  }

  async function issueWorkPacket(rawInput = {}) {
    const input = snapshot(rawInput, 'issue input', { allowGitCommonDir: 'target' });
    requiredString(input.actor_id ?? input.actorId, 'actor_id');
    optionalPlainObjectField(input, 'receipt_requirements');
    const live = await readLive(input);
    const packet = buildPacket(input, live);
    assertContract(packet, WORK_PACKET_SCHEMA, { issueRevision: live.issueRevision, workflowConfigRevision: live.workflowConfigRevision, capabilityManifestDigest: live.capabilityDigest, exactHead: live.head.head });
    assertPacketLiveBindings(packet, live);
    return { packet: snapshot(packet, 'WorkPacket', { allowGitCommonDir: 'target' }), linkage: packetLinkage(packet, live.gates) };
  }

  async function acceptRunReceipt(rawInput = {}) {
    const input = snapshot(rawInput, 'receipt input', { allowGitCommonDir: 'target' });
    const packet = snapshot(input.packet, 'WorkPacket', { allowGitCommonDir: 'target' });
    const receipt = snapshot(input.receipt, 'RunReceipt');
    assertContract(packet, WORK_PACKET_SCHEMA);
    assertContract(receipt, RUN_RECEIPT_SCHEMA);
    assertCallerBinding(input, packet);
    const live = await readLive({ ...input, issue_id: packet.payload.issue_id }, packet);
    assertContract(packet, WORK_PACKET_SCHEMA, { issueRevision: live.issueRevision, workflowConfigRevision: live.workflowConfigRevision, capabilityManifestDigest: live.capabilityDigest, exactHead: live.head.head });
    assertPacketLiveBindings(packet, live);
    assertContract(receipt, RUN_RECEIPT_SCHEMA, { packetHash: packet.content_hash, workflowConfigRevision: packet.payload.workflow_config_revision, capabilityManifestDigest: packet.payload.capability_manifest_digest, exactHead: packet.payload.target_head });
    assertReceiptEvidence(packet, receipt);
    assertReceiptExecutor(receipt);
    await authenticateReceipt(receiptVerifier, packet, receipt, timeoutMs);
    const linkage = deriveLinkage(packet, receipt, live.gates);
    const target = packet.payload.target;
    if (!target || !Number.isInteger(linkage.pr_number) || linkage.pr_number <= 0
      || typeof target.branch !== 'string' || typeof target.git_common_dir !== 'string'
      || typeof linkage.url !== 'string') {
      fail('PR_LIFECYCLE_LINKAGE_UNAVAILABLE', 'receipt acceptance requires authoritative PR linkage fields');
    }
    const trace = await readLifecycleTrace(provider, linkage, timeoutMs, target.git_common_dir);
    traceLinkageRow(trace, linkage);
    const durable = durableAcceptance(trace, packet, receipt);
    if (durable) assertTraceLinkage(trace, linkage, packet, receipt);
    else {
      await callMethod(provider, 'recordOpenedPrLinkage', [{
        phase: 'opened',
        git_common_dir: target.git_common_dir,
        repo: linkage.repository_id,
        number: linkage.pr_number,
        branch: target.branch,
        url: linkage.url,
        occurred_at: receipt.payload.ended_at ?? receipt.created_at,
        work_packet: packet,
        run_receipt: receipt,
      }, { actor: packet.provenance.actor_id, sessionId: input.session_id ?? input.sessionId }], 'PR linkage', {
        sanitize: true, allowGitCommonDir: true, timeoutMs, reconcileOnTimeout: true,
      });
      const persistedTrace = await readLifecycleTrace(provider, linkage, timeoutMs, target.git_common_dir);
      assertTraceLinkage(persistedTrace, linkage, packet, receipt);
    }
    return stableResult('accepted', packet, receipt, linkage);
  }

  async function requestNextWork(rawInput = {}) {
    const input = snapshot(rawInput, 'next work input');
    const method = typeof provider.listReadyWork === 'function' ? 'listReadyWork' : undefined;
    const response = method
      ? await callMethod(provider, method, [input], 'ready', { timeoutMs, project: projectReadyResponse })
      : await callMethod(provider, 'runIssueOperation', ['ready', [], {
        actor: input.actor_id ?? input.actorId,
        sessionId: input.session_id ?? input.sessionId,
        worktreeId: input.worktree_id ?? input.worktreeId,
      }], 'ready', { timeoutMs, unwrap: true, project: projectReadyResponse });
    const ready = Array.isArray(response) ? response : response?.issues;
    if (!Array.isArray(ready)) fail('PR_LIFECYCLE_UNAVAILABLE', 'ready provider returned a malformed queue');
    return ready;
  }

  return Object.freeze({ issueWorkPacket, acceptRunReceipt, requestNextWork });
}

module.exports = { PR_LIFECYCLE_PROVIDER_METHODS, PrLifecycleAuthorityError, createPrLifecycleAuthority };
