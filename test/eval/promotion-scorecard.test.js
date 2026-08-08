'use strict';

const { describe, expect, test } = require('bun:test');

const {
  BOOTSTRAP_SAMPLES,
  scorePromotion,
  wilsonInterval,
} = require('../../scripts/lib/promotion-scorecard');

const MODELS = ['sol', 'luna'];
const TRIALS = [0, 1, 2];

function arm(status, latencyMs, tokens, hardFailure = false) {
  return { status, hardFailure, latencyMs, tokens };
}

function completePairs(tier, options = {}) {
  const pairs = [];
  const devCount = tier * 0.6;
  for (let index = 0; index < tier; index += 1) {
    const split = index < devCount ? 'DEV' : 'TEST';
    const risk = ['low', 'medium', 'high'][index % 3];
    for (const model of MODELS) {
      for (const trialIndex of TRIALS) {
        const currentStatus = split === 'TEST' && (index - devCount) % 5 === 0 ? 'FAIL' : 'PASS';
        pairs.push({
          caseId: `case-${String(index + 1).padStart(3, '0')}`,
          risk,
          split,
          model,
          trialIndex,
          current: arm(currentStatus, 100, 100),
          bounded: arm('PASS', options.boundedLatency ?? 110, options.boundedTokens ?? 110),
        });
      }
    }
  }
  return pairs;
}

