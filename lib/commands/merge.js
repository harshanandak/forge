'use strict';

/**
 * merge command — opt-in conditional auto-merge.
 *
 * `forge merge --auto <pr> --expect-head <sha> --issue <id>` is the ONLY path by which Forge will merge a PR on
 * its own, and it stays OFF unless the user has explicitly opted in. It reads
 * the `merge.auto` section of `.forge/config.yaml`:
 *
 *   merge:
 *     auto:
 *       enabled: true           # default false / absent → strict NO-OP
 *       rules:                  # ALL must pass (see lib/merge-rules.js)
 *         - checks_green        # or scope it, e.g. for a docs-only task that
 *                               # may take a coverage dip:
 *                               #   - checks_green: { ignore: ["Coverage"] }
 *         - threads_resolved
 *         - no_conflicts        # recommended: never merge a conflicting branch
 *         - not_behind
 *         - settle_min: 10
 *
 * Flow: with no config (or `enabled` not true) the command is a strict NO-OP —
 * it prints why and merges nothing, preserving the test-enforced
 * never-auto-merge-by-default invariant. When enabled, it fetches the PR
 * context via `gh`, evaluates the rules with the pure `evaluateMergeRules`, and
 * merges ONLY when every rule passes. Two extra safety layers wrap that decision:
 * a pre-flight guard that no-ops on an already merged/closed PR (idempotent
 * re-runs), and a TOCTOU live re-check that re-fetches and re-evaluates right
 * before merging so a stale snapshot can never merge a since-changed PR. The
 * gh-fetch and the merge action are isolated behind injectable `fetchPrContext`
 * / `mergePr` seams so the decision path is unit-testable without the network.
 *
 * A bring-your-own custom-predicate seam (registered via `forge add`) is a
 * documented follow-up and intentionally NOT wired here. Further follow-ups
 * documented in lib/merge-rules.js: opt-in `auto_update`, required-checks
 * scoping for `checks_green`, a configurable merge `method`, and post-merge
 * branch deletion.
 *
 * @module commands/merge
 */

const { execFileSync } = require('node:child_process');

const { loadRawConfig } = require('../config-writer');
const { evaluateMergeRules } = require('../merge-rules');
const { runIssueOperation } = require('../forge-issues');
const { PrStateAdapter } = require('../adapters/pr-state-adapter');
const { stripGlobalFlags } = require('../global-flags');
const gateCommand = require('./gate');
const { computeContentHash, validateContractStructure } = require('../../packages/memory-contracts');

const FULL_HEAD_SHA = /^[0-9a-f]{40}$/i;
const FORGE_ISSUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POSITIVE_PR_NUMBER = /^[1-9][0-9]*$/;
const REPOSITORY_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CHECK_RUN_STATUSES = new Set(['QUEUED', 'IN_PROGRESS', 'COMPLETED', 'WAITING', 'PENDING', 'REQUESTED']);
const CHECK_RUN_CONCLUSIONS = new Set([
  '', 'SUCCESS', 'FAILURE', 'NEUTRAL', 'CANCELLED', 'SKIPPED', 'TIMED_OUT',
  'ACTION_REQUIRED', 'STALE', 'STARTUP_FAILURE',
]);
const SAFE_TERMINAL_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const STATUS_CONTEXT_STATES = new Set(['ERROR', 'EXPECTED', 'FAILURE', 'PENDING', 'SUCCESS']);
const REVIEW_ACTOR_TYPENAMES = new Set([
  'Bot', 'EnterpriseUserAccount', 'Mannequin', 'Organization', 'User',
]);
const REVIEW_STATES = new Set([
  'APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING',
]);
const MERGE_GATE = 'gate.merge';

