'use strict';

const FINDING_FIELDS = Object.freeze([
  'caseId', 'risk', 'split', 'model', 'config', 'budget', 'trialIndex',
  'status', 'hardFailure', 'latencyMs', 'tokens', 'failures',
]);
const RISKS = new Set(['low', 'medium', 'high']);
const SPLITS = new Set(['DEV', 'TEST']);
const CONFIGS = new Set(['current', 'bounded']);
const STATUSES = new Set(['PASS', 'FAIL', 'INCOMPLETE']);
const TRIALS = new Set([0, 1, 2]);

function exactFinding(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== FINDING_FIELDS.length || !FINDING_FIELDS.every((field) => Object.hasOwn(value, field))) {
    return false;
  }
  return typeof value.caseId === 'string' && value.caseId.length > 0
    && RISKS.has(value.risk)
    && SPLITS.has(value.split)
    && typeof value.model === 'string' && value.model.length > 0
    && CONFIGS.has(value.config)
    && typeof value.budget === 'string' && value.budget.length > 0
    && TRIALS.has(value.trialIndex)
    && STATUSES.has(value.status)
    && typeof value.hardFailure === 'boolean'
    && Number.isFinite(value.latencyMs) && value.latencyMs >= 0
    && Number.isFinite(value.tokens) && value.tokens >= 0
    && Array.isArray(value.failures) && value.failures.every((failure) => typeof failure === 'string');
}

function scoreArm(finding) {
  return {
    status: finding.status,
    hardFailure: finding.hardFailure,
    latencyMs: finding.latencyMs,
    tokens: finding.tokens,
  };
}

function incomplete(reason) {
  return { ok: false, reason, pairs: [] };
}

/**
 * Validate the privacy-safe runner projection and join current/bounded arms.
 * No raw runtime output is accepted or forwarded to the pure scorecard.
 */
function loadPromotionEvidence({ tier, findings } = {}) {
  if (![30, 100, 300].includes(tier)) return incomplete('tier_invalid');
  if (!Array.isArray(findings) || findings.length === 0) return incomplete('evidence_missing');
  if (findings.some((finding) => !exactFinding(finding))) return incomplete('evidence_malformed');

  const grouped = new Map();
  for (const finding of findings) {
    const key = `${finding.caseId}\0${finding.model}\0${finding.trialIndex}`;
    let group = grouped.get(key);
    if (!group) {
      group = {
        caseId: finding.caseId,
        risk: finding.risk,
        split: finding.split,
        model: finding.model,
        budget: finding.budget,
        trialIndex: finding.trialIndex,
      };
      grouped.set(key, group);
    } else if (group.risk !== finding.risk || group.split !== finding.split || group.budget !== finding.budget) {
      return incomplete('case_metadata_mismatch');
    }
    if (Object.hasOwn(group, finding.config)) return incomplete('duplicate_arm_evidence');
    group[finding.config] = scoreArm(finding);
  }

  const pairs = [];
  for (const group of grouped.values()) {
    if (!group.current || !group.bounded) return incomplete('paired_arm_incomplete');
    pairs.push({
      caseId: group.caseId,
      risk: group.risk,
      split: group.split,
      model: group.model,
      trialIndex: group.trialIndex,
      current: group.current,
      bounded: group.bounded,
    });
  }
  pairs.sort((left, right) => left.caseId.localeCompare(right.caseId)
    || left.model.localeCompare(right.model) || left.trialIndex - right.trialIndex);
  return { ok: true, pairs };
}

module.exports = { loadPromotionEvidence };