describe('promotion scorecard', () => {
  test('computes Wilson absolute intervals', () => {
    expect(wilsonInterval(50, 100)).toEqual({
      lower: expect.closeTo(0.4038315304, 9),
      upper: expect.closeTo(0.5961684696, 9),
    });
    expect(wilsonInterval(0, 0)).toBeNull();
  });

  test('keeps the 30-case tier instrumentation-only even with complete winning evidence', () => {
    const score = scorePromotion({ tier: 30, pairs: completePairs(30) });
    expect(score).toMatchObject({
      status: 'INCOMPLETE',
      winner: null,
      phase: 'instrumentation',
      mergeAuthorized: false,
      reasons: ['instrumentation_only'],
    });
    expect(score.bootstrap.samples).toBe(BOOTSTRAP_SAMPLES);
  });

  test('passes the 100-case decision gate only when every preregistered threshold passes', () => {
    const score = scorePromotion({ tier: 100, pairs: completePairs(100) });
    expect(score.status).toBe('PASS');
    expect(score.winner).toBe('bounded');
    expect(score.phase).toBe('decision');
    expect(score.mergeAuthorized).toBe(false);
    expect(score.absolute.pooled.current.interval.lower).toBeGreaterThan(0);
    expect(score.absolute.pooled.bounded.interval.upper).toBeLessThanOrEqual(1);
    expect(score.bootstrap).toMatchObject({ samples: 10000, delta: 0.2 });
    expect(score.bootstrap.interval.lower).toBeGreaterThan(0);
    expect(score.thresholds).toEqual(expect.objectContaining({
      zeroHardFailures: true,
      highRiskTestPass: true,
      pooledDelta: true,
      perModelDelta: true,
      highRiskRegression: true,
      latency: true,
      tokens: true,
    }));
  });

  test('is deterministic and case-clustered regardless of input order', () => {
    const pairs = completePairs(100);
    const forward = scorePromotion({ tier: 100, pairs });
    const reverse = scorePromotion({ tier: 100, pairs: [...pairs].reverse() });
    expect(reverse.bootstrap).toEqual(forward.bootstrap);
  });

  test('fails closed on incomplete or malformed paired evidence', () => {
    const incomplete = completePairs(100);
    incomplete[0].bounded.status = 'INCOMPLETE';
    expect(scorePromotion({ tier: 100, pairs: incomplete })).toMatchObject({
      status: 'INCOMPLETE', winner: null, reasons: ['evidence_incomplete'],
    });

    const missingPair = completePairs(100);
    missingPair.pop();
    expect(scorePromotion({ tier: 100, pairs: missingPair })).toMatchObject({
      status: 'INCOMPLETE', winner: null,
    });
  });

  test.each([30, 100, 300])('requires the frozen 60/40 unique-case split at tier %i', (tier) => {
    const wrongSplit = completePairs(tier);
    for (const pair of wrongSplit) {
      const caseNumber = Number.parseInt(pair.caseId.slice('case-'.length), 10);
      if (pair.split === 'TEST' && caseNumber <= tier - 3) pair.split = 'DEV';
    }
    expect(scorePromotion({ tier, pairs: wrongSplit })).toMatchObject({
      status: 'INCOMPLETE', winner: null, reasons: ['split_count_incomplete'],
    });
  });

  test('applies hard-failure and high-risk TEST vetoes', () => {
    const hardFailure = completePairs(100);
    hardFailure[0].bounded.hardFailure = true;
    expect(scorePromotion({ tier: 100, pairs: hardFailure })).toMatchObject({
      status: 'FAIL', winner: null,
    });
    expect(scorePromotion({ tier: 100, pairs: hardFailure }).reasons).toContain('hard_failure');

    const unsafe = completePairs(100);
    const highRiskTest = unsafe.find((pair) => pair.split === 'TEST' && pair.risk === 'high');
    highRiskTest.bounded.status = 'FAIL';
    expect(scorePromotion({ tier: 100, pairs: unsafe }).reasons).toContain('high_risk_test_pass');
  });

  test('requires pooled effect, positive confidence bound, and nonnegative per-model effects', () => {
    const noEffect = completePairs(100);
    for (const pair of noEffect) pair.bounded.status = pair.current.status;
    const noEffectScore = scorePromotion({ tier: 100, pairs: noEffect });
    expect(noEffectScore.status).toBe('FAIL');
    expect(noEffectScore.reasons).toContain('pooled_delta');

    const modelRegression = completePairs(100);
    for (const pair of modelRegression) {
      if (pair.split === 'TEST' && pair.model === 'luna' && pair.risk !== 'high') {
        pair.current.status = 'PASS';
        pair.bounded.status = 'FAIL';
      }
    }
    expect(scorePromotion({ tier: 100, pairs: modelRegression }).reasons).toContain('per_model_delta');
  });

  test('vetoes high-risk regression and operational cap breaches', () => {
    const highRiskRegression = completePairs(100);
    const highRiskCaseIds = [...new Set(highRiskRegression
      .filter((pair) => pair.risk === 'high' && pair.split === 'DEV')
      .map((pair) => pair.caseId))];
    const regressedCases = new Set(highRiskCaseIds.slice(0, 5));
    for (const pair of highRiskRegression) {
      if (regressedCases.has(pair.caseId)) pair.bounded.status = 'FAIL';
    }
    expect(scorePromotion({ tier: 100, pairs: highRiskRegression }).reasons).toContain('high_risk_regression');

    expect(scorePromotion({
      tier: 100,
      pairs: completePairs(100, { boundedLatency: 126 }),
    }).reasons).toContain('latency_cap');

    expect(scorePromotion({
      tier: 100,
      pairs: completePairs(100, { boundedTokens: 121 }),
    }).reasons).toContain('token_cap');
  });

  test('never permits an exception to the token cap', () => {
    const pairs = completePairs(100, { boundedTokens: 121 });
    const score = scorePromotion({
      tier: 100,
      pairs,
      tokenCapException: { preregistered: true, reason: 'approved long-context arm' },
    });
    expect(score).toMatchObject({ status: 'FAIL', winner: null });
    expect(score.reasons).toContain('token_cap');
  });

  test('uses the 300-case tier only as confirmation and never grants merge authority', () => {
    expect(scorePromotion({ tier: 300, pairs: completePairs(300) })).toMatchObject({
      status: 'PASS', winner: 'bounded', phase: 'confirmation', mergeAuthorized: false,
    });
  });
});
