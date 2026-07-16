'use strict';

/**
 * @module grounding/read-first
 *
 * gate.read_first — the first gate that DENIES (fd4c03b3's first real payment):
 * acting on an issue requires having read it. Consulted at the `forge claim`
 * chokepoint (P1) exactly like gate.issue_verify is consulted at the _issue.js
 * boundary (isIssueVerifyEnabled). Fail-closed: no context.loaded event for the
 * issue this session/window -> a block result whose remedy IS the load action
 * (`forge recap <id>`), so the cheapest path through the gate is the correct
 * behavior. Disabling rail.grounding (master) or gate.read_first allows the
 * action (logged), same toggle surface as rail.kernel_tracking.
 */

const { getResolvedRuntimeGraph } = require('../core/runtime-graph');
const { readFirstVerdict } = require('./context-events');

const GROUNDING_RAIL_ID = 'rail.grounding';
const READ_FIRST_GATE_ID = 'gate.read_first';

/**
 * The block message. Contract: exit != 0, remedy is one copy-pastable command,
 * and running that command both satisfies the gate AND injects the context.
 */
function buildReadFirstBlockMessage(issueId) {
  return [
    `✗ ${READ_FIRST_GATE_ID}: issue ${issueId} has not been read this session.`,
    `  Run: forge recap ${issueId} first`,
    `  Then retry. (Override: forge gate disable ${READ_FIRST_GATE_ID} — logged.)`,
  ].join('\n');
}

/**
 * Resolve whether grounding + read_first are BOTH enabled. Mirrors
 * isIssueVerifyEnabled: an injected opts.resolveRuntimeGraph wins (tests); an
 * unresolvable config (lint errors) yields `unknown` so the caller can fail-open
 * on a broken config rather than bricking claim.
 *
 * @returns {{ enabled: boolean, disabledPrimitive?: string, unknown?: boolean }}
 */
function resolveReadFirstEnabled(projectRoot, opts = {}) {
  const resolveGraph = opts.resolveRuntimeGraph || getResolvedRuntimeGraph;
  let graph;
  try {
    graph = resolveGraph({ projectRoot });
  } catch {
    return { enabled: false, unknown: true };
  }
  const rail = (graph.rails || []).find(candidate => candidate.id === GROUNDING_RAIL_ID);
  const gate = (graph.gates || []).find(candidate => candidate.id === READ_FIRST_GATE_ID);
  const railOn = rail ? rail.enabled !== false : true;
  const gateOn = gate ? gate.enabled !== false : true;
  if (!railOn) return { enabled: false, disabledPrimitive: GROUNDING_RAIL_ID };
  if (!gateOn) return { enabled: false, disabledPrimitive: READ_FIRST_GATE_ID };
  return { enabled: true };
}

/**
 * Consult gate.read_first for an issue. Returns `null` when the action is
 * allowed (gate off, or a fresh context.loaded event exists), or a block result
 * `{ success:false, error, exitCode }` when the issue has not been read.
 *
 * @param {string} projectRoot
 * @param {string} issueId
 * @param {Object} [opts] - { resolveRuntimeGraph, kernelBroker, kernelDriver, session, windowMs, now }
 * @returns {Promise<null | { success: false, error: string, exitCode: number }>}
 */
async function checkReadFirst(projectRoot, issueId, opts = {}) {
  const state = resolveReadFirstEnabled(projectRoot, opts);
  if (!state.enabled) {
    // Disabled (or unresolvable config) -> allow. Log the deliberate skip.
    if (state.disabledPrimitive) {
      console.error(`forge: ${state.disabledPrimitive} disabled — claim on ${issueId} allowed without grounding check.`);
    }
    return null;
  }

  const deps = (opts.kernelBroker && opts.kernelDriver)
    ? { kernelBroker: opts.kernelBroker, kernelDriver: opts.kernelDriver }
    : undefined;

  let verdict;
  try {
    verdict = await readFirstVerdict(projectRoot, issueId, {
      session: opts.session,
      windowMs: opts.windowMs,
      now: opts.now,
      deps,
    });
  } catch {
    // Kernel unavailable (broken env) -> fail-open, like issue_verify on a
    // config error. In production the project kernel resolves; the enforced
    // path is the normal one.
    return null;
  }

  // 'missing' -> the issue is not in the consulted kernel; the gate is inert (a
  // real claim on a non-existent issue fails on its own — no grounding bypass).
  // 'loaded' -> a fresh context.loaded event exists. Both allow.
  if (verdict !== 'unread') return null;

  return { success: false, error: buildReadFirstBlockMessage(issueId), exitCode: 6 };
}

module.exports = {
  GROUNDING_RAIL_ID,
  READ_FIRST_GATE_ID,
  buildReadFirstBlockMessage,
  resolveReadFirstEnabled,
  checkReadFirst,
};
