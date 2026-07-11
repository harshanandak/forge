'use strict';

/**
 * Stage-transition auto-recording (5a5ba3a6).
 *
 * PR #348 (f61601ab) added the stage_runs record/read capability but nothing
 * populated it automatically — `current_stage` stayed unknown. The Descriptive
 * Context Convention (AGENTS.md) already has agents record each stage boundary as
 * a kernel issue comment shaped:
 *
 *     stage: <from> -> <to>
 *     summary: ...
 *
 * This module turns that existing, already-followed convention into a structured
 * stage_run WITHOUT any new manual verb call: parse the `stage:` line and, best
 * effort, complete the from-stage and start the to-stage. Recording is strictly
 * non-blocking — a stage_run write failure must NEVER break the comment that
 * triggered it.
 *
 * @module workflow/stage-transition
 */

const { normalizeStageId } = require('./stages');

// `stage: <from> -> <to>` on its own line, case-insensitive, arrow spacing optional.
const STAGE_LINE = /^\s*stage:\s*([a-z]+)\s*->\s*([a-z]+)\s*$/im;

/**
 * Parse a stage-transition line out of a comment body.
 *
 * @param {string} body - Comment body (may be multi-line).
 * @returns {{from: string, to: string}|null} Normalized stages, or null when the
 *   body has no valid `stage: X -> Y` line (both tokens must be canonical stages).
 */
function parseStageTransition(body) {
  if (typeof body !== 'string' || body.length === 0) {
    return null;
  }
  const match = body.match(STAGE_LINE);
  if (!match) {
    return null;
  }
  // STAGE_LINE is case-insensitive, so an uppercase token (e.g. `stage: DEV ->
  // VALIDATE`) matches. normalizeStageId only knows lowercase canonical ids, so
  // lowercase both captures first or an uppercase-but-valid stage is wrongly rejected.
  const from = normalizeStageId(match[1].toLowerCase());
  const to = normalizeStageId(match[2].toLowerCase());
  if (!from || !to) {
    return null;
  }
  return { from, to };
}

/**
 * Best-effort record of a stage transition into stage_runs. Parses the comment
 * body; on a valid transition it completes the from-stage and starts the to-stage.
 *
 * The write must be ATOMIC: completing `from` and starting `to` are one logical
 * transition, so a failure partway through must leave neither persisted (otherwise
 * `current_stage` reflects a half-transition — from marked done, to never started).
 * The preferred path is a single transactional `driver.recordStageTransition` that
 * wraps both writes in one transaction; a driver that only exposes `recordStageRun`
 * falls back to two sequential writes (non-atomic, tolerated only because the whole
 * operation is non-blocking).
 *
 * ANY failure (parse miss, missing driver, DB error) is swallowed and reported as
 * `{ recorded: false }` — this function never throws.
 *
 * @param {object} params
 * @param {object} [params.driver] - Kernel driver exposing recordStageTransition
 *   (preferred) and/or recordStageRun(input, config).
 * @param {string} params.issueId - Full kernel issue id the comment targets.
 * @param {string} params.body - The comment body just written.
 * @param {object} [params.config] - Driver config (e.g. { databasePath }).
 * @returns {{recorded: boolean, from?: string, to?: string}}
 */
function recordStageTransition({ driver, issueId, body, config = {} } = {}) {
  try {
    const transition = parseStageTransition(body);
    if (!transition || !issueId || !driver) {
      return { recorded: false };
    }
    // Preferred: one atomic driver op — complete(from) + start(to) inside a single
    // transaction, so a mid-transition failure rolls back and never persists a
    // wrong `current_stage`.
    if (typeof driver.recordStageTransition === 'function') {
      driver.recordStageTransition(
        { issue_id: issueId, from: transition.from, to: transition.to },
        config,
      );
      return { from: transition.from, to: transition.to, recorded: true };
    }
    // Fallback for a minimal driver without the atomic op: two sequential writes.
    if (typeof driver.recordStageRun === 'function') {
      driver.recordStageRun(
        { issue_id: issueId, stage: transition.from, action: 'complete' },
        config,
      );
      driver.recordStageRun(
        { issue_id: issueId, stage: transition.to, action: 'start' },
        config,
      );
      return { from: transition.from, to: transition.to, recorded: true };
    }
    return { recorded: false };
  } catch {
    // Non-blocking by contract: never let a stage_run write break the comment.
    return { recorded: false };
  }
}

module.exports = {
  parseStageTransition,
  recordStageTransition,
};
