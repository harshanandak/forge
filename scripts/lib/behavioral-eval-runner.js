'use strict';

const { loadTier, evaluateCase } = require('./immutable-eval-corpus');
const { createEvalEvidence, appendEvalEvidence } = require('./eval-evidence');

const RESULT_FIELDS = Object.freeze(['evidence', 'attribution']);
const ATTRIBUTION_FIELDS = Object.freeze([
  'model', 'effort', 'role', 'hashes', 'startedAt', 'endedAt', 'activeMs',
  'passiveMs', 'tokens', 'retries', 'compactions',
]);
const ATTRIBUTION_HASH_FIELDS = Object.freeze(['prompt', 'skill', 'tool']);
const BINDING_FIELDS = Object.freeze(['repoSha', 'configHash', 'budgetHash']);
const ARM_FIELDS = Object.freeze(['id', 'model', 'config', 'budget']);
const STRUCTURAL_FAILURE_PREFIXES = Object.freeze([
  'evidence.', 'binding.', 'case_id.', 'packet.', 'split.', 'trial.', 'metrics.',
  'manifest.', 'observation.',
]);
const SAFE_RUNTIME_FAILURES = new Set([
  'runtime.execution_failed', 'runtime.token_budget_exceeded', 'runtime.usage_unparseable',
]);

function hasExactFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function validExecutorResult(result) {
  return hasExactFields(result, RESULT_FIELDS) &&
    hasExactFields(result.attribution, ATTRIBUTION_FIELDS) &&
    hasExactFields(result.attribution.hashes, ATTRIBUTION_HASH_FIELDS);
}

function isStructuralFailure(failure) {
  return STRUCTURAL_FAILURE_PREFIXES.some((prefix) => failure.startsWith(prefix));
}

function snapshotBinding(binding) {
  if (!hasExactFields(binding, BINDING_FIELDS)) return null;
  if (!/^[0-9a-f]{40}$/.test(binding.repoSha)) return null;
  if (!/^[0-9a-f]{64}$/.test(binding.configHash)) return null;
  if (!/^[0-9a-f]{64}$/.test(binding.budgetHash)) return null;
  return Object.freeze({
    repoSha: binding.repoSha,
    configHash: binding.configHash,
    budgetHash: binding.budgetHash,
  });
}

function snapshotArms(arms) {
  if (!Array.isArray(arms) || arms.length !== 4) return null;
  const snapshots = [];
  for (const arm of arms) {
    if (!hasExactFields(arm, ARM_FIELDS)) return null;
    if ([arm.id, arm.model, arm.config, arm.budget]
      .some((value) => typeof value !== 'string' || value.length === 0)) return null;
    if (!['current', 'bounded'].includes(arm.config)) return null;
    snapshots.push(Object.freeze({ ...arm }));
  }
  if (new Set(snapshots.map((arm) => arm.id)).size !== 4) return null;
  if (new Set(snapshots.map((arm) => arm.model)).size !== 2) return null;
  const matrix = new Set(snapshots.map((arm) => `${arm.model}\0${arm.config}`));
  if (matrix.size !== 4) return null;
  return Object.freeze(snapshots);
}

function explicitHardFailure(evaluation, result) {
  return result.evidence?.observation?.hardFailure === true
    || evaluation.hardFailure === true;
}

function buildEnvelope(input, identity, binding, evaluation, result, hardFailure) {
  const attribution = result.attribution;
  return createEvalEvidence({
    issue_id: input.issueId,
    pr: input.pr,
    head_sha: binding.repoSha,
    model: attribution.model,
    effort: attribution.effort,
    role: attribution.role,
    hashes: {
      eval_set: result.evidence.packetHash,
      prompt: attribution.hashes.prompt,
      skill: attribution.hashes.skill,
      tool: attribution.hashes.tool,
    },
    started_at: attribution.startedAt,
    ended_at: attribution.endedAt,
    active_ms: attribution.activeMs,
    passive_ms: attribution.passiveMs,
    tokens: {
      input: attribution.tokens.input,
      output: attribution.tokens.output,
      cached: attribution.tokens.cached,
    },
    retries: attribution.retries,
    compactions: attribution.compactions,
    gates: [{ name: 'behavioral-case', passed: evaluation.passed }],
    run_identity: {
      arm_id: identity.armId,
      case_id: identity.caseId,
      risk: identity.risk,
      split: identity.split,
      model: identity.model,
      config: identity.config,
      budget: identity.budget,
      tier: input.tier,
      trial_index: identity.trialIndex,
      config_hash: binding.configHash,
      budget_hash: binding.budgetHash,
    },
    case_result: {
      status: evaluation.passed ? 'PASS' : 'FAIL',
      hard_failure: hardFailure,
      latency_ms: result.evidence.metrics.durationMs,
      tokens: result.evidence.metrics.tokensUsed,
    },
  });
}

function finding(identity, status, failures, evidence, hardFailure = false) {
  return {
    caseId: identity.caseId,
    risk: identity.risk,
    split: identity.split,
    model: identity.model,
    config: identity.config,
    budget: identity.budget,
    trialIndex: identity.trialIndex,
    status,
    hardFailure,
    latencyMs: Number.isFinite(evidence?.metrics?.durationMs) ? evidence.metrics.durationMs : 0,
    tokens: Number.isFinite(evidence?.metrics?.tokensUsed) ? evidence.metrics.tokensUsed : 0,
    failures,
  };
}

function incompleteResult(tier, arms, expectedRuns, reason) {
  return {
    status: 'INCOMPLETE',
    tier,
    arms,
    expectedRuns,
    completedRuns: 0,
    passedRuns: 0,
    failedRuns: 0,
    incompleteRuns: expectedRuns,
    findings: [{ status: 'INCOMPLETE', failures: [reason] }],
  };
}

