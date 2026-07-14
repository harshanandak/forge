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
  const skipped = !!(outcome && outcome.skipped);
  return {
    name: gate.name,
    // A skipped gate is a pass-through: it is neither a pass nor a failure, so
    // it must never short-circuit later gates (see runGates fast-fail).
    ok: skipped ? true : !!(outcome && outcome.ok),
    skipped,
    summary: (outcome && outcome.summary) || '',
    durationMs,
  };
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
    log(`${result.ok ? 'PASS' : 'FAIL'} ${gate.name}${result.summary ? ` — ${result.summary}` : ''}`);

    if (!result.ok) {
      ok = false;
      failedIndex = results.length - 1;
    }
  }

  return { ok, results, failedIndex };
}

module.exports = { runGates };
