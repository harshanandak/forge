'use strict';

const { describe, expect, mock, test } = require('bun:test');
const contracts = require('../../memory-contracts');
mock.module('@forge/memory-contracts', () => contracts);
const {
  FeedbackIntakeError,
  createFeedbackIntake,
  createFeedbackReport,
} = require('..');
const { classifySemanticAttempt, computeContentHash, validateContractStructure } = contracts;

const IDS = [
  '00000000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000102',
];

function report(overrides = {}, id = IDS[0]) {
  return createFeedbackReport({
    productVersion: '0.1.0-beta.7',
    instanceId: 'local-test',
    stableErrorCode: 'FORGE_TEST_FAILED',
    affectedCapability: 'memory.recall',
    reproductionSteps: ['Run C:\\Users\\alice\\forge with token=ghp_123456789012345678901234567890'],
    expectedClassification: 'PASS',
    actualClassification: 'FAIL',
    occurrenceCount: 2,
    consentEventId: 'consent-101',
    redactionPolicyRevision: 'redaction-1',
    rawPrompt: 'must never enter the report',
    userId: 'must-never-enter-the-report',
    ...overrides,
  }, {
    randomUUID: () => id,
    now: () => '2026-08-10T05:00:00.000Z',
  });
}

function consentFor(value) {
  return {
    approved: true,
    eventId: value.payload.consent_event_id,
    redactionPolicyRevision: value.payload.redaction_policy_revision,
    reportId: value.payload.report_id,
    contentHash: value.content_hash,
  };
}

function atomicFeedbackStore() {
  const accepted = new Map();
  const calls = [];
  return {
    calls,
    async acceptFeedback(attempt) {
      calls.push(attempt);
      const prior = accepted.get(attempt.identity);
      if (!prior) {
        accepted.set(attempt.identity, attempt.report);
        return { status: 'accepted', receipt: { event_id: `feedback:${attempt.identity}` } };
      }
      const classification = classifySemanticAttempt(prior, attempt.report);
      if (classification.status === 'retry-identical') {
        return { status: 'retry-identical', receipt: { event_id: `feedback:${attempt.identity}` } };
      }
      return { status: 'identity-conflict' };
    },
  };
}

describe('structured feedback intake', () => {
  test('constructs a bounded anonymous report and deterministically redacts secrets and user paths', () => {
    const value = report();

    expect(validateContractStructure(value)).toEqual({ ok: true, errors: [] });
    expect(value.provenance).toEqual({
      source_kind: 'feedback',
      actor_class: 'anonymous-user',
      actor_id: IDS[0],
    });
    expect(value.payload.redacted_reproduction_steps).toEqual([
      'Run <user-path>/forge with [REDACTED]',
    ]);
    expect(JSON.stringify(value)).not.toContain('alice');
    expect(JSON.stringify(value)).not.toContain('rawPrompt');
    expect(JSON.stringify(value)).not.toContain('userId');
  });

  test('redacts privacy-sensitive content from every caller-controlled string field', () => {
    const value = report({
      stableErrorCode: 'token=ghp_123456789012345678901234567890',
      affectedCapability: 'C:\\Users\\alice\\private-capability',
      expectedClassification: 'secret=abcdefghijk',
      returnChannel: { 'C:\\Users\\alice\\private-channel': 'safe' },
    });
    const serialized = JSON.stringify(value);

    expect(validateContractStructure(value)).toEqual({ ok: true, errors: [] });
    expect(serialized).not.toContain('ghp_');
    expect(serialized).not.toContain('alice');
    expect(serialized).not.toContain('abcdefghijk');
  });

  test('preview is side-effect free and submission requires exact per-report consent', async () => {
    const store = atomicFeedbackStore();
    let deliveries = 0;
    const intake = createFeedbackIntake({
      acceptFeedback: store.acceptFeedback,
      deliverFeedback: async () => { deliveries += 1; },
    });
    const value = report();

    expect(intake.preview(value)).toMatchObject({ status: 'pending-consent', report: value });
    expect(await intake.submit(value)).toMatchObject({ status: 'pending-consent', accepted: false, delivered: false });
    expect(store.calls).toHaveLength(0);
    expect(deliveries).toBe(0);

    await expect(intake.submit(value, {
      approved: true,
      eventId: 'wrong-consent',
      redactionPolicyRevision: 'redaction-1',
      reportId: value.payload.report_id,
      contentHash: value.content_hash,
    })).rejects.toMatchObject({ code: 'FEEDBACK_CONSENT_MISMATCH' });
    expect(store.calls).toHaveLength(0);
  });

  test('accepts once, suppresses an identical retry, and rejects identity reuse with changed content', async () => {
    const store = atomicFeedbackStore();
    const delivered = [];
    const intake = createFeedbackIntake({
      acceptFeedback: store.acceptFeedback,
      deliverFeedback: async value => delivered.push(value.content_hash),
    });
    const value = report();
    const consent = consentFor(value);

    expect(await intake.submit(value, consent)).toMatchObject({ status: 'accepted', accepted: true, delivered: true });
    expect(await intake.submit(value, consent)).toMatchObject({ status: 'retry-identical', accepted: false, delivered: false });
    expect(delivered).toHaveLength(1);

    const otherReport = report({}, IDS[1]);
    await expect(intake.submit(otherReport, consent)).rejects.toMatchObject({
      code: 'FEEDBACK_CONSENT_MISMATCH',
    });

    const conflict = structuredClone(value);
    conflict.payload.occurrence_count = 3;
    conflict.content_hash = computeContentHash(conflict);
    const conflictConsent = consentFor(conflict);
    await expect(intake.submit(conflict, conflictConsent)).rejects.toBeInstanceOf(FeedbackIntakeError);
    await expect(intake.submit(conflict, conflictConsent)).rejects.toMatchObject({ code: 'FEEDBACK_IDENTITY_CONFLICT' });
    expect(delivered).toHaveLength(1);
  });

  test('keeps an accepted local report when optional delivery fails', async () => {
    const store = atomicFeedbackStore();
    const intake = createFeedbackIntake({
      acceptFeedback: store.acceptFeedback,
      deliverFeedback: async () => { throw new Error('offline'); },
    });

    const value = report();
    expect(await intake.submit(value, consentFor(value))).toMatchObject({
      status: 'accepted-local',
      accepted: true,
      delivered: false,
      delivery_error: { code: 'FEEDBACK_DELIVERY_FAILED' },
    });
  });
});