function identityFor(packet, trialIndex, arm) {
  return {
    armId: arm.id,
    caseId: packet.caseId,
    risk: packet.risk,
    split: packet.split,
    model: arm.model,
    config: arm.config,
    budget: arm.budget,
    trialIndex,
  };
}

async function invokeExecutor(input, packet, trialIndex, arm, binding) {
  try {
    return await input.executor(Object.freeze({
      armId: arm.id,
      model: arm.model,
      config: arm.config,
      budget: arm.budget,
      packet,
      trialIndex,
      binding,
      skillName: input.skillName,
    }));
  } catch (error) {
    const failure = error?.message;
    return SAFE_RUNTIME_FAILURES.has(failure) ? { runtimeFailure: failure } : null;
  }
}

async function persistEvidence(input, append, identity, binding, evaluation, result, hardFailure) {
  try {
    const envelope = buildEnvelope(input, identity, binding, evaluation, result, hardFailure);
    const appended = await append(input.projectRoot, envelope, input.appendOptions || {});
    if (appended?.conflict) return 'evidence.conflict';
    if (!appended || appended.ok !== true) return 'evidence.append_failed';
    return null;
  } catch {
    return 'evidence.append_failed';
  }
}

async function executeArm({ input, corpus, packet, trialIndex, arm, binding, append }) {
  const identity = identityFor(packet, trialIndex, arm);
  const result = await invokeExecutor(input, packet, trialIndex, arm, binding);
  if (result?.runtimeFailure) {
    return {
      status: 'INCOMPLETE',
      finding: finding(identity, 'INCOMPLETE', [result.runtimeFailure]),
    };
  }
  if (!validExecutorResult(result)) {
    return { status: 'INCOMPLETE', finding: finding(identity, 'INCOMPLETE', ['evidence.malformed']) };
  }
  if (result.attribution.model !== arm.model) {
    return {
      status: 'INCOMPLETE',
      finding: finding(identity, 'INCOMPLETE', ['attribution.model_mismatch'], result.evidence),
    };
  }

  const evaluation = evaluateCase({
    packet,
    allPackets: corpus.allPackets,
    manifest: corpus.manifest,
    evidence: result.evidence,
    expectedBinding: binding,
  });
  const hardFailure = explicitHardFailure(evaluation, result);
  if (evaluation.failures.some(isStructuralFailure)) {
    return {
      status: 'INCOMPLETE',
      finding: finding(identity, 'INCOMPLETE', evaluation.failures, result.evidence, hardFailure),
    };
  }

  const persistenceFailure = await persistEvidence(
    input, append, identity, binding, evaluation, result, hardFailure,
  );
  if (persistenceFailure) {
    return {
      status: 'INCOMPLETE',
      finding: finding(identity, 'INCOMPLETE', [persistenceFailure], result.evidence, hardFailure),
    };
  }
  const status = evaluation.passed ? 'PASS' : 'FAIL';
  return {
    status,
    finding: finding(
      identity, status, evaluation.passed ? [] : evaluation.failures, result.evidence, hardFailure,
    ),
  };
}

function recordOutcome(counts, outcome, findings) {
  findings.push(outcome.finding);
  if (outcome.status === 'INCOMPLETE') {
    counts.incompleteRuns += 1;
    return;
  }
  counts.completedRuns += 1;
  if (outcome.status === 'PASS') counts.passedRuns += 1;
  else counts.failedRuns += 1;
}

function finalStatus(counts, expectedRuns) {
  if (counts.incompleteRuns > 0 || counts.completedRuns !== expectedRuns) return 'INCOMPLETE';
  return counts.failedRuns > 0 ? 'FAIL' : 'PASS';
}

/**
 * Execute the frozen corpus through four opaque, matched executor arms.
 * The executor may observe arm ids and immutable packets, but it receives no
 * merge capability. Only a strict, privacy-safe attribution envelope persists.
 */
async function runBehavioralEvaluation(input) {
  let corpus;
  try {
    corpus = loadTier(input.tier);
  } catch (error) {
    return incompleteResult(input.tier, input.arms || [], 0, error.message);
  }

  const suppliedArms = Array.isArray(input.arms) ? input.arms : [];
  const trialIndices = corpus.manifest.trialIndices;
  const expectedRuns = corpus.cases.length * trialIndices.length * 4;
  const arms = snapshotArms(suppliedArms);
  if (!arms) return incompleteResult(input.tier, suppliedArms, expectedRuns, 'arms.invalid');
  if (typeof input.executor !== 'function') {
    return incompleteResult(input.tier, arms, expectedRuns, 'executor.missing');
  }
  const binding = snapshotBinding(input.binding);
  if (!binding) return incompleteResult(input.tier, arms, expectedRuns, 'binding.invalid');

  const append = input.appendEvidence || appendEvalEvidence;
  const findings = [];
  const counts = { completedRuns: 0, passedRuns: 0, failedRuns: 0, incompleteRuns: 0 };

  for (const packet of corpus.cases) {
    for (const trialIndex of trialIndices) {
      for (const arm of arms) {
        const outcome = await executeArm({ input, corpus, packet, trialIndex, arm, binding, append });
        recordOutcome(counts, outcome, findings);
      }
    }
  }

  return {
    status: finalStatus(counts, expectedRuns),
    tier: input.tier,
    arms,
    expectedRuns,
    ...counts,
    findings,
  };
}

module.exports = { runBehavioralEvaluation };
