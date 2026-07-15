'use strict';

/**
 * Fast-fail gate runner for `forge preflight`.
 *
 * Executes an ordered list of gates one at a time. The first gate to fail
 * short-circuits the run: every later gate is reported as `skipped` and never
 * executed. This keeps preflight FAST — an agent fixes the first broken gate
 * and re-runs rather than waiting for the whole matrix.
 *
 * A gate is `{ name: string, run: () => Promise<{ ok: boolean, summary?: string }> }`.
 * The sub-runner behind each `run` is injected by the composer (see gates.js),
 * so this module stays pure and trivially testable.
 *
 * @module preflight/runner
 */

/**
 * @typedef {Object} GateOutcome
 * @property {boolean} ok       - Whether the gate passed.
 * @property {string} [summary] - Short human-readable result line.
 *
 * @typedef {Object} Gate
 * @property {string} name
 * @property {() => Promise<GateOutcome>} run
 *
 * @typedef {Object} GateResult
 * @property {string} name
 * @property {boolean|null} ok       - true/false, or null when skipped.
 * @property {boolean} skipped
 * @property {string} summary
 * @property {number} [durationMs]
 */

/**
 * Execute a single gate, normalizing thrown errors into a failed outcome.
 *
 * @param {Gate} gate
 * @returns {Promise<GateResult>}
 */
async function executeGate(gate) {
  const started = Date.now();
  let outcome;
  try {
    outcome = await gate.run();
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    outcome = { ok: false, summary: `error: ${message}` };
  }
  const durationMs = Date.now() - started;
  const skipped = !!outcome?.skipped;
  // A skipped gate is a pass-through: it is neither a pass nor a failure, so it
  // must never short-circuit later gates (see runGates fast-fail). BUT a skip
  // must never MASK an explicit failure — a gate that reports {ok:false} has
  // failed regardless of a skipped flag, so it stays failed and short-circuits.
  const explicitOk = !!outcome?.ok;
  const ok = skipped ? outcome?.ok !== false : explicitOk;
  // Contract: an explicit ok:false can never normalize to a pass. Guards against
  // a future edit reintroducing the skip-masks-failure bug (4b73b6bf).
  if (outcome && outcome.ok === false && ok === true) {
    throw new Error('executeGate contract violation: skipped must not override an explicit ok:false');
  }
  return {
    name: gate.name,
    ok,
    skipped,
    summary: outcome?.summary || '',
    durationMs,
  };
}

/** Live-log label for a gate result — SKIP must never read as PASS. */
function gateLogMark(result) {
  if (result.skipped) return 'SKIP';
  return result.ok ? 'PASS' : 'FAIL';
}

/**
 * Run gates in order, fast-failing at the first failure.
 *
 * @param {Gate[]} gates
 * @param {{ log?: (line: string) => void }} [options]
 * @returns {Promise<{ ok: boolean, results: GateResult[], failedIndex: number }>}
 */
async function runGates(gates, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const results = [];
  let ok = true;
  let failedIndex = -1;

  for (const gate of gates) {
    if (!ok) {
      results.push({
        name: gate.name,
        ok: null,
        skipped: true,
        summary: 'skipped (earlier gate failed)',
      });
      continue;
    }

    const result = await executeGate(gate);
    results.push(result);
    const suffix = result.summary ? ` — ${result.summary}` : '';
    log(`${gateLogMark(result)} ${gate.name}${suffix}`);

    if (!result.ok) {
      ok = false;
      failedIndex = results.length - 1;
    }
  }

  return { ok, results, failedIndex };
}

module.exports = { runGates };