function uuidFromSeed(seed) {
  const hash = computeContentHash({ seed });
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function contractEnvelope(schemaId, objectId, createdAt, actor, payload) {
  const value = {
    schema_id: schemaId,
    schema_version: 1,
    object_id: objectId,
    created_at: createdAt,
    producer: { product_id: 'forge', product_version: '0.1.0', instance_id: actor },
    capabilities_used: [],
    provenance: { source_kind: 'guarded-merge', actor_class: 'system', actor_id: actor },
    payload,
    extensions: {},
  };
  value.content_hash = computeContentHash(value);
  const validation = validateContractStructure(value);
  if (!validation.ok) throw new Error(`${schemaId} validation failed`);
  return value;
}

function currentTimestamp(now = Date.now) {
  const value = typeof now === 'function' ? now() : now;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Merge decision clock is invalid.');
  return date.toISOString();
}

function normalizeFullHeadSha(value) {
  return typeof value === 'string' && FULL_HEAD_SHA.test(value) ? value.toLowerCase() : null;
}

function normalizePrNumber(value) {
  if (typeof value !== 'string' || !POSITIVE_PR_NUMBER.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? String(parsed) : null;
}

function normalizeKernelPrNumber(value) {
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === 'string' ? normalizePrNumber(value) : null;
}

function normalizeRepository(value) {
  return typeof value === 'string' && REPOSITORY_NAME.test(value) ? value.toLowerCase() : null;
}

function terminalEvidenceFromTrace(row, { issueId, repository, number, expectedHead }) {
  const normalizedExpectedHead = normalizeFullHeadSha(expectedHead);
  if (!normalizedExpectedHead) return { invalid: true };
  const merged = (Array.isArray(row?.iterations) ? row.iterations : [])
    .filter(iteration => iteration?.type === 'pr.merged');
  if (merged.length === 0) return null;
  const exact = merged.filter(iteration => iteration.issue_id === issueId
    && Number.isInteger(iteration.issue_revision) && iteration.issue_revision >= 0
    && normalizeFullHeadSha(iteration.head_sha) === normalizedExpectedHead
    && typeof iteration.at === 'string' && Number.isFinite(Date.parse(iteration.at))
    && /^[0-9a-f]{64}$/.test(iteration.work_packet_hash)
    && /^[0-9a-f]{64}$/.test(iteration.run_receipt_hash));
  if (exact.length !== 1) return { invalid: true };
  const iteration = exact[0];
  const decisionSeed = `${issueId}:${iteration.issue_revision}:${repository}:${number}:${normalizedExpectedHead}`;
  return {
    decisionId: uuidFromSeed(`merge-packet:${decisionSeed}`),
    receiptId: uuidFromSeed(`merge-receipt:${iteration.work_packet_hash}`),
    receiptHash: iteration.run_receipt_hash,
    occurredAt: iteration.at,
  };
}

function parseMergeArgs(argv) {
  const values = { auto: false, pr: null, expectedHead: null, issueId: null, error: null };
  const seen = new Set();
  const input = Array.isArray(argv) ? argv : [];

  for (let index = 0; index < input.length; index += 1) {
    const raw = String(input[index]);
    if (raw === '--auto') {
      values.auto = true;
      continue;
    }

    let option = null;
    let inlineValue = null;
    if (raw === '--expect-head' || raw === '--issue') option = raw;
    else if (raw.startsWith('--expect-head=')) {
      option = '--expect-head';
      inlineValue = raw.slice('--expect-head='.length);
    } else if (raw.startsWith('--issue=')) {
      option = '--issue';
      inlineValue = raw.slice('--issue='.length);
    }

    if (option) {
      if (seen.has(option)) {
        values.error = `Duplicate ${option} is not allowed.`;
        break;
      }
      seen.add(option);
      let value = inlineValue;
      if (value === null) {
        const candidate = input[index + 1];
        if (candidate === undefined || String(candidate).startsWith('--')) {
          values.error = `${option} requires a value.`;
          break;
        }
        value = String(candidate);
        index += 1;
      }
      if (!value) {
        values.error = `${option} requires a value.`;
        break;
      }
      if (option === '--expect-head') values.expectedHead = normalizeFullHeadSha(value);
      else values.issueId = FORGE_ISSUE_ID.test(value) ? value.toLowerCase() : null;
      if ((option === '--expect-head' && !values.expectedHead)
        || (option === '--issue' && !values.issueId)) {
        values.error = `${option} has an invalid value.`;
        break;
      }
      continue;
    }

    if (raw.startsWith('--')) {
      values.error = `Unknown merge option: ${raw}`;
      break;
    }
    if (values.pr !== null) {
      values.error = 'Exactly one PR number is required.';
      break;
    }
    values.pr = normalizePrNumber(raw);
    if (!values.pr) {
      values.error = 'PR selector must be one positive decimal PR number.';
      break;
    }
  }

  return values;
}

function resolveOwnershipActor(env = process.env) {
  return (typeof env.FORGE_ACTOR === 'string' && env.FORGE_ACTOR.trim())
    || (typeof env.FORGE_SESSION_ID === 'string' && env.FORGE_SESSION_ID.trim())
    || null;
}

async function defaultVerifyIssueOwnership({
  issueId, projectRoot, actor: expectedActor, env = process.env, runIssue = runIssueOperation,
}) {
  const actor = expectedActor || resolveOwnershipActor(env);
  if (!actor) return { owned: false, actor: null, error: 'FORGE_ACTOR or FORGE_SESSION_ID is required.' };
  const frozenEnv = { ...env, FORGE_ACTOR: actor };
  const result = await runIssue('owns', [issueId], projectRoot, { env: frozenEnv });
  const data = result?.data;
  const ownershipMatches = result?.ok === true && data?.owned === true
    && data.expired === false && data.actor === actor && data.claimed_by === actor;
  const expectedSessionId = typeof env.FORGE_SESSION_ID === 'string' && env.FORGE_SESSION_ID.trim()
    ? env.FORGE_SESSION_ID.trim()
    : null;
  let sessionId = null;
  if (ownershipMatches && expectedSessionId) {
    const claimsResult = await runIssue('claims', [], projectRoot, { env: frozenEnv });
    const claims = claimsResult?.ok === true && Array.isArray(claimsResult.data?.claims)
      ? claimsResult.data.claims
      : [];
    const exactClaims = claims.filter(claim => claim?.issue_id === issueId
      && claim?.actor === actor && claim?.session_id === expectedSessionId);
    sessionId = exactClaims.length === 1 ? exactClaims[0].session_id : null;
  }
  const owned = ownershipMatches && (!expectedSessionId || sessionId === expectedSessionId);
  return {
    owned: Boolean(owned),
    actor,
    claimedBy: data?.claimed_by,
    sessionId,
    expired: typeof data?.expired === 'boolean' ? data.expired : null,
    error: result?.error,
  };
}

function selectPrBindingRow(rows, repository, number) {
  if (!Array.isArray(rows)) return { error: 'Kernel PR linkage is unreadable.' };
  const sameRepositoryRows = rows.filter(row => normalizeRepository(row?.repo) === repository);
  if (sameRepositoryRows.some(row => !normalizeKernelPrNumber(row.number))) {
    return { error: 'Kernel PR linkage contains a malformed PR number.' };
  }
  const matches = sameRepositoryRows.filter(row => normalizeKernelPrNumber(row.number) === number);
  if (matches.length !== 1) return { error: 'Kernel PR linkage is missing or ambiguous.' };
  return { row: matches[0] };
}

async function openPrBindingBroker(projectRoot, buildBroker) {
  if (buildBroker) {
    const built = await buildBroker({ projectRoot });
    return { built, ownsDriver: false };
  }
  const { resolveGitCommonDir } = require('../kernel/broker');
  const { buildMigratedKernelIssueDeps } = require('../kernel/cli-broker-factory');
  const gitCommonDir = resolveGitCommonDir(projectRoot);
  const deps = await buildMigratedKernelIssueDeps({ projectRoot, gitCommonDir });
  return {
    built: { gitCommonDir, broker: deps.kernelBroker, driver: deps.kernelDriver },
    ownsDriver: true,
  };
}

async function readPrBindingRows(built, allowRetired, { issueId, number, repository }) {
  if (allowRetired) {
    const read = await built.broker.readTrace({
      issue_id: issueId, pr_number: Number(number), repo: repository,
    });
    return read?.pull_requests;
  }
  return built.broker.listOpenPrs(built.gitCommonDir);
}

async function defaultVerifyPrIssueBinding({
  issueId,
  pr,
  projectRoot,
  prContext,
  buildBroker,
  allowRetired = false,
}) {
  const number = normalizePrNumber(String(pr));
  const repository = normalizeRepository(prContext?.repository);
  if (!number || !repository || !prContext || prContext.number !== Number(number)) {
    return { bound: false, error: 'PR identity is unreadable or does not match the requested PR number.' };
  }

  let built;
  let ownsDriver = false;
  try {
    ({ built, ownsDriver } = await openPrBindingBroker(projectRoot, buildBroker));
    const linkageReader = allowRetired ? built?.broker?.readTrace : built?.broker?.listOpenPrs;
    if (!built?.broker || typeof linkageReader !== 'function'
      || typeof built.gitCommonDir !== 'string' || !built.gitCommonDir) {
      return { bound: false, error: 'Kernel PR linkage reader is unavailable.' };
    }
    const rows = await readPrBindingRows(built, allowRetired, { issueId, number, repository });
    const selection = selectPrBindingRow(rows, repository, number);
    if (!selection.row) return { bound: false, error: selection.error };
    const { row } = selection;
    const bound = (allowRetired || row.state === 'open') && row.issue_id === issueId;
    const terminalEvidence = allowRetired && bound
      ? terminalEvidenceFromTrace(row, {
        issueId,
        repository,
        number: Number(number),
        expectedHead: normalizeFullHeadSha(prContext?.headSha),
      })
      : null;
    if (terminalEvidence?.invalid) {
      return { bound: false, error: 'Kernel merged PR evidence is incomplete or ambiguous.' };
    }
    return {
      bound,
      repository,
      number: Number(number),
      issueId: row.issue_id || null,
      branch: row.branch || null,
      url: row.url || null,
      gitCommonDir: row.git_common_dir || built.gitCommonDir,
      error: bound ? null : (allowRetired
        ? 'Kernel PR row is linked to a different issue.'
        : 'Kernel PR row is not open or is linked to a different issue.'),
      ...(terminalEvidence ? { terminalEvidence } : {}),
    };
  } catch (err) {
    return { bound: false, error: `Kernel PR linkage verification failed: ${err.message}` };
  } finally {
    if (ownsDriver && typeof built?.driver?.close === 'function') {
      try { await built.driver.close(); } catch { /* cleanup must not mask the linkage verdict */ }
    }
  }
}

async function defaultVerifyMergeGate({ issueId, projectRoot, now }) {
  const result = await gateCommand.handler(
    ['check', issueId, MERGE_GATE],
    {},
    projectRoot,
    { now },
  );
  return result;
}

async function defaultPrepareMergeDecision({
  issueId,
  pr,
  expectedHead,
  repository,
  binding,
  actor,
  sessionId,
  requireMergeGate = true,
  config,
  projectRoot,
  env = process.env,
  now = Date.now,
  runIssue = runIssueOperation,
}) {
  if (requireMergeGate !== true) {
    throw new Error('A disabled merge gate cannot produce broker-verifiable terminal authority.');
  }
  const timestamp = currentTimestamp(now);
  const frozenEnv = { ...env, FORGE_ACTOR: actor };
  if (sessionId) frozenEnv.FORGE_SESSION_ID = sessionId;
  else delete frozenEnv.FORGE_SESSION_ID;
  const issue = await runIssue('show', [issueId], projectRoot, {
    env: frozenEnv,
  });
  const revision = issue?.data?.revision;
  if (issue?.ok !== true || !Number.isInteger(revision) || revision < 0) {
    throw new Error('Live issue revision is unavailable for the merge decision.');
  }
  if (!binding || typeof binding.branch !== 'string' || !binding.branch
    || typeof binding.gitCommonDir !== 'string' || !binding.gitCommonDir) {
    throw new Error('Authoritative PR branch/worktree linkage is unavailable for the merge decision.');
  }
  const capabilityDigest = computeContentHash({ capability: 'forge.merge.exact-head.v1' });
  const workflowConfigRevision = computeContentHash({ merge: config.merge?.auto ?? null });
  const riskManifestDigest = computeContentHash({ rules: config.merge?.auto?.rules ?? [] });
  const decisionSeed = `${issueId}:${revision}:${repository}:${pr}:${expectedHead}`;
  const packet = contractEnvelope(
    'forge.memory.work-packet.v1',
    uuidFromSeed(`merge-packet:${decisionSeed}`),
    timestamp,
    actor,
    {
      issue_id: issueId,
      expected_issue_revision: revision,
      packet_id: `merge:${decisionSeed}`,
      packet_revision: 1,
      repository_id: repository,
      target_head: expectedHead,
      objective: `Guarded exact-head merge of ${repository}#${pr}`,
      authority: { kind: 'kernel-live-lease', issue_revision: revision },
      allowed_mutations: ['pr.merged'],
      prohibited_actions: ['pr.opened', 'review-thread.resolve'],
      workflow_config_revision: workflowConfigRevision,
      capability_manifest_digest: capabilityDigest,
      risk_manifest_digest: riskManifestDigest,
      receipt_requirements: { gate_ids: requireMergeGate ? [MERGE_GATE] : [] },
      target: {
        pr_number: Number(pr),
        branch: binding.branch,
        git_common_dir: binding.gitCommonDir,
        ...(binding.url ? { url: binding.url } : {}),
      },
    },
  );
  return {
    decisionId: packet.object_id,
    packet,
    occurredAt: timestamp,
    actor,
    sessionId: sessionId || null,
    binding: { ...binding },
  };
}

async function defaultRecordMergeDecision({ decision, mergeResult, pr, expectedHead, repository, projectRoot, buildBroker }) {
  if (!decision?.packet || !decision?.binding) throw new Error('Merge decision evidence is unavailable.');
  const recovered = mergeResult?.recovered === true;
  const receipt = contractEnvelope(
    'forge.memory.run-receipt.v1',
    uuidFromSeed(`merge-receipt:${decision.packet.content_hash}`),
    decision.occurredAt,
    decision.actor,
    {
      packet_hash: decision.packet.content_hash,
      run_id: `merge:${repository}:${pr}:${expectedHead}`,
      attempt_id: `merge:${expectedHead}`,
      exact_head: expectedHead,
      packet_revision: decision.packet.payload.packet_revision,
      manifest_digest: decision.packet.payload.capability_manifest_digest,
      workflow_config_revision: decision.packet.payload.workflow_config_revision,
      status: 'PASS',
      executor: { product_id: 'forge', mode: recovered ? 'guarded-exact-head-recovery' : 'guarded-exact-head' },
      started_at: decision.occurredAt,
      ended_at: decision.occurredAt,
      evidence_refs: [{ kind: 'pr', repository, pr_number: Number(pr), head_sha: expectedHead }],
      validation: { status: 'PASS', decision_id: decision.decisionId },
      cleanup: { status: 'NOT_REQUIRED' },
      mutations_attempted: ['pr.merged'],
      mutations_authorized: ['pr.merged'],
    },
  );

  let built;
  const ownsDriver = !buildBroker;
  try {
    if (buildBroker) built = await buildBroker({ projectRoot });
    else {
      const { buildMigratedKernelIssueDeps } = require('../kernel/cli-broker-factory');
      const deps = await buildMigratedKernelIssueDeps({
        projectRoot,
        gitCommonDir: decision.binding.gitCommonDir,
      });
      built = { broker: deps.kernelBroker, driver: deps.kernelDriver };
    }
    if (!built?.broker) throw new Error('Kernel lifecycle provider is unavailable.');
    const { createMemoryAuthorityProvider } = require('../../packages/memory');
    const provider = createMemoryAuthorityProvider({ broker: built.broker });
    await provider.recordPrLinkage({
      phase: 'merged',
      git_common_dir: decision.binding.gitCommonDir,
      repo: repository,
      number: Number(pr),
      branch: decision.binding.branch,
      ...(decision.binding.url ? { url: decision.binding.url } : {}),
      occurred_at: decision.occurredAt,
      work_packet: decision.packet,
      run_receipt: receipt,
    }, {
      actor: decision.actor,
      sessionId: decision.sessionId,
      requireExactLifecycleOwnership: true,
    });
    return { receiptId: receipt.object_id, receiptHash: receipt.content_hash };
  } finally {
    if (ownsDriver && built?.driver && typeof built.driver.close === 'function') {
      try { await built.driver.close(); } catch { /* terminal evidence outcome remains authoritative */ }
    }
  }
}

function strictCheckSuccess(check) {
  if (!check || typeof check !== 'object') return false;
  const hasStatus = Object.prototype.hasOwnProperty.call(check, 'status');
  const hasConclusion = Object.prototype.hasOwnProperty.call(check, 'conclusion');
  const hasState = Object.prototype.hasOwnProperty.call(check, 'state');
  if (hasState) {
    return !hasStatus && !hasConclusion && String(check.state || '').toUpperCase() === 'SUCCESS';
  }
  return hasStatus && hasConclusion
    && String(check.status || '').toUpperCase() === 'COMPLETED'
    && String(check.conclusion || '').toUpperCase() === 'SUCCESS';
}

/**
 * Mandatory preflight accepts only terminal check-run conclusions that are safe
 * to classify as optional. Required checks are still evaluated with
 * strictCheckSuccess below, and status contexts never gain NEUTRAL/SKIPPED
 * semantics because their only successful terminal state is SUCCESS.
 */
function safeTerminalCheck(check) {
  if (!check || typeof check !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(check, 'state')) return strictCheckSuccess(check);
  return Object.prototype.hasOwnProperty.call(check, 'status')
    && Object.prototype.hasOwnProperty.call(check, 'conclusion')
    && String(check.status || '').toUpperCase() === 'COMPLETED'
    && SAFE_TERMINAL_CONCLUSIONS.has(String(check.conclusion || '').toUpperCase());
}

function malformedCheckObservation(check) {
  if (!check || typeof check !== 'object') return true;
  const name = check.name || check.context;
  if (typeof name !== 'string' || !name.trim()) return true;
  if (!Object.prototype.hasOwnProperty.call(check, 'appId')) return true;
  const hasStatus = Object.prototype.hasOwnProperty.call(check, 'status');
  const hasConclusion = Object.prototype.hasOwnProperty.call(check, 'conclusion');
  const hasState = Object.prototype.hasOwnProperty.call(check, 'state');
  const status = String(check.status || '').toUpperCase();
  const conclusion = String(check.conclusion || '').toUpperCase();
  const state = String(check.state || '').toUpperCase();
  if (hasState) {
    return hasStatus || hasConclusion || check.appId !== null
      || typeof check.state !== 'string' || !STATUS_CONTEXT_STATES.has(state);
  }
  if (!hasStatus || !hasConclusion || !Number.isInteger(check.appId) || check.appId <= 0) return true;
  if (hasStatus && (typeof check.status !== 'string' || !CHECK_RUN_STATUSES.has(status))) return true;
  if (hasConclusion && check.conclusion !== null && typeof check.conclusion !== 'string') return true;
  if (hasConclusion && !CHECK_RUN_CONCLUSIONS.has(conclusion)) return true;
  if (hasStatus && status === 'COMPLETED' && !conclusion) return true;
  if (hasStatus && status !== 'COMPLETED' && conclusion) return true;
  return ['status', 'conclusion', 'state']
    .some((key) => String(check[key] || '').toUpperCase() === 'UNREADABLE');
}

function normalizeRequiredEntry(entry) {
  if (!entry || typeof entry.context !== 'string' || !entry.context.trim()) return null;
  if (!Object.prototype.hasOwnProperty.call(entry, 'appId')) return null;
  if (entry.appId !== null && (!Number.isInteger(entry.appId) || entry.appId <= 0)) return null;
  return { context: entry.context, appId: entry.appId };
}

function normalizeRollupObservation(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.__typename === 'StatusContext') {
    return { name: entry.context, state: entry.state };
  }
  if (entry.__typename === 'CheckRun') {
    return { name: entry.name, status: entry.status, conclusion: entry.conclusion };
  }
  return null;
}

function malformedRollupObservation(observation) {
  if (!observation || typeof observation.name !== 'string' || !observation.name.trim()) return true;
  const hasState = Object.prototype.hasOwnProperty.call(observation, 'state');
  if (hasState) {
    return Object.prototype.hasOwnProperty.call(observation, 'status')
      || Object.prototype.hasOwnProperty.call(observation, 'conclusion')
      || typeof observation.state !== 'string'
      || !STATUS_CONTEXT_STATES.has(observation.state.toUpperCase());
  }
  const status = String(observation.status || '').toUpperCase();
  const conclusion = String(observation.conclusion || '').toUpperCase();
  if (typeof observation.status !== 'string' || !CHECK_RUN_STATUSES.has(status)) return true;
  if (observation.conclusion !== null && typeof observation.conclusion !== 'string') return true;
  if (!CHECK_RUN_CONCLUSIONS.has(conclusion)) return true;
  if (status === 'COMPLETED' && !conclusion) return true;
  return status !== 'COMPLETED' && Boolean(conclusion);
}

function evaluateProtectedRequiredChecks(context) {
  if (!context || context.requiredCheckSource !== 'protection'
    || !Array.isArray(context.requiredChecks) || !Array.isArray(context.checks)) {
    return { allowed: false, reason: 'Protected required-check policy is unreadable or non-authoritative.' };
  }
  const required = context.requiredChecks.map(normalizeRequiredEntry);
  if (required.some((entry) => !entry)) {
    return { allowed: false, reason: 'Protected required-check policy contains malformed entries.' };
  }
  const policyApps = new Map();
  for (const entry of required) {
    if (!policyApps.has(entry.context)) policyApps.set(entry.context, new Set());
    policyApps.get(entry.context).add(entry.appId === null ? '*' : String(entry.appId));
  }
  if ([...policyApps.values()].some((apps) => apps.size > 1)) {
    return { allowed: false, reason: 'Protected required-check policy contains conflicting application identities.' };
  }
  if (context.checks.some(malformedCheckObservation)) {
    return { allowed: false, reason: 'Check-run observation collection contains malformed entries.' };
  }
  const missing = [];
  const nonSuccess = [];
  for (const entry of required) {
    const matching = context.checks.filter((check) => check
      && (check.name || check.context) === entry.context
      && (entry.appId === null || check.appId === entry.appId));
    const label = entry.appId === null ? entry.context : `${entry.context}@app:${entry.appId}`;
    if (matching.length === 0) missing.push(label);
    else if (matching.some((check) => !strictCheckSuccess(check))) nonSuccess.push(label);
  }
  if (missing.length || nonSuccess.length) {
    const parts = [];
    if (missing.length) parts.push(`missing: ${missing.join(', ')}`);
    if (nonSuccess.length) parts.push(`non-success: ${nonSuccess.join(', ')}`);
    return {
      allowed: false,
      reason: `Protected required checks are not successful (${parts.join('; ')}).`,
      details: { missing, nonSuccess },
    };
  }
  return { allowed: true, details: { missing: [], nonSuccess: [] } };
}

function mandatoryContextError(context, expectedHead) {
  const observedHead = normalizeFullHeadSha(context && context.headSha);
  if (!observedHead || observedHead !== expectedHead) {
    return 'PR head changed or could not be verified against --expect-head.';
  }
  if (context.state !== 'OPEN') return 'PR lifecycle state is unreadable or is not OPEN.';
  if (context.isDraft !== false) return 'PR draft status is unreadable or the PR is still a draft.';
  if (context.conflicting !== false) return 'PR conflict status is unreadable or conflicting.';
  if (context.unresolvedThreads !== 0) return 'Review-thread state is unreadable or unresolved threads remain.';
  if (context.reviewEvidenceReadable !== true || !Array.isArray(context.reviews)) {
    return 'Review evidence is unreadable.';
  }
  for (const review of context.reviews) {
    const state = review && typeof review.state === 'string' ? review.state.toUpperCase() : '';
    const timestamps = review
      ? [review.createdAt, review.updatedAt, review.submittedAt, review.activityAt]
      : [];
    if (!review || typeof review.id !== 'string' || !review.id
      || typeof review.author !== 'string' || !review.author
      || !REVIEW_ACTOR_TYPENAMES.has(review.authorTypename)
      || !REVIEW_STATES.has(state)
      || typeof review.commitOid !== 'string' || !FULL_HEAD_SHA.test(review.commitOid)
      || typeof review.body !== 'string'
      || timestamps.length !== 4
      || timestamps.some((value) => typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) {
      return 'Review evidence contains malformed identity, state, timestamp, or commit-head data.';
    }
    if (state !== 'DISMISSED' && state !== 'COMMENTED' && review.commitOid.toLowerCase() !== expectedHead) {
      return 'Latest active review evidence is stale for the expected PR head.';
    }
    if (state === 'CHANGES_REQUESTED' || state === 'PENDING') {
      return `Latest review state ${state} does not authorize merging.`;
    }
  }
  if (!Array.isArray(context.checks) || context.checks.some(malformedCheckObservation)
    || context.checks.some((check) => !safeTerminalCheck(check))) {
    return 'Every check-run and status observation must be complete and have a safe terminal conclusion (SUCCESS, NEUTRAL, or SKIPPED).';
  }
  if (Object.prototype.hasOwnProperty.call(context, 'providerObservations')) {
    if (!Array.isArray(context.providerObservations)
      || context.providerObservations.some(malformedRollupObservation)
      || context.providerObservations.some((check) => !safeTerminalCheck(check))) {
      return 'The complete provider rollup must contain only observations with safe terminal conclusions (SUCCESS, NEUTRAL, or SKIPPED).';
    }
  }
  const protectedGate = evaluateProtectedRequiredChecks(context);
  return protectedGate.allowed ? null : protectedGate.reason;
}

async function recoverMergedTerminal({
  pr, parsed, root, config, prContext, ownershipActor, ownershipSessionId, deps, replayOnly = false,
}) {
  const repository = normalizeRepository(prContext?.repository);
  if (normalizeFullHeadSha(prContext?.headSha) !== parsed.expectedHead || !repository) {
    return { success: false, merged: true, error: 'Merged PR identity does not match the expected head and repository.' };
  }
  const verifyPrIssueBinding = deps.verifyPrIssueBinding || defaultVerifyPrIssueBinding;
  const binding = await verifyPrIssueBinding({
    issueId: parsed.issueId,
    pr,
    projectRoot: root,
    prContext,
    buildBroker: deps.buildPrBindingBroker,
    allowRetired: true,
  });
  if (binding?.bound !== true) {
    return { success: false, merged: true, error: 'Merged PR is not authoritatively linked to the supplied Forge issue.' };
  }
  if (binding.terminalEvidence) {
    return {
      success: true, merged: true, enabled: true, recovered: true,
      ...binding.terminalEvidence,
    };
  }
  if (replayOnly) {
    return {
      success: false,
      merged: true,
      replayMissing: true,
      error: 'Merged PR terminal evidence is not yet available for replay.',
    };
  }
  const decisionAt = currentTimestamp(deps.now || Date.now);
  const verifyMergeGate = deps.verifyMergeGate || defaultVerifyMergeGate;
  const gateApproval = await verifyMergeGate({
    issueId: parsed.issueId, projectRoot: root, actor: ownershipActor, now: decisionAt,
  });
  if (gateApproval !== true && gateApproval?.approved !== true && gateApproval?.disabled !== true) {
    return { success: false, merged: true, error: `${MERGE_GATE} is not approved for this issue.` };
  }
  if (gateApproval?.disabled === true) {
    return {
      success: false,
      merged: true,
      error: 'The disabled merge gate cannot produce broker-verifiable terminal authority.',
    };
  }
  const prepareMergeDecision = deps.prepareMergeDecision || defaultPrepareMergeDecision;
  const decision = await prepareMergeDecision({
    issueId: parsed.issueId,
    pr,
    expectedHead: parsed.expectedHead,
    repository,
    binding,
    actor: ownershipActor,
    sessionId: ownershipSessionId,
    env: deps.env || process.env,
    requireMergeGate: gateApproval?.disabled !== true,
    config,
    projectRoot: root,
    now: decisionAt,
  });
  if (!decision || typeof decision.decisionId !== 'string' || !decision.decisionId) {
    return { success: false, merged: true, error: 'Merge recovery decision evidence is unavailable.' };
  }
  const recordMergeDecision = deps.recordMergeDecision || defaultRecordMergeDecision;
  try {
    const terminal = await recordMergeDecision({
      decision,
      mergeResult: { merged: true, recovered: true },
      pr,
      expectedHead: parsed.expectedHead,
      repository,
      projectRoot: root,
      buildBroker: deps.buildMergeBroker,
    });
    if (!terminal || typeof terminal.receiptId !== 'string' || !terminal.receiptId) {
      throw new Error('terminal receipt evidence is unavailable');
    }
    return {
      success: true, merged: true, enabled: true, recovered: true,
      decisionId: decision.decisionId, ...terminal,
    };
  } catch (error) {
    return {
      success: false, merged: true, enabled: true, decisionId: decision.decisionId,
      error: `Merged PR terminal linkage recovery failed: ${error.message}`,
    };
  }
}

/** Default `gh` runner. Only reached by the default fetch/merge seams (never in unit tests). */
function defaultGh(args, options = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', ...options }); // NOSONAR S4036 - hardcoded CLI (gh), args array (no shell), developer-tool context
}

/** Parse `gh ... --json` output, returning `null` on any failure (callers fail closed). */
function ghJson(gh, args) {
  try {
    return JSON.parse(gh(args) || '{}');
  } catch (_err) {
    return null;
  }
}

/**
 * Read the unresolved review-thread count via the GraphQL API. `reviewThreads`
 * is not a valid `gh pr view --json` field, so this needs a dedicated query.
 * Returns `undefined` on any failure so `threads_resolved` fails closed.
 */
function fetchUnresolvedThreadCount(gh, { owner, repo, pr }) {
  try {
    if (!owner || !repo) return undefined;
    // Paginate through ALL review threads — a PR can have >100, and the ones on
    // later pages could be the unresolved/newest ones. Stopping at page 1 would
    // both miss them and make a large PR un-mergeable. Loop on the GraphQL cursor
    // until hasNextPage is false; any unreadable page → undefined (fail closed).
    const query = 'query($o:String!,$n:String!,$pr:Int!,$after:String){repository(owner:$o,name:$n)'
      + '{pullRequest(number:$pr){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{isResolved isOutdated}}}}}';
    let after = '';
    let count = 0;
    for (let page = 0; page < 100; page += 1) { // 100-page cap = 10k threads backstop
      const args = ['api', 'graphql', '-f', `query=${query}`,
        '-F', `o=${owner}`, '-F', `n=${repo}`, '-F', `pr=${Number(pr)}`];
      if (after) args.push('-F', `after=${after}`);
      const data = JSON.parse(gh(args) || '{}');
      if (Object.prototype.hasOwnProperty.call(data, 'errors')
        && (!Array.isArray(data.errors) || data.errors.length > 0)) return undefined;
      const threads = (((data.data || {}).repository || {}).pullRequest || {}).reviewThreads;
      if (!threads || !Array.isArray(threads.nodes) || !threads.pageInfo
        || typeof threads.pageInfo.hasNextPage !== 'boolean'
        || (threads.pageInfo.endCursor !== null && typeof threads.pageInfo.endCursor !== 'string')
        || threads.nodes.some((thread) => !thread || typeof thread.isResolved !== 'boolean'
          || typeof thread.isOutdated !== 'boolean')) return undefined;
      count += threads.nodes.filter((thread) => thread.isResolved === false && thread.isOutdated === false).length;
      if (!threads.pageInfo.hasNextPage) return count;
      const nextCursor = threads.pageInfo.endCursor;
      if (typeof nextCursor !== 'string' || !nextCursor || nextCursor === after) return undefined;
      after = nextCursor;
    }
    return undefined; // exceeded the page cap → fail closed rather than undercount
  } catch (_err) {
    return undefined;
  }
}

function fetchCheckRunObservations(gh, { owner, repo, head }) {
  try {
    const pages = JSON.parse(gh([
      'api', '--paginate', '--slurp',
      `repos/${owner}/${repo}/commits/${head}/check-runs?filter=latest&per_page=100`,
    ]) || 'null');
    if (!Array.isArray(pages) || pages.length === 0
      || pages.some((page) => !page || !Array.isArray(page.check_runs)
        || !Number.isInteger(page.total_count) || page.total_count < 0)) return null;
    const runs = pages.flatMap((page) => page.check_runs);
    if (pages.some((page) => page.total_count !== pages[0].total_count)
      || pages[0].total_count !== runs.length) return null;
    if (runs.some((run) => {
      const name = run && typeof run.name === 'string' && run.name.trim() ? run.name : null;
      const appId = run && run.app && Number.isInteger(run.app.id) && run.app.id > 0 ? run.app.id : null;
      const headSha = normalizeFullHeadSha(run && run.head_sha);
      const status = String(run && run.status || '').toUpperCase();
      const conclusion = String(run && run.conclusion || '').toUpperCase();
      return !run || !Number.isInteger(run.id) || run.id <= 0 || !name || !appId || headSha !== head
        || !CHECK_RUN_STATUSES.has(status)
        || !Object.prototype.hasOwnProperty.call(run, 'conclusion')
        || (run.conclusion !== null && typeof run.conclusion !== 'string')
        || !CHECK_RUN_CONCLUSIONS.has(conclusion)
        || (status === 'COMPLETED' ? !conclusion : Boolean(conclusion));
    })) return null;
    return runs.map((run) => {
      const name = run.name;
      const appId = run.app.id;
      return {
        id: run.id,
        name,
        appId,
        status: String(run.status).toUpperCase(),
        conclusion: String(run.conclusion || '').toUpperCase(),
      };
    });
  } catch (_err) {
    return null;
  }
}

/**
 * Default PR-context fetcher (the network seam). Assembles the shape consumed
 * by `evaluateMergeRules` from `gh`. Anything it cannot read is left absent so
 * the dependent rule fails closed rather than guessing. Fully replaced by
 * `deps.fetchPrContext` in tests.
 *
 * @returns {object} prContext
 */
async function defaultFetchPrContext({ pr, gh = defaultGh, now = Date.now() }) {
  const view = ghJson(gh, ['pr', 'view', String(pr), '--json',
    'number,headRefOid,baseRefName,state,isDraft,mergeable,mergeStateStatus,statusCheckRollup,comments,updatedAt']) || {};

  const rollup = Array.isArray(view.statusCheckRollup) ? view.statusCheckRollup : null;

  const comments = Array.isArray(view.comments)
    ? view.comments.map((c) => ({
      author: (c.author && c.author.login) || '',
      at: [c.createdAt, c.updatedAt, c.submittedAt]
        .filter(Boolean)
        .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || '',
    }))
    : [];

  const repoIdentity = ghJson(gh, ['repo', 'view', '--json', 'owner,name']);
  const owner = repoIdentity && repoIdentity.owner && repoIdentity.owner.login;
  const repo = repoIdentity && repoIdentity.name;
  const adapter = owner && repo
    ? new PrStateAdapter({ gh: (_cmd, adapterArgs) => gh(adapterArgs) })
    : null;
  const reviews = adapter ? await adapter.readReviews({ owner, repo, pr }) : [];
  const approvals = reviews
    .filter((r) => String(r.state).toUpperCase() === 'APPROVED')
    .map((r) => ({ author: typeof r.author === 'string' ? r.author : '' }));

  // Derive from GitHub's mergeStateStatus / mergeable. Only a known set maps to
  // a definite answer; anything else stays undefined so the dependent rule fails
  // closed rather than guessing.
  const mergeStateStatus = String(view.mergeStateStatus || '').toUpperCase();
  const mergeable = String(view.mergeable || '').toUpperCase();

  let behindBase;
  if (mergeStateStatus === 'BEHIND') behindBase = true;
  else if (['CLEAN', 'UNSTABLE', 'HAS_HOOKS', 'BLOCKED', 'DIRTY'].includes(mergeStateStatus)) behindBase = false;

  // Conflict status: DIRTY (or mergeable=CONFLICTING) → conflicting; a clean set
  // of states → not conflicting; UNKNOWN / missing / still-computing → undefined.
  let conflicting;
  if (mergeStateStatus === 'DIRTY' || mergeable === 'CONFLICTING') conflicting = true;
  else if (['CLEAN', 'UNSTABLE', 'HAS_HOOKS', 'BLOCKED'].includes(mergeStateStatus)) conflicting = false;

  const isDraft = typeof view.isDraft === 'boolean' ? view.isDraft : undefined;
  const state = view.state ? String(view.state).toUpperCase() : undefined;

  const stamps = [
    ...comments.map((c) => c.at),
    ...reviews.flatMap((r) => [r.activityAt, r.createdAt, r.updatedAt, r.submittedAt]),
    view.updatedAt || '',
  ].map((s) => Date.parse(s)).filter((n) => !Number.isNaN(n));
  const lastActivityAt = stamps.length ? Math.max(...stamps) : undefined;

  const base = typeof view.baseRefName === 'string' ? view.baseRefName : null;
  const headSha = normalizeFullHeadSha(view.headRefOid);
  let requiredChecks = null;
  let requiredCheckSource = null;
  let checks = null;
  const providerObservations = rollup ? rollup.map(normalizeRollupObservation) : null;
  if (adapter && base) {
    requiredChecks = await adapter.readRequiredCheckPolicy({ owner, repo, base });
    requiredCheckSource = adapter.lastRequiredSource;
    const checkRuns = headSha ? fetchCheckRunObservations(gh, { owner, repo, head: headSha }) : null;
    if (rollup && checkRuns && providerObservations.every((entry) => entry !== null)) {
      const statuses = rollup
        .filter((entry) => entry && entry.__typename === 'StatusContext')
        .map((entry) => ({
          name: typeof entry.context === 'string' ? entry.context : '',
          appId: null,
          state: String(entry.state || '').toUpperCase(),
        }));
      checks = [...checkRuns, ...statuses];
    }
  }

  return {
    number: Number.isInteger(view.number) ? view.number : null,
    repository: owner && repo ? `${owner}/${repo}` : null,
    headSha: view.headRefOid || null,
    checks,
    providerObservations,
    requiredChecks,
    requiredCheckSource,
    requiredChecksKnown: requiredCheckSource === 'protection' && Array.isArray(requiredChecks),
    unresolvedThreads: fetchUnresolvedThreadCount(gh, { owner, repo, pr }),
    behindBase,
    conflicting,
    isDraft,
    state,
    approvals,
    reviews,
    reviewEvidenceReadable: adapter !== null,
    comments,
    lastActivityAt,
    now,
  };
}

/** Default merge action (squash), atomically bound to the reviewed remote head. */
function defaultMergePr({ pr, expectedHead, repository, gh = defaultGh }) {
  const head = normalizeFullHeadSha(expectedHead);
  const repo = normalizeRepository(repository);
  if (!head) throw new Error('A full 40-character expected PR head SHA is required.');
  if (!normalizePrNumber(String(pr)) || !repo) throw new Error('A canonical PR number and repository are required.');
  gh(['pr', 'merge', String(pr), '--repo', repo, '--squash', '--match-head-commit', head]);
  return { merged: true, method: 'squash' };
}

/**
 * Command handler.
 *
 * @param {string[]} args - Positional + flag args (first positional is the PR).
 * @param {object} _flags - Parsed flags (unused; flags are read from args).
 * @param {string} projectRoot - Project root.
 * @param {object} [deps] - Injected seams for testing: loadConfig, fetchPrContext, mergePr, gh, now.
 * @returns {Promise<object>} result envelope.
 */
async function handler(args, _flags, projectRoot, deps = {}) {
  const argv = Array.isArray(args) ? args : [];
  const parsed = parseMergeArgs(stripGlobalFlags(argv));
  const pr = parsed.pr;
  const root = projectRoot || process.cwd();

  if (!parsed.auto || !pr) {
    return {
      success: false,
      merged: false,
      error: 'Usage: forge merge --auto <pr> --expect-head <40-char-sha> --issue <issue-id>',
    };
  }

  const verifyIssueOwnership = deps.verifyIssueOwnership || defaultVerifyIssueOwnership;
  const ownershipEnv = deps.env || process.env;
  const ownershipActor = resolveOwnershipActor(ownershipEnv);
  const ownershipSessionId = typeof ownershipEnv.FORGE_SESSION_ID === 'string'
    && ownershipEnv.FORGE_SESSION_ID.trim()
    ? ownershipEnv.FORGE_SESSION_ID.trim()
    : null;
  const ownershipInput = {
    issueId: parsed.issueId,
    projectRoot: root,
    actor: ownershipActor,
    env: { ...ownershipEnv },
  };
  const fetchPrContext = deps.fetchPrContext || defaultFetchPrContext;
  const mergePr = deps.mergePr || defaultMergePr;
  const verifyPrIssueBinding = deps.verifyPrIssueBinding || defaultVerifyPrIssueBinding;
  const gh = deps.gh || defaultGh;
  const exactMergeIdentity = !parsed.error && parsed.expectedHead && parsed.issueId;
  let prContext; let prState = '';
  if (exactMergeIdentity) {
    try {
      prContext = await fetchPrContext({ pr, projectRoot: root, gh, now: deps.now || Date.now() });
    } catch (err) {
      return { success: false, merged: false, error: `Failed to fetch PR context: ${err.message}` };
    }
    prState = prContext?.state ? String(prContext.state).toUpperCase() : '';
    if (prState === 'MERGED') {
      try {
        const replay = await recoverMergedTerminal({
          pr, parsed, root, config: {}, prContext, ownershipActor, ownershipSessionId, deps, replayOnly: true,
        });
        if (replay.replayMissing !== true) return replay;
      } catch (error) {
        return { success: false, merged: true, error: `Merged PR terminal evidence replay failed: ${error.message}` };
      }
    }
  }

  const loadConfig = deps.loadConfig || loadRawConfig;
  let config;
  try {
    config = loadConfig(root) || {};
  } catch (err) {
    // A malformed .forge/config.yaml must NOT crash the command — fail closed:
    // refuse to auto-merge and report, rather than throwing past the contract.
    const reason = `Could not read merge config (${err.message}) — refusing to auto-merge (fail-closed).`;
    process.stdout.write(`${reason}\n`);
    return { success: false, merged: false, error: reason };
  }
  const auto = (config.merge && config.merge.auto) || {};
  const enabled = auto.enabled === true;
  const rules = Array.isArray(auto.rules) ? auto.rules : [];

  // Invariant: absent config or `enabled` not true → strict NO-OP. Forge never
  // auto-merges unless the user has explicitly opted in via .forge/config.yaml.
  if (!enabled) {
    const reason = 'Auto-merge is OPT-IN and OFF by default (merge.auto.enabled is not true in .forge/config.yaml). No action taken.';
    process.stdout.write(`${reason}\n`);
    return { success: true, merged: false, enabled: false, reason };
  }

  // Opted in but no rules → refuse (fail-closed): an empty ruleset is vacuously
  // "allowed", which would merge unconditionally. Treat that as misconfiguration.
  if (rules.length === 0) {
    const reason = 'merge.auto.enabled is true but no rules are configured — refusing to auto-merge (fail-closed). Add rules under merge.auto.rules.';
    process.stdout.write(`${reason}\n`);
    return { success: false, merged: false, enabled: true, reason };
  }

  if (!exactMergeIdentity) {
    const reason = parsed.error
      || 'Enabled auto-merge requires --expect-head <full 40-character SHA> and --issue <Forge issue ID>.';
    return { success: false, merged: false, enabled: true, error: reason };
  }

  let ownership;
  try {
    ownership = await verifyIssueOwnership(ownershipInput);
  } catch (err) {
    return { success: false, merged: false, error: `Failed to verify issue ownership: ${err.message}` };
  }
  if (!ownership || ownership.owned !== true || ownership.expired !== false
    || typeof ownership.actor !== 'string' || ownership.actor !== ownershipActor
    || typeof ownership.claimedBy !== 'string' || ownership.claimedBy !== ownershipActor
    || ownership.sessionId !== ownershipSessionId) {
    return {
      success: false,
      merged: false,
      error: `Active Kernel ownership claim with the exact session is required for issue ${parsed.issueId}; refusing to merge.`,
    };
  }

  if (prState === 'MERGED') {
    if (!ownershipSessionId) {
      return { success: false, merged: true, error: 'An exact FORGE_SESSION_ID session identity is required to recover terminal merge evidence.' };
    }
    try {
      return await recoverMergedTerminal({
        pr, parsed, root, config, prContext, ownershipActor, ownershipSessionId, deps,
      });
    } catch (error) {
      return { success: false, merged: true, error: `Merged PR terminal linkage recovery failed: ${error.message}` };
    }
  }
  if (prState === 'CLOSED') {
    const reason = `PR #${pr} is ${prState} (not OPEN) — nothing to merge. No action taken.`;
    process.stdout.write(`${reason}\n`);
    return { success: true, merged: false, enabled: true, state: prState, reason };
  }
  if (!ownershipSessionId) {
    return { success: false, merged: false, error: 'An exact FORGE_SESSION_ID session identity is required before merge.' };
  }

  const mandatoryError = mandatoryContextError(prContext, parsed.expectedHead);
  if (mandatoryError) return { success: false, merged: false, error: mandatoryError };
  const leasedRepository = normalizeRepository(prContext && prContext.repository);
  if (!leasedRepository) {
    return { success: false, merged: false, error: 'PR repository identity is unreadable; refusing to merge.' };
  }

  let binding;
  try {
    binding = await verifyPrIssueBinding({
      issueId: parsed.issueId,
      pr,
      projectRoot: root,
      prContext,
      buildBroker: deps.buildPrBindingBroker,
    });
  } catch (err) {
    return { success: false, merged: false, error: `Failed to verify PR issue binding: ${err.message}` };
  }
  if (!binding || binding.bound !== true) {
    return { success: false, merged: false, error: 'PR is not authoritatively linked to the supplied Forge issue.' };
  }

  const { allowed, unmet } = evaluateMergeRules(prContext, rules);

  if (!allowed) {
    process.stdout.write(`Auto-merge conditions NOT met for PR #${pr} — ${unmet.length} unmet rule(s):\n`);
    for (const item of unmet) {
      process.stdout.write(`  x ${item.rule} — ${item.reason}\n`);
    }
    return { success: true, merged: false, enabled: true, allowed: false, unmet, reason: 'auto-merge conditions not met' };
  }

  // TOCTOU guard: PR state can change between the first fetch and the merge — a
  // new comment resets configured settle_min, a required check regresses, or a thread opens.
  // Re-pull LIVE data and re-evaluate immediately before merging so our custom
  // rules (which GitHub's server-side branch protection does NOT enforce) are
  // honored against the freshest possible state, never a stale snapshot.
  let freshContext;
  try {
    freshContext = await fetchPrContext({ pr, projectRoot: root, gh, now: deps.now || Date.now() });
  } catch (err) {
    return { success: false, merged: false, error: `Failed to re-fetch PR context before merge: ${err.message}` };
  }
  // Re-apply the terminal-state guard on the FRESH context: the PR may have been
  // merged or closed between the first fetch and now. Never merge a terminal PR.
  const freshState = freshContext && freshContext.state ? String(freshContext.state).toUpperCase() : '';
  if (freshState === 'MERGED') {
    try {
      return await recoverMergedTerminal({
        pr, parsed, root, config, prContext: freshContext, ownershipActor, ownershipSessionId, deps,
      });
    } catch (error) {
      return { success: false, merged: true, error: `Merged PR terminal linkage recovery failed: ${error.message}` };
    }
  }
  if (freshState === 'CLOSED') {
    const reason = `PR #${pr} became ${freshState} (not OPEN) before merge — nothing to merge. No action taken.`;
    process.stdout.write(`${reason}\n`);
    return { success: true, merged: false, enabled: true, state: freshState, reason };
  }
  const freshMandatoryError = mandatoryContextError(freshContext, parsed.expectedHead);
  if (freshMandatoryError) return { success: false, merged: false, error: freshMandatoryError };
  const freshRepository = normalizeRepository(freshContext && freshContext.repository);
  if (!freshRepository || freshRepository !== leasedRepository) {
    return { success: false, merged: false, error: 'PR repository identity changed or became unreadable before merge.' };
  }
  const recheck = evaluateMergeRules(freshContext, rules);
  if (!recheck.allowed) {
    process.stdout.write(`Auto-merge ABORTED for PR #${pr} — state changed since first check; ${recheck.unmet.length} rule(s) now unmet:\n`);
    for (const item of recheck.unmet) {
      process.stdout.write(`  x ${item.rule} — ${item.reason}\n`);
    }
    return { success: true, merged: false, enabled: true, allowed: false, unmet: recheck.unmet, reason: 'PR state changed before merge (live re-check failed)' };
  }

  let freshBinding;
  try {
    freshBinding = await verifyPrIssueBinding({
      issueId: parsed.issueId,
      pr,
      projectRoot: root,
      prContext: freshContext,
      buildBroker: deps.buildPrBindingBroker,
    });
  } catch (err) {
    return { success: false, merged: false, error: `Failed to re-verify PR issue binding: ${err.message}` };
  }
  if (!freshBinding || freshBinding.bound !== true) {
    return { success: false, merged: false, error: 'PR issue linkage changed or is unreadable before merge.' };
  }

  let finalOwnership;
  try {
    finalOwnership = await verifyIssueOwnership(ownershipInput);
  } catch (err) {
    return { success: false, merged: false, error: `Failed to re-verify issue ownership before merge: ${err.message}` };
  }
  if (!finalOwnership || finalOwnership.owned !== true || finalOwnership.expired !== false
    || typeof finalOwnership.actor !== 'string' || finalOwnership.actor !== ownershipActor
    || typeof finalOwnership.claimedBy !== 'string' || finalOwnership.claimedBy !== ownershipActor
    || finalOwnership.sessionId !== ownershipSessionId) {
    return { success: false, merged: false, error: 'Kernel ownership changed or expired before merge; refusing to merge.' };
  }

  const decisionAt = currentTimestamp(deps.now || Date.now);
  const verifyMergeGate = deps.verifyMergeGate || defaultVerifyMergeGate;
  let gateApproval;
  try {
    gateApproval = await verifyMergeGate({
      issueId: parsed.issueId,
      projectRoot: root,
      actor: ownershipActor,
      now: decisionAt,
    });
  } catch (err) {
    return { success: false, merged: false, error: `Failed to verify ${MERGE_GATE}: ${err.message}` };
  }
  if (gateApproval !== true && gateApproval?.approved !== true && gateApproval?.disabled !== true) {
    return { success: false, merged: false, error: `${MERGE_GATE} is not approved for this issue.` };
  }
  if (gateApproval?.disabled === true) {
    return {
      success: false,
      merged: false,
      error: 'The disabled merge gate cannot produce broker-verifiable terminal authority; refusing to mutate GitHub.',
    };
  }

  const prepareMergeDecision = deps.prepareMergeDecision || defaultPrepareMergeDecision;
  let decision;
  try {
    decision = await prepareMergeDecision({
      issueId: parsed.issueId,
      pr,
      expectedHead: parsed.expectedHead,
      repository: leasedRepository,
      binding: freshBinding,
      actor: ownershipActor,
      sessionId: ownershipSessionId,
      env: ownershipEnv,
      requireMergeGate: gateApproval?.disabled !== true,
      config,
      projectRoot: root,
      now: decisionAt,
    });
  } catch (err) {
    return { success: false, merged: false, error: `Failed to prepare merge decision: ${err.message}` };
  }
  if (!decision || typeof decision.decisionId !== 'string' || !decision.decisionId) {
    return { success: false, merged: false, error: 'Merge decision evidence is unavailable.' };
  }

  let mergeResult;
  try {
    mergeResult = await mergePr({
      pr,
      expectedHead: parsed.expectedHead,
      repository: leasedRepository,
      issueId: parsed.issueId,
      projectRoot: root,
      gh,
    });
  } catch (err) {
    return { success: false, merged: false, decisionId: decision.decisionId, error: `Merge failed: ${err.message}` };
  }
  if (mergeResult?.merged !== true) {
    return {
      success: false,
      merged: false,
      decisionId: decision.decisionId,
      error: `Merge failed: ${mergeResult?.reason || 'provider did not confirm the merge'}`,
    };
  }

  const recordMergeDecision = deps.recordMergeDecision || defaultRecordMergeDecision;
  let terminal;
  try {
    terminal = await recordMergeDecision({
      decision,
      mergeResult,
      pr,
      expectedHead: parsed.expectedHead,
      repository: leasedRepository,
      projectRoot: root,
      buildBroker: deps.buildMergeBroker,
    });
  } catch (err) {
    return {
      success: false,
      merged: true,
      enabled: true,
      allowed: true,
      decisionId: decision.decisionId,
      error: `Merge succeeded but terminal linkage failed: ${err.message}`,
    };
  }
  if (!terminal || typeof terminal.receiptId !== 'string' || !terminal.receiptId) {
    return {
      success: false,
      merged: true,
      enabled: true,
      allowed: true,
      decisionId: decision.decisionId,
      error: 'Merge succeeded but terminal receipt evidence is unavailable.',
    };
  }

  process.stdout.write(`All ${rules.length} merge rule(s) passed — merged PR #${pr}.\n`);
  const providerFields = typeof mergeResult?.method === 'string' ? { method: mergeResult.method } : {};
  return {
    ...providerFields,
    success: true,
    merged: true,
    enabled: true,
    allowed: true,
    reason: 'all merge rules passed',
    decisionId: decision.decisionId,
    ...terminal,
  };
}

module.exports = {
  name: 'merge',
  description: 'Opt-in conditional auto-merge: merge a PR only when all user-configured rules pass (OFF by default)',
  usage: 'Usage: forge merge --auto <pr> --expect-head <40-char-sha> --issue <issue-id>',
  handler,
  // Exported seams for testing / reuse.
  defaultFetchPrContext,
  defaultMergePr,
  defaultPrepareMergeDecision,
  defaultRecordMergeDecision,
  defaultVerifyMergeGate,
  defaultVerifyPrIssueBinding,
  defaultVerifyIssueOwnership,
  evaluateProtectedRequiredChecks,
  normalizeFullHeadSha,
  normalizePrNumber,
  parseMergeArgs,
};
