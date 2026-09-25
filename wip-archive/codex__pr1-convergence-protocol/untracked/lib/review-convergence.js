'use strict';

const crypto = require('node:crypto');
const { stableStringify } = require('./kernel/evaluators');

const FEEDBACK_CLASSIFICATIONS = new Set([
  'actionable', 'status', 'empty', 'outdated', 'optional',
]);
const EXECUTION_SCOPES = new Set(['affected', 'broad', 'full']);
const EXECUTION_STATUSES = new Set(['PASS', 'FAIL', 'INCOMPLETE', 'RUNNING']);
const SHA_PATTERN = /^[a-f0-9]{40}$/;

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort(compareText);
}

function isSha(value) {
  return typeof value === 'string' && SHA_PATTERN.test(value);
}

function timestamp(value) {
  if (typeof value !== 'string') return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? { millis, iso: new Date(millis).toISOString() } : null;
}

function receiptHash(receipt) {
  const { receipt_hash: _receiptHash, ...payload } = receipt;
  return `sha256:${crypto.createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex')}`;
}

function createCorrectionReceipt({
  sourceHeadSha,
  correctionHeadSha,
  feedbackIds,
  createdAt,
} = {}) {
  const created = timestamp(createdAt);
  if (!isSha(sourceHeadSha) || !isSha(correctionHeadSha) || sourceHeadSha === correctionHeadSha) {
    throw new Error('Correction receipt requires distinct full source and correction SHAs');
  }
  if (!Array.isArray(feedbackIds)
    || feedbackIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new Error('Correction receipt requires feedback ids');
  }
  const normalizedIds = uniqueSorted(feedbackIds);
  if (normalizedIds.length === 0 || !created) {
    throw new Error('Correction receipt requires feedback ids and a valid creation time');
  }
  const receipt = {
    schema_id: 'forge.review.correction-receipt.v1',
    source_head_sha: sourceHeadSha,
    correction_head_sha: correctionHeadSha,
    feedback_ids: normalizedIds,
    created_at: created.iso,
  };
  return { ...receipt, receipt_hash: receiptHash(receipt) };
}

function validateFeedback(feedback) {
  if (!Array.isArray(feedback) || feedback.length === 0) return null;
  const normalized = [];
  const ids = new Set();
  for (const observation of feedback) {
    const observed = timestamp(observation?.observed_at);
    if (!observation || typeof observation.id !== 'string' || observation.id.length === 0
      || ids.has(observation.id) || !FEEDBACK_CLASSIFICATIONS.has(observation.classification)
      || !isSha(observation.head_sha) || !observed) {
      return null;
    }
    ids.add(observation.id);
    normalized.push({ ...observation, observed_at: observed.iso, observed_ms: observed.millis });
  }
  return normalized;
}

function validReceipt(receipt) {
  if (!receipt || receipt.schema_id !== 'forge.review.correction-receipt.v1'
    || !isSha(receipt.source_head_sha) || !isSha(receipt.correction_head_sha)
    || receipt.source_head_sha === receipt.correction_head_sha
    || !Array.isArray(receipt.feedback_ids) || receipt.feedback_ids.length === 0
    || receipt.feedback_ids.some((id) => typeof id !== 'string' || id.length === 0)
    || timestamp(receipt.created_at)?.iso !== receipt.created_at) {
    return false;
  }
  const normalizedIds = uniqueSorted(receipt.feedback_ids);
  if (normalizedIds.length !== receipt.feedback_ids.length
    || normalizedIds.some((id, index) => id !== receipt.feedback_ids[index])) {
    return false;
  }
  return /^sha256:[a-f0-9]{64}$/.test(receipt.receipt_hash)
    && receipt.receipt_hash === receiptHash(receipt);
}

function validateExecutions(executions) {
  if (!Array.isArray(executions)) return null;
  const ids = new Set();
  const normalized = [];
  for (const execution of executions) {
    const started = timestamp(execution?.started_at);
    const completed = execution?.completed_at == null ? null : timestamp(execution.completed_at);
    if (!execution || typeof execution.id !== 'string' || execution.id.length === 0
      || ids.has(execution.id) || !isSha(execution.sha)
      || !EXECUTION_SCOPES.has(execution.scope) || !EXECUTION_STATUSES.has(execution.status)
      || !started || (execution.status !== 'RUNNING' && !completed)
      || (completed && completed.millis < started.millis)) {
      return null;
    }
    ids.add(execution.id);
    normalized.push({
      ...execution,
      started_at: started.iso,
      completed_at: completed?.iso,
      started_ms: started.millis,
      completed_ms: completed?.millis,
    });
  }
  return normalized;
}

function state(reason, details = {}) {
  return {
    schema_id: 'forge.review.convergence-state.v1',
    ...details,
    reason,
  };
}

