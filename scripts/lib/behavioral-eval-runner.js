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
const STRUCTURAL_FAILURE_PREFIXES = Object.freeze([
  'evidence.', 'binding.', 'case_id.', 'packet.', 'split.', 'trial.', 'metrics.',
  'manifest.', 'observation.',
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

function buildEnvelope(input, identity, binding, evaluation, result) {
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
      trial_index: identity.trialIndex,
    },
  });
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

/**
 * Execute the frozen corpus through two opaque, matched executor arms.
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

  const arms = Array.isArray(input.arms) ? [...input.arms] : [];
  const trialIndices = corpus.manifest.trialIndices;
  const expectedRuns = corpus.cases.length * trialIndices.length * 2;
  const validArms = arms.length === 2 && new Set(arms).size === 2 &&
    arms.every((arm) => typeof arm === 'string' && arm.length > 0);
  if (!validArms) return incompleteResult(input.tier, arms, expectedRuns, 'arms.invalid');
  if (typeof input.executor !== 'function') {
    return incompleteResult(input.tier, arms, expectedRuns, 'executor.missing');
  }
  const binding = snapshotBinding(input.binding);
  if (!binding) return incompleteResult(input.tier, arms, expectedRuns, 'binding.invalid');

  const append = input.appendEvidence || appendEvalEvidence;
  const findings = [];
  let completedRuns = 0;
  let passedRuns = 0;
  let failedRuns = 0;
  let incompleteRuns = 0;

  for (const packet of corpus.cases) {
    for (const trialIndex of trialIndices) {
      for (const armId of arms) {
        const identity = { armId, caseId: packet.caseId, trialIndex };
        let result;
        try {
          result = await input.executor(Object.freeze({
            armId,
            packet,
            trialIndex,
            binding,
            skillName: input.skillName,
          }));
        } catch (_error) {
          result = null;
        }

        if (!validExecutorResult(result)) {
          incompleteRuns += 1;
          findings.push({ ...identity, status: 'INCOMPLETE', failures: ['evidence.malformed'] });
          continue;
        }

        const evaluation = evaluateCase({
          packet,
          allPackets: corpus.allPackets,
          manifest: corpus.manifest,
          evidence: result.evidence,
          expectedBinding: binding,
        });
        if (evaluation.failures.some(isStructuralFailure)) {
          incompleteRuns += 1;
          findings.push({ ...identity, status: 'INCOMPLETE', failures: evaluation.failures });
          continue;
        }

        let envelope;
        try {
          envelope = buildEnvelope(input, identity, binding, evaluation, result);
          const appended = await append(input.projectRoot, envelope, input.appendOptions || {});
          if (!appended || appended.ok !== true) throw new Error('evidence.append_failed');
        } catch (_error) {
          incompleteRuns += 1;
          findings.push({ ...identity, status: 'INCOMPLETE', failures: ['evidence.append_failed'] });
          continue;
        }

        completedRuns += 1;
        if (evaluation.passed) {
          passedRuns += 1;
          findings.push({ ...identity, status: 'PASS', failures: [] });
        } else {
          failedRuns += 1;
          findings.push({ ...identity, status: 'FAIL', failures: evaluation.failures });
        }
      }
    }
  }

  const status = incompleteRuns > 0 || completedRuns !== expectedRuns
    ? 'INCOMPLETE'
    : failedRuns > 0 ? 'FAIL' : 'PASS';
  return {
    status,
    tier: input.tier,
    arms,
    expectedRuns,
    completedRuns,
    passedRuns,
    failedRuns,
    incompleteRuns,
    findings,
  };
}

module.exports = { runBehavioralEvaluation };
