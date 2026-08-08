'use strict';

const { describe, expect, test } = require('bun:test');

const { loadPromotionEvidence } = require('../../scripts/lib/promotion-evidence-loader');

function finding(caseId, model, config, trialIndex, overrides = {}) {
  return {
    caseId,
    risk: 'low',
    split: 'DEV',
    model,
    config,
    budget: 'tier-30',
    trialIndex,
    status: 'PASS',
    hardFailure: false,
    latencyMs: 100,
    tokens: 10,
    failures: [],
    ...overrides,
  };
}

describe('promotion evidence loader', () => {
  test('joins four opaque arms into current/bounded scorecard pairs', () => {
    const findings = [];
    for (const model of ['model-one', 'model-two']) {
      for (const config of ['current', 'bounded']) {
        for (const trialIndex of [0, 1, 2]) {
          findings.push(finding('case-001', model, config, trialIndex));
        }
      }
    }

    const loaded = loadPromotionEvidence({ tier: 30, findings });
    expect(loaded.ok).toBe(true);
    expect(loaded.pairs).toHaveLength(6);
    expect(loaded.pairs[0]).toEqual({
      caseId: 'case-001',
      risk: 'low',
      split: 'DEV',
      model: 'model-one',
      trialIndex: 0,
      current: { status: 'PASS', hardFailure: false, latencyMs: 100, tokens: 10 },
      bounded: { status: 'PASS', hardFailure: false, latencyMs: 100, tokens: 10 },
    });
  });

  test('fails closed on duplicate, missing, or cross-arm metadata evidence', () => {
    const base = [
      finding('case-001', 'model-one', 'current', 0),
      finding('case-001', 'model-one', 'bounded', 0),
    ];
    expect(loadPromotionEvidence({ tier: 30, findings: [...base, base[0]] })).toMatchObject({
      ok: false, reason: 'duplicate_arm_evidence',
    });
    expect(loadPromotionEvidence({ tier: 30, findings: base.slice(0, 1) })).toMatchObject({
      ok: false, reason: 'paired_arm_incomplete',
    });
    expect(loadPromotionEvidence({
      tier: 30,
      findings: [base[0], { ...base[1], risk: 'high' }],
    })).toMatchObject({ ok: false, reason: 'case_metadata_mismatch' });
  });

  test('rejects extra fields so private runtime material cannot reach the scorecard', () => {
    const unsafe = finding('case-001', 'model-one', 'current', 0);
    unsafe.transcript = 'private';
    expect(loadPromotionEvidence({ tier: 30, findings: [unsafe] })).toMatchObject({
      ok: false, reason: 'evidence_malformed',
    });
  });
});
