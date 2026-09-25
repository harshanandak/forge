'use strict';

const { describe, expect, test } = require('bun:test');

const {
  createCorrectionReceipt,
  evaluateConvergence,
} = require('../lib/review-convergence');

const SOURCE_SHA = '1111111111111111111111111111111111111111';
const CORRECTION_SHA = '2222222222222222222222222222222222222222';

function actionableFeedback(overrides = {}) {
  return {
    id: 'thread-1',
    classification: 'actionable',
    head_sha: SOURCE_SHA,
    observed_at: '2026-08-09T12:00:00.000Z',
    ...overrides,
  };
}

function correctionReceipt(overrides = {}) {
  return createCorrectionReceipt({
    sourceHeadSha: SOURCE_SHA,
    correctionHeadSha: CORRECTION_SHA,
    feedbackIds: ['thread-1'],
    createdAt: '2026-08-09T12:10:00.000Z',
    ...overrides,
  });
}

function protocolInput(overrides = {}) {
  return {
    now: '2026-08-09T12:20:00.000Z',
    quietWindowMs: 10 * 60 * 1000,
    currentHeadSha: CORRECTION_SHA,
    feedback: [actionableFeedback()],
    correctionReceipt: correctionReceipt(),
    executions: [],
    ...overrides,
  };
}

function execution(overrides = {}) {
  return {
    id: 'affected-1',
    sha: CORRECTION_SHA,
    scope: 'affected',
    status: 'PASS',
    started_at: '2026-08-09T12:10:00.000Z',
    completed_at: '2026-08-09T12:11:00.000Z',
    ...overrides,
  };
}

