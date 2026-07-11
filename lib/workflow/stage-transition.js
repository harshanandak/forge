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
  const from = normalizeStageId(match[1]);
  const to = normalizeStageId(match[2]);
  if (!from || !to) {
    return null;
  }
  return { from, to };
}

/**
 * Best-effort record of a stage transition into stage_runs. Parses the comment
 * body; on a valid transition it completes the from-stage and starts the to-stage
 * via `driver.recordStageRun`. ANY failure (parse miss, missing driver, DB error)
 * is swallowed and reported as `{ recorded: false }` — this function never throws.
 *
 * @param {object} params
 * @param {object} [params.driver] - Kernel driver exposing recordStageRun(input, config).
 * @param {string} params.issueId - Full kernel issue id the comment targets.
 * @param {string} params.body - The comment body just written.
 * @param {object} [params.config] - Driver config (e.g. { databasePath }).
 * @returns {{recorded: boolean, from?: string, to?: string}}
 */
function recordStageTransition({ driver, issueId, body, config = {} } = {}) {
  try {
    const transition = parseStageTransition(body);
    if (!transition || !issueId || !driver || typeof driver.recordStageRun !== 'function') {
      return { recorded: false };
    }
    driver.recordStageRun(
      { issue_id: issueId, stage: transition.from, action: 'complete' },
      config,
    );
    driver.recordStageRun(
      { issue_id: issueId, stage: transition.to, action: 'start' },
      config,
    );
    return { from: transition.from, to: transition.to, recorded: true };
  } catch {
    // Non-blocking by contract: never let a stage_run write break the comment.
    return { recorded: false };
  }
}

module.exports = {
  parseStageTransition,
  recordStageTransition,
};
