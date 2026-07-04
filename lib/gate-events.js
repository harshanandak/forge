'use strict';

/**
 * @module gate-events
 *
 * Human gates enforced by kernel EVENTS, not skill prose (Fable's key insight,
 * locked in docs/work/2026-07-04-kernel-native-skills/decisions.md). A gate
 * approval is a durable, queryable, resume-safe kernel event on the ISSUE:
 * `gate.approved` / `gate.rejected` by an actor. `forge gate check` (and, later,
 * the ship stage) refuses to proceed without the required `gate.approved` event
 * UNLESS the gate is toggled off — giving evidence-checked HARD-GATEs and
 * resume-from-kernel-state after a compaction/crash for free.
 *
 * Mechanism: a PURE APPEND to the issue's event stream via the driver primitives
 * (`insertKernelEvent` + `listKernelEvents`), NOT the guarded issue-mutation
 * pipeline. Gate events do not mutate the issue, so they must not participate in
 * the issue-revision CAS (`lib/kernel/evaluators.js` would otherwise quarantine an
 * `expected_revision:0` append against a non-zero issue revision as `stale_revision`).
 * Idempotency is enforced two ways: a pre-check on the idempotency key, plus the
 * unique index `idx_kernel_events_idempotency` catching a concurrent race.
 *
 * Config-surface note: which gates EXIST (and whether each is enabled) lives in the
 * runtime graph + `.forge/config.yaml`; this module only records/reads the events.
 */

const { buildMigratedKernelIssueDeps } = require('./kernel/cli-broker-factory');
const { resolveIssueActor } = require('./forge-issues');

const GATE_APPROVED_EVENT = 'gate.approved';
const GATE_REJECTED_EVENT = 'gate.rejected';

const GATE_EVENT_TYPES = {
  approved: GATE_APPROVED_EVENT,
  rejected: GATE_REJECTED_EVENT,
};

const ISSUE_ENTITY_TYPE = 'issue';
const GATE_EVENT_ORIGIN = 'cli';

/**
 * Resolve the kernel broker + driver + config. Tests (and the orchestrator) inject
 * a shared, already-migrated kernel via `deps`; the CLI path builds a fresh one for
 * the (short-lived) process.
 *
 * @param {string} projectRoot
 * @param {{ kernelBroker?: Object, kernelDriver?: Object }} [deps]
 * @returns {Promise<{ broker: Object, driver: Object, config: Object }>}
 */
async function resolveGateKernel(projectRoot, deps = {}) {
  if (deps.kernelBroker && deps.kernelDriver) {
    return { broker: deps.kernelBroker, driver: deps.kernelDriver, config: deps.kernelBroker.config };
  }
  const built = await buildMigratedKernelIssueDeps({ projectRoot });
  return { broker: built.kernelBroker, driver: built.kernelDriver, config: built.kernelBroker.config };
}

/**
 * Idempotency key for a gate event. Scoped to issue + gate + actor + decision so a
 * SAME-actor re-approval mints no duplicate, while a later reject (different
 * decision) or a different actor is recorded as its own event.
 */
function gateIdempotencyKey(eventType, issueId, gateId, actor) {
  return `${eventType}:${issueId}:${gateId}:${actor}`;
}

/** Shape a stored kernel_events row into the gate-event view callers consume. */
function parseGateEvent(row) {
  let payload;
  try {
    payload = row.payload_json ? JSON.parse(row.payload_json) : {};
  } catch {
    payload = {};
  }
  const view = {
    event_type: row.event_type,
    gate: payload.gate,
    actor: row.actor,
    created_at: row.created_at,
  };
  if (payload.reason !== undefined) view.reason = payload.reason;
  return view;
}

function isIdempotencyRace(error) {
  const message = error && error.message ? String(error.message) : '';
  return /UNIQUE constraint failed/i.test(message) && /idempotency_key/i.test(message);
}