describe('review correction convergence protocol', () => {
  test('uses the latest observation as the canonical quiet-window boundary', () => {
    const result = evaluateConvergence(protocolInput({
      now: '2026-08-09T12:12:00.000Z',
      feedback: [
        actionableFeedback(),
        actionableFeedback({
          id: 'status-1',
          classification: 'status',
          observed_at: '2026-08-09T12:05:00.000Z',
        }),
      ],
    }));

    expect(result).toMatchObject({
      schema_id: 'forge.review.convergence-state.v1',
      state: 'WAIT_FOR_QUIET_WINDOW',
      reason: 'feedback_quiet_window_open',
      quiet_window: {
        last_observed_at: '2026-08-09T12:05:00.000Z',
        closes_at: '2026-08-09T12:15:00.000Z',
        remaining_ms: 180000,
      },
    });
  });

  test('waits for one integrated correction receipt after the quiet window closes', () => {
    const result = evaluateConvergence(protocolInput({ correctionReceipt: null }));

    expect(result.state).toBe('READY_FOR_CORRECTION');
    expect(result.reason).toBe('integrated_correction_required');
    expect(result.actionable_feedback_ids).toEqual(['thread-1']);
  });

  test('creates a deterministic receipt bound to both heads and the complete feedback batch', () => {
    const left = createCorrectionReceipt({
      sourceHeadSha: SOURCE_SHA,
      correctionHeadSha: CORRECTION_SHA,
      feedbackIds: ['thread-2', 'thread-1', 'thread-1'],
      createdAt: '2026-08-09T12:10:00.000Z',
    });
    const right = createCorrectionReceipt({
      sourceHeadSha: SOURCE_SHA,
      correctionHeadSha: CORRECTION_SHA,
      feedbackIds: ['thread-1', 'thread-2'],
      createdAt: '2026-08-09T12:10:00.000Z',
    });

    expect(left).toEqual(right);
    expect(left.feedback_ids).toEqual(['thread-1', 'thread-2']);
    expect(left.receipt_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test('fails closed when the receipt is stale, tampered, or omits actionable feedback', () => {
    const stale = evaluateConvergence(protocolInput({ currentHeadSha: '3333333333333333333333333333333333333333' }));
    expect(stale).toMatchObject({ state: 'INCOMPLETE', reason: 'correction_head_mismatch' });

    const tampered = correctionReceipt();
    tampered.feedback_ids = [];
    const invalid = evaluateConvergence(protocolInput({ correctionReceipt: tampered }));
    expect(invalid).toMatchObject({ state: 'INCOMPLETE', reason: 'invalid_correction_receipt' });

    const incompleteBatch = correctionReceipt();
    const uncovered = evaluateConvergence(protocolInput({
      feedback: [actionableFeedback(), actionableFeedback({ id: 'thread-2' })],
      correctionReceipt: incompleteBatch,
    }));
    expect(uncovered).toMatchObject({ state: 'INCOMPLETE', reason: 'correction_batch_mismatch' });
  });

  test('requests affected validation once the integrated correction head is proven', () => {
    const result = evaluateConvergence(protocolInput());

    expect(result).toMatchObject({
      state: 'RUN_AFFECTED',
      reason: 'affected_validation_required',
      correction_sha: CORRECTION_SHA,
    });
  });

  test('requests the full matrix only after affected validation passes', () => {
    const result = evaluateConvergence(protocolInput({
      executions: [execution()],
    }));

    expect(result).toMatchObject({
      state: 'RUN_FULL',
      reason: 'final_head_full_validation_required',
      correction_sha: CORRECTION_SHA,
    });
  });

  test('reuses a same-SHA successful full receipt instead of scheduling a rerun', () => {
    const result = evaluateConvergence(protocolInput({
      executions: [
        execution(),
        execution({
          id: 'full-1', scope: 'full', started_at: '2026-08-09T12:12:00.000Z',
          completed_at: '2026-08-09T12:18:00.000Z',
        }),
      ],
    }));

    expect(result).toMatchObject({
      state: 'COMPLETE',
      reason: 'same_sha_full_evidence_reused',
      reused_execution_id: 'full-1',
    });
  });

  test('never reruns broad or full validation on a failed or incomplete same SHA', () => {
    const failed = evaluateConvergence(protocolInput({
      executions: [
        execution(),
        execution({
          id: 'full-1', scope: 'full', status: 'FAIL', started_at: '2026-08-09T12:12:00.000Z',
          completed_at: '2026-08-09T12:18:00.000Z',
        }),
      ],
    }));
    expect(failed).toMatchObject({
      state: 'NEW_CORRECTION_SHA_REQUIRED',
      reason: 'same_sha_full_validation_failed',
    });

    const incomplete = evaluateConvergence(protocolInput({
      executions: [
        execution(),
        execution({
          id: 'full-1', scope: 'broad', status: 'INCOMPLETE', started_at: '2026-08-09T12:12:00.000Z',
          completed_at: '2026-08-09T12:18:00.000Z',
        }),
      ],
    }));
    expect(incomplete).toMatchObject({
      state: 'INCOMPLETE',
      reason: 'same_sha_full_validation_incomplete',
    });
  });

  test('fails closed when duplicate broad/full executions exist for one SHA', () => {
    const result = evaluateConvergence(protocolInput({
      executions: [
        execution(),
        execution({ id: 'broad-1', scope: 'broad' }),
        execution({ id: 'full-1', scope: 'full' }),
      ],
    }));

    expect(result).toMatchObject({
      state: 'INCOMPLETE',
      reason: 'duplicate_same_sha_full_execution',
    });
  });

  test('fails closed for missing clocks and malformed protocol evidence', () => {
    expect(evaluateConvergence(protocolInput({ now: undefined }))).toMatchObject({
      state: 'INCOMPLETE', reason: 'invalid_protocol_input',
    });
    expect(evaluateConvergence(protocolInput({ quietWindowMs: 0 }))).toMatchObject({
      state: 'INCOMPLETE', reason: 'invalid_protocol_input',
    });
    expect(evaluateConvergence(protocolInput({
      executions: [{ id: 'bad', sha: CORRECTION_SHA, scope: 'full', status: 'UNKNOWN' }],
    }))).toMatchObject({ state: 'INCOMPLETE', reason: 'invalid_execution_evidence' });
  });

  test('fails closed for future receipts, falsey malformed receipts, and overflowing windows', () => {
    expect(evaluateConvergence(protocolInput({
      now: '2026-08-09T12:20:00.000Z',
      correctionReceipt: correctionReceipt({ createdAt: '2026-08-09T12:21:00.000Z' }),
    }))).toMatchObject({ state: 'INCOMPLETE', reason: 'correction_receipt_from_future' });
    expect(evaluateConvergence(protocolInput({ correctionReceipt: false }))).toMatchObject({
      state: 'INCOMPLETE', reason: 'invalid_correction_receipt',
    });
    expect(evaluateConvergence(protocolInput({ quietWindowMs: Number.MAX_SAFE_INTEGER }))).toMatchObject({
      state: 'INCOMPLETE', reason: 'invalid_protocol_input',
    });
  });

  test('requires reconstructable affected-before-full ordering', () => {
    const result = evaluateConvergence(protocolInput({
      executions: [
        execution({ status: 'RUNNING', completed_at: undefined }),
        execution({
          id: 'full-1', scope: 'full', started_at: '2026-08-09T12:12:00.000Z',
          completed_at: '2026-08-09T12:18:00.000Z',
        }),
      ],
    }));
    expect(result).toMatchObject({
      state: 'INCOMPLETE', reason: 'full_validation_precedes_affected_validation',
    });

    expect(evaluateConvergence(protocolInput({
      executions: [
        execution(),
        execution({ id: 'full-1', scope: 'full', started_at: '2026-08-09T12:10:30.000Z' }),
      ],
    }))).toMatchObject({
      state: 'INCOMPLETE', reason: 'full_validation_precedes_affected_validation',
    });
  });

  test('still requires and reuses final-head full evidence when feedback is not actionable', () => {
    const quiet = protocolInput({
      currentHeadSha: SOURCE_SHA,
      correctionReceipt: null,
      feedback: [actionableFeedback({ classification: 'status' })],
    });
    expect(evaluateConvergence(quiet)).toMatchObject({
      state: 'RUN_FULL', reason: 'final_head_full_validation_required', correction_sha: SOURCE_SHA,
    });

    expect(evaluateConvergence({
      ...quiet,
      executions: [execution({
        id: 'full-original', sha: SOURCE_SHA, scope: 'full',
        started_at: '2026-08-09T12:11:00.000Z', completed_at: '2026-08-09T12:18:00.000Z',
      })],
    })).toMatchObject({
      state: 'COMPLETE', reason: 'same_sha_full_evidence_reused',
      reused_execution_id: 'full-original',
    });
  });
});
