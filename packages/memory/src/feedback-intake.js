'use strict';

const { createHash, randomUUID: defaultRandomUUID } = require('node:crypto');
const {
  canonicalize,
  computeContentHash,
  semanticIdentity,
  validateContractStructure,
} = require('@forge/memory-contracts');

const FEEDBACK_SCHEMA_ID = 'forge.memory.feedback-report.v1';
const ASSIGNED_SECRET = /((?:api[_-]?key|token|secret|password)\s*[:=]\s*)\S{8,}/gi;
const BARE_SECRET = /(?:gh[pousr]_[A-Za-z0-9]{20,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16})/gi;
const USER_PATH = /(?:[A-Za-z]:\\Users\\[^\\\s]+\\|\/(?:Users|home)\/[^/\s]+\/)/gi;

class FeedbackIntakeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FeedbackIntakeError';
    this.code = code;
  }
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function redactString(value) {
  return value
    .replace(USER_PATH, '<user-path>/')
    .replace(ASSIGNED_SECRET, '[REDACTED]')
    .replace(BARE_SECRET, '[REDACTED]');
}

function redactValue(value) {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    const safeKey = redactString(key);
    if (Object.hasOwn(output, safeKey)) {
      throw new TypeError('redaction produced duplicate returnChannel keys');
    }
    output[safeKey] = redactValue(child);
  }
  return output;
}

function sha256(value) {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

function assertFeedbackReport(report) {
  const validation = validateContractStructure(report);
  if (report?.schema_id !== FEEDBACK_SCHEMA_ID || !validation.ok) {
    const codes = validation.errors.map(item => item.code).join(', ') || 'WRONG_SCHEMA';
    throw new FeedbackIntakeError('FEEDBACK_REPORT_INVALID', `FeedbackReport is invalid: ${codes}`);
  }
  return report;
}

function createFeedbackReport(input = {}, options = {}) {
  const randomUUID = options.randomUUID || defaultRandomUUID;
  const now = options.now || (() => new Date().toISOString());
  const reportId = randomUUID();
  const reproductionSteps = input.reproductionSteps;
  if (!Array.isArray(reproductionSteps) || reproductionSteps.length === 0) {
    throw new TypeError('reproductionSteps must be a non-empty array');
  }
  const redactedSteps = reproductionSteps.map((step, index) =>
    redactString(requiredString(step, `reproductionSteps[${index}]`)));
  const stableErrorCode = redactString(requiredString(input.stableErrorCode, 'stableErrorCode'));
  const affectedCapability = redactString(requiredString(input.affectedCapability, 'affectedCapability'));
  const expectedClassification = redactString(requiredString(input.expectedClassification, 'expectedClassification'));
  const actualClassification = redactString(requiredString(input.actualClassification, 'actualClassification'));
  const productVersion = redactString(requiredString(input.productVersion, 'productVersion'));
  const redactionPolicyRevision = redactString(requiredString(input.redactionPolicyRevision, 'redactionPolicyRevision'));
  const consentEventId = redactString(requiredString(input.consentEventId, 'consentEventId'));
  const occurrenceCount = input.occurrenceCount ?? 1;
  if (!Number.isInteger(occurrenceCount) || occurrenceCount < 1) {
    throw new TypeError('occurrenceCount must be a positive integer');
  }

  const payload = {
    report_id: reportId,
    product_version: productVersion,
    contract_version: 1,
    stable_error_code: stableErrorCode,
    affected_capability: affectedCapability,
    redacted_reproduction_steps: redactedSteps,
    expected_classification: expectedClassification,
    actual_classification: actualClassification,
    occurrence_count: occurrenceCount,
    content_fingerprint: sha256({
      stable_error_code: stableErrorCode,
      affected_capability: affectedCapability,
      redacted_reproduction_steps: redactedSteps,
      expected_classification: expectedClassification,
      actual_classification: actualClassification,
    }),
    consent_event_id: consentEventId,
    redaction_policy_revision: redactionPolicyRevision,
  };
  if (input.proposedFix !== undefined) {
    payload.proposed_fix = redactString(requiredString(input.proposedFix, 'proposedFix'));
  }
  if (input.returnChannel !== undefined) payload.return_channel = redactValue(input.returnChannel);

  const report = {
    schema_id: FEEDBACK_SCHEMA_ID,
    schema_version: 1,
    object_id: reportId,
    created_at: now(),
    producer: {
      product_id: 'forge-memory',
      product_version: productVersion,
      instance_id: reportId,
    },
    capabilities_used: [],
    provenance: {
      source_kind: 'feedback',
      actor_class: 'anonymous-user',
      actor_id: reportId,
    },
    payload,
    extensions: {},
  };
  report.content_hash = computeContentHash(report);
  return assertFeedbackReport(report);
}

function assertConsent(report, consent) {
  if (!consent || consent.approved !== true) return false;
  if (consent.eventId !== report.payload.consent_event_id
      || consent.redactionPolicyRevision !== report.payload.redaction_policy_revision
      || consent.reportId !== report.payload.report_id
      || consent.contentHash !== report.content_hash) {
    throw new FeedbackIntakeError(
      'FEEDBACK_CONSENT_MISMATCH',
      'Feedback consent must match this report and redaction-policy revision',
    );
  }
  return true;
}

function createFeedbackIntake({ acceptFeedback, deliverFeedback } = {}) {
  if (typeof acceptFeedback !== 'function') {
    throw new TypeError('acceptFeedback must be an atomic durable acceptance function');
  }
  if (deliverFeedback !== undefined && typeof deliverFeedback !== 'function') {
    throw new TypeError('deliverFeedback must be a function when provided');
  }

  function preview(report) {
    assertFeedbackReport(report);
    return { status: 'pending-consent', report: structuredClone(report) };
  }

  async function submit(report, consent) {
    assertFeedbackReport(report);
    if (!assertConsent(report, consent)) {
      return {
        status: consent?.approved === false ? 'declined' : 'pending-consent',
        accepted: false,
        delivered: false,
      };
    }

    const identity = semanticIdentity(report);
    const result = await acceptFeedback({
      identity,
      content_hash: report.content_hash,
      report: structuredClone(report),
    });
    if (result?.status === 'identity-conflict') {
      throw new FeedbackIntakeError(
        'FEEDBACK_IDENTITY_CONFLICT',
        'Feedback report identity was already accepted with different content',
      );
    }
    if (result?.status === 'retry-identical') {
      return { status: 'retry-identical', accepted: false, delivered: false, receipt: result.receipt };
    }
    if (result?.status !== 'accepted') {
      throw new FeedbackIntakeError('FEEDBACK_ACCEPTANCE_INVALID', 'Feedback authority returned an invalid result');
    }
    if (!deliverFeedback) {
      return { status: 'accepted-local', accepted: true, delivered: false, receipt: result.receipt };
    }
    try {
      const delivery = await deliverFeedback(structuredClone(report), { receipt: result.receipt });
      return { status: 'accepted', accepted: true, delivered: true, receipt: result.receipt, delivery };
    } catch {
      return {
        status: 'accepted-local',
        accepted: true,
        delivered: false,
        receipt: result.receipt,
        delivery_error: { code: 'FEEDBACK_DELIVERY_FAILED' },
      };
    }
  }

  return Object.freeze({ preview, submit });
}

module.exports = {
  FEEDBACK_SCHEMA_ID,
  FeedbackIntakeError,
  createFeedbackIntake,
  createFeedbackReport,
  redactString,
};