/**
 * Record a gate decision as a kernel event on the issue. Idempotent per
 * issue+gate+actor+decision. Validates the issue exists (the caller validates the
 * gate id against the known-gate set before calling).
 *
 * @param {string} projectRoot
 * @param {Object} params
 * @param {string} params.issueId
 * @param {string} params.gateId
 * @param {'approved'|'rejected'} params.decision
 * @param {string} [params.reason]
 * @param {Object} [params.env] - env source for actor resolution (FORGE_ACTOR → …).
 * @param {Object} [params.deps] - injected { kernelBroker, kernelDriver }.
 * @param {string} [params.now] - ISO timestamp (defaults to now).
 * @returns {Promise<{ ok: boolean, duplicate?: boolean, issueMissing?: boolean, event?: Object, actor?: string }>}
 */
async function recordGateEvent(projectRoot, params = {}) {
  const { issueId, gateId, decision, reason, env, deps, now } = params;
  const eventType = GATE_EVENT_TYPES[decision];
  if (!eventType) {
    throw new Error(`Unknown gate decision '${decision}' (expected 'approved' or 'rejected').`);
  }

  const actor = resolveIssueActor(env || process.env) || 'forge';
  const { driver, config } = await resolveGateKernel(projectRoot, deps);

  const entity = await driver.loadKernelEntity(ISSUE_ENTITY_TYPE, issueId, {}, config);
  if (!entity) {
    return { ok: false, issueMissing: true, actor };
  }

  const idempotencyKey = gateIdempotencyKey(eventType, issueId, gateId, actor);

  const existing = await driver.loadKernelEventByIdempotencyKey(idempotencyKey, {}, config);
  if (existing) {
    return { ok: true, duplicate: true, event: parseGateEvent(existing), actor };
  }

  const payload = { gate: gateId, actor };
  if (typeof reason === 'string' && reason.length > 0) payload.reason = reason;

  const event = {
    entity_type: ISSUE_ENTITY_TYPE,
    entity_id: issueId,
    event_type: eventType,
    idempotency_key: idempotencyKey,
    expected_revision: 0,
    actor,
    origin: GATE_EVENT_ORIGIN,
    payload,
    created_at: now || new Date().toISOString(),
  };

  try {
    const inserted = await driver.insertKernelEvent(event, {}, config);
    return { ok: true, duplicate: false, event: parseGateEvent(inserted), actor };
  } catch (error) {
    if (isIdempotencyRace(error)) {
      const winner = await driver.loadKernelEventByIdempotencyKey(idempotencyKey, {}, config);
      return { ok: true, duplicate: true, event: winner ? parseGateEvent(winner) : parseGateEvent(event), actor };
    }
    throw error;
  }
}

/**
 * List every gate event on an issue, oldest first.
 *
 * @param {string} projectRoot
 * @param {string} issueId
 * @param {{ deps?: Object }} [options]
 * @returns {Promise<Array<{ event_type: string, gate: string, actor: string, created_at: string, reason?: string }>>}
 */
async function listGateEvents(projectRoot, issueId, options = {}) {
  const { driver, config } = await resolveGateKernel(projectRoot, options.deps);
  const rows = await driver.listKernelEvents(ISSUE_ENTITY_TYPE, issueId, {}, config);
  return (rows || [])
    .filter(row => typeof row.event_type === 'string' && row.event_type.startsWith('gate.'))
    .map(parseGateEvent);
}

/**
 * True iff a `gate.approved` event exists for this issue + gate.
 *
 * @param {string} projectRoot
 * @param {string} issueId
 * @param {string} gateId
 * @param {{ deps?: Object }} [options]
 * @returns {Promise<boolean>}
 */
async function isGateApproved(projectRoot, issueId, gateId, options = {}) {
  const events = await listGateEvents(projectRoot, issueId, options);
  return events.some(event => event.event_type === GATE_APPROVED_EVENT && event.gate === gateId);
}

module.exports = {
  GATE_APPROVED_EVENT,
  GATE_REJECTED_EVENT,
  GATE_EVENT_TYPES,
  gateIdempotencyKey,
  parseGateEvent,
  recordGateEvent,
  listGateEvents,
  isGateApproved,
};
