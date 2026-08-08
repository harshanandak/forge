'use strict';

const BOOTSTRAP_SAMPLES = 10000;
const Z_95 = 1.959963984540054;
const RISKS = Object.freeze(['low', 'medium', 'high']);
const STATUSES = new Set(['PASS', 'FAIL', 'INCOMPLETE']);
const TRIALS = Object.freeze([0, 1, 2]);
const TIER_PHASES = Object.freeze({ 30: 'instrumentation', 100: 'decision', 300: 'confirmation' });

function round(value) {
  return Number(value.toFixed(12));
}

function wilsonInterval(successes, total) {
  if (total === 0) return null;
  if (!Number.isInteger(successes) || !Number.isInteger(total)
    || successes < 0 || total < 0 || successes > total) {
    throw new Error('Wilson counts must be valid non-negative integers');
  }
  const rate = successes / total;
  const zSquared = Z_95 ** 2;
  const denominator = 1 + zSquared / total;
  const center = (rate + zSquared / (2 * total)) / denominator;
  const margin = Z_95 * Math.sqrt(
    (rate * (1 - rate) + zSquared / (4 * total)) / total
  ) / denominator;
  return { lower: round(center - margin), upper: round(center + margin) };
}

function isValidArm(value) {
  return value && typeof value === 'object'
    && STATUSES.has(value.status)
    && typeof value.hardFailure === 'boolean'
    && Number.isFinite(value.latencyMs) && value.latencyMs >= 0
    && Number.isFinite(value.tokens) && value.tokens >= 0;
}

function isValidPair(pair) {
  return pair && typeof pair === 'object'
    && typeof pair.caseId === 'string' && pair.caseId.length > 0
    && RISKS.includes(pair.risk)
    && ['DEV', 'TEST'].includes(pair.split)
    && typeof pair.model === 'string' && pair.model.length > 0
    && TRIALS.includes(pair.trialIndex)
    && isValidArm(pair.current)
    && isValidArm(pair.bounded);
}

function evidenceShapeError(tier, pairs) {
  if (!Object.hasOwn(TIER_PHASES, tier)) return { error: 'tier_invalid' };
  if (!Array.isArray(pairs) || pairs.length === 0) return { error: 'evidence_missing' };
  if (pairs.some((pair) => !isValidPair(pair))) return { error: 'evidence_malformed' };
  if (pairs.some((pair) => pair.current.status === 'INCOMPLETE' || pair.bounded.status === 'INCOMPLETE')) {
    return { error: 'evidence_incomplete' };
  }
  return null;
}

function collectMatrix(pairs) {
  const models = [...new Set(pairs.map((pair) => pair.model))].sort();
  const cases = new Map();
  const seen = new Set();
  for (const pair of pairs) {
    const key = `${pair.caseId}\0${pair.model}\0${pair.trialIndex}`;
    if (seen.has(key)) return { error: 'duplicate_pair' };
    seen.add(key);
    const existing = cases.get(pair.caseId);
    if (existing && (existing.risk !== pair.risk || existing.split !== pair.split)) {
      return { error: 'case_metadata_mismatch' };
    }
    cases.set(pair.caseId, { risk: pair.risk, split: pair.split });
  }
  return { models, cases, seen };
}

function pairingError(tier, models, cases, seen) {
  if (models.length !== 2) return 'model_pair_incomplete';
  if (cases.size !== tier) return 'case_count_incomplete';

  for (const caseId of cases.keys()) {
    for (const model of models) {
      for (const trial of TRIALS) {
        if (!seen.has(`${caseId}\0${model}\0${trial}`)) return 'pairing_incomplete';
      }
    }
  }
  return null;
}

function validatePairs(tier, pairs) {
  const shapeError = evidenceShapeError(tier, pairs);
  if (shapeError) return shapeError;
  const matrix = collectMatrix(pairs);
  if (matrix.error) return matrix;
  const incompletePairing = pairingError(tier, matrix.models, matrix.cases, matrix.seen);
  if (incompletePairing) return { error: incompletePairing };
  const testRisks = new Set(pairs.filter((pair) => pair.split === 'TEST').map((pair) => pair.risk));
  if (RISKS.some((risk) => !testRisks.has(risk))) return { error: 'risk_stratum_incomplete' };
  return { models: matrix.models };
}

function passStats(pairs, armName) {
  const passes = pairs.filter((pair) => pair[armName].status === 'PASS').length;
  const total = pairs.length;
  return {
    passes,
    total,
    rate: round(passes / total),
    interval: wilsonInterval(passes, total),
  };
}

function absoluteStats(testPairs, models) {
  const byModel = {};
  for (const model of models) {
    const modelPairs = testPairs.filter((pair) => pair.model === model);
    byModel[model] = {
      current: passStats(modelPairs, 'current'),
      bounded: passStats(modelPairs, 'bounded'),
    };
  }
  return {
    pooled: {
      current: passStats(testPairs, 'current'),
      bounded: passStats(testPairs, 'bounded'),
    },
    byModel,
  };
}

function createPrng() {
  let state = 0x5eed1234;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function riskClusters(testPairs) {
  const strata = Object.fromEntries(RISKS.map((risk) => [risk, new Map()]));
  for (const pair of testPairs) {
    const clusters = strata[pair.risk];
    if (!clusters.has(pair.caseId)) clusters.set(pair.caseId, []);
    clusters.get(pair.caseId).push(pair);
  }
  return RISKS.map((risk) => (
    [...strata[risk].entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, rows]) => rows)
  ));
}