function evaluateExecutions(executions, correctionSha, receiptDetails, { requireAffected = true } = {}) {
  const correctionExecutions = executions.filter((execution) => execution.sha === correctionSha);
  const affected = correctionExecutions.filter((execution) => execution.scope === 'affected');
  const broad = correctionExecutions.filter((execution) => execution.scope === 'broad' || execution.scope === 'full');

  if (broad.length > 1) {
    return state('duplicate_same_sha_full_execution', { ...receiptDetails, state: 'INCOMPLETE' });
  }
  if (requireAffected && broad.length > 0
    && (affected.length === 0 || affected.some((execution) => execution.status !== 'PASS')
      || affected.some((execution) => execution.completed_ms > broad[0].started_ms))) {
    return state('full_validation_precedes_affected_validation', {
      ...receiptDetails,
      state: 'INCOMPLETE',
    });
  }
  if (!requireAffected && broad.length === 0) {
    return state('final_head_full_validation_required', { ...receiptDetails, state: 'RUN_FULL' });
  }
  if (!requireAffected) {
    const fullExecution = broad[0];
    const reused = { ...receiptDetails, reused_execution_id: fullExecution.id };
    if (fullExecution.status === 'PASS') {
      return state('same_sha_full_evidence_reused', { ...reused, state: 'COMPLETE' });
    }
    if (fullExecution.status === 'FAIL') {
      return state('same_sha_full_validation_failed', {
        ...reused,
        state: 'NEW_CORRECTION_SHA_REQUIRED',
      });
    }
    if (fullExecution.status === 'RUNNING') {
      return state('same_sha_full_validation_running', { ...reused, state: 'WAIT_FOR_FULL' });
    }
    return state('same_sha_full_validation_incomplete', { ...reused, state: 'INCOMPLETE' });
  }
  if (affected.some((execution) => execution.status === 'INCOMPLETE')) {
    return state('affected_validation_incomplete', { ...receiptDetails, state: 'INCOMPLETE' });
  }
  if (affected.some((execution) => execution.status === 'FAIL')) {
    return state('affected_validation_failed', {
      ...receiptDetails,
      state: 'NEW_CORRECTION_SHA_REQUIRED',
    });
  }
  if (affected.some((execution) => execution.status === 'RUNNING')) {
    return state('affected_validation_running', { ...receiptDetails, state: 'WAIT_FOR_AFFECTED' });
  }
  if (affected.length === 0) {
    return state('affected_validation_required', { ...receiptDetails, state: 'RUN_AFFECTED' });
  }
  if (broad.length === 0) {
    return state('final_head_full_validation_required', { ...receiptDetails, state: 'RUN_FULL' });
  }

  const fullExecution = broad[0];
  const reused = { ...receiptDetails, reused_execution_id: fullExecution.id };
  if (fullExecution.status === 'PASS') {
    return state('same_sha_full_evidence_reused', { ...reused, state: 'COMPLETE' });
  }
  if (fullExecution.status === 'FAIL') {
    return state('same_sha_full_validation_failed', {
      ...reused,
      state: 'NEW_CORRECTION_SHA_REQUIRED',
    });
  }
  if (fullExecution.status === 'RUNNING') {
    return state('same_sha_full_validation_running', { ...reused, state: 'WAIT_FOR_FULL' });
  }
  return state('same_sha_full_validation_incomplete', { ...reused, state: 'INCOMPLETE' });
}

function evaluateConvergence(input = {}) {
  const now = timestamp(input.now);
  const feedback = validateFeedback(input.feedback);
  const executions = validateExecutions(input.executions);
  if (!now || !Number.isSafeInteger(input.quietWindowMs) || input.quietWindowMs <= 0
    || !isSha(input.currentHeadSha) || !feedback) {
    return state('invalid_protocol_input', { state: 'INCOMPLETE' });
  }
  if (!executions) return state('invalid_execution_evidence', { state: 'INCOMPLETE' });

  const lastObservedMs = Math.max(...feedback.map((observation) => observation.observed_ms));
  const closesMs = lastObservedMs + input.quietWindowMs;
  if (!Number.isSafeInteger(closesMs) || Math.abs(closesMs) > 8.64e15) {
    return state('invalid_protocol_input', { state: 'INCOMPLETE' });
  }
  const quietWindow = {
    duration_ms: input.quietWindowMs,
    last_observed_at: new Date(lastObservedMs).toISOString(),
    closes_at: new Date(closesMs).toISOString(),
    remaining_ms: Math.max(0, closesMs - now.millis),
  };
  const actionable = feedback.filter((observation) => observation.classification === 'actionable');
  const actionableIds = uniqueSorted(actionable.map((observation) => observation.id));
  const common = { quiet_window: quietWindow, actionable_feedback_ids: actionableIds };

  if (now.millis < closesMs) {
    return state('feedback_quiet_window_open', {
      ...common,
      state: 'WAIT_FOR_QUIET_WINDOW',
    });
  }
  if (actionableIds.length === 0) {
    return evaluateExecutions(executions, input.currentHeadSha, {
      ...common,
      correction_sha: input.currentHeadSha,
    }, { requireAffected: false });
  }
  if (input.correctionReceipt == null) {
    return state('integrated_correction_required', { ...common, state: 'READY_FOR_CORRECTION' });
  }
  if (!validReceipt(input.correctionReceipt)) {
    return state('invalid_correction_receipt', { ...common, state: 'INCOMPLETE' });
  }

  const receipt = input.correctionReceipt;
  if (receipt.correction_head_sha !== input.currentHeadSha) {
    return state('correction_head_mismatch', { ...common, state: 'INCOMPLETE' });
  }
  const actionableSourceShas = uniqueSorted(actionable.map((observation) => observation.head_sha));
  if (actionableSourceShas.length !== 1 || actionableSourceShas[0] !== receipt.source_head_sha
    || stableStringify(actionableIds) !== stableStringify(receipt.feedback_ids)) {
    return state('correction_batch_mismatch', { ...common, state: 'INCOMPLETE' });
  }
  if (Date.parse(receipt.created_at) < closesMs) {
    return state('correction_precedes_quiet_window', { ...common, state: 'INCOMPLETE' });
  }
  if (Date.parse(receipt.created_at) > now.millis) {
    return state('correction_receipt_from_future', { ...common, state: 'INCOMPLETE' });
  }

  const correctionSha = receipt.correction_head_sha;
  const receiptDetails = {
    ...common,
    correction_sha: correctionSha,
    correction_receipt_hash: receipt.receipt_hash,
  };
  return evaluateExecutions(executions, correctionSha, receiptDetails);
}

module.exports = {
  createCorrectionReceipt,
  evaluateConvergence,
};