function pairedDelta(pairs) {
  const difference = pairs.reduce((sum, pair) => (
    sum + Number(pair.bounded.status === 'PASS') - Number(pair.current.status === 'PASS')
  ), 0);
  return round(difference / pairs.length);
}

function quantile(sorted, probability) {
  const position = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const weight = position - lowerIndex;
  const lower = sorted[lowerIndex];
  const upper = sorted[Math.min(lowerIndex + 1, sorted.length - 1)];
  return round(lower + (upper - lower) * weight);
}

function pairedBootstrap(testPairs) {
  const strata = riskClusters(testPairs);
  const random = createPrng();
  const deltas = [];
  for (let sample = 0; sample < BOOTSTRAP_SAMPLES; sample += 1) {
    const sampled = [];
    for (const clusters of strata) {
      for (let index = 0; index < clusters.length; index += 1) {
        sampled.push(...clusters[Math.floor(random() * clusters.length)]);
      }
    }
    deltas.push(pairedDelta(sampled));
  }
  deltas.sort((left, right) => left - right);
  return {
    samples: BOOTSTRAP_SAMPLES,
    delta: pairedDelta(testPairs),
    interval: { lower: quantile(deltas, 0.025), upper: quantile(deltas, 0.975) },
  };
}

function percentile(values, probability) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(probability * sorted.length) - 1];
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function safeRatio(numerator, denominator) {
  if (denominator === 0) return numerator === 0 ? 1 : Number.POSITIVE_INFINITY;
  return round(numerator / denominator);
}

function operationalRatios(testPairs) {
  const currentLatency = testPairs.map((pair) => pair.current.latencyMs);
  const boundedLatency = testPairs.map((pair) => pair.bounded.latencyMs);
  const currentTokens = testPairs.map((pair) => pair.current.tokens);
  const boundedTokens = testPairs.map((pair) => pair.bounded.tokens);
  return {
    latencyP95: safeRatio(percentile(boundedLatency, 0.95), percentile(currentLatency, 0.95)),
    tokenMedian: safeRatio(median(boundedTokens), median(currentTokens)),
  };
}

function casePassRate(pairs, armName) {
  const cases = new Map();
  for (const pair of pairs) {
    const passed = pair[armName].status === 'PASS';
    cases.set(pair.caseId, (cases.get(pair.caseId) ?? true) && passed);
  }
  return [...cases.values()].filter(Boolean).length / cases.size;
}

function hasTokenException(exception) {
  return exception?.preregistered === true
    && typeof exception.reason === 'string'
    && exception.reason.trim().length > 0;
}

function evaluateThresholds({ pairs, testPairs, models, absolute, bootstrap, operations, tokenCapException }) {
  const perModelDelta = models.every((model) => {
    const stats = absolute.byModel[model];
    return stats.bounded.rate - stats.current.rate >= 0;
  });
  const highRisk = pairs.filter((pair) => pair.risk === 'high');
  const highRiskDelta = casePassRate(highRisk, 'bounded') - casePassRate(highRisk, 'current');
  return {
    zeroHardFailures: pairs.every((pair) => !pair.current.hardFailure && !pair.bounded.hardFailure),
    highRiskTestPass: testPairs
      .filter((pair) => pair.risk === 'high')
      .every((pair) => pair.bounded.status === 'PASS'),
    pooledDelta: bootstrap.delta >= 0.05 && bootstrap.interval.lower > 0,
    perModelDelta,
    highRiskRegression: highRiskDelta >= -0.02,
    latency: operations.latencyP95 <= 1.25,
    tokens: operations.tokenMedian <= 1.20 || hasTokenException(tokenCapException),
  };
}

function thresholdReasons(thresholds) {
  const reasonByThreshold = {
    zeroHardFailures: 'hard_failure',
    highRiskTestPass: 'high_risk_test_pass',
    pooledDelta: 'pooled_delta',
    perModelDelta: 'per_model_delta',
    highRiskRegression: 'high_risk_regression',
    latency: 'latency_cap',
    tokens: 'token_cap',
  };
  return Object.entries(reasonByThreshold)
    .filter(([threshold]) => !thresholds[threshold])
    .map(([, reason]) => reason);
}

function incomplete(tier, reason) {
  return {
    status: 'INCOMPLETE',
    winner: null,
    phase: TIER_PHASES[tier] ?? null,
    mergeAuthorized: false,
    reasons: [reason],
  };
}

function scorePromotion({ tier, pairs, tokenCapException } = {}) {
  const validation = validatePairs(tier, pairs);
  if (validation.error) return incomplete(tier, validation.error);

  const testPairs = pairs.filter((pair) => pair.split === 'TEST');
  const absolute = absoluteStats(testPairs, validation.models);
  const bootstrap = pairedBootstrap(testPairs);
  const operations = operationalRatios(testPairs);
  const thresholds = evaluateThresholds({
    pairs,
    testPairs,
    models: validation.models,
    absolute,
    bootstrap,
    operations,
    tokenCapException,
  });
  if (tier === 30) {
    return {
      status: 'INCOMPLETE', winner: null, phase: TIER_PHASES[tier], mergeAuthorized: false,
      reasons: ['instrumentation_only'], absolute, bootstrap, operations, thresholds,
    };
  }
  const reasons = thresholdReasons(thresholds);
  return {
    status: reasons.length === 0 ? 'PASS' : 'FAIL',
    winner: reasons.length === 0 ? 'bounded' : null,
    phase: TIER_PHASES[tier],
    mergeAuthorized: false,
    reasons,
    absolute,
    bootstrap,
    operations,
    thresholds,
  };
}

module.exports = {
  BOOTSTRAP_SAMPLES,
  scorePromotion,
  wilsonInterval,
};
