'use strict';

/**
 * @module grounding/context-events
 *
 * The state primitive behind gate.read_first: "this issue's context was loaded"
 * recorded as a durable kernel EVENT, structurally identical to gate.approved
 * (lib/gate-events.js). `forge recap`/`forge show` append a `context.loaded`
 * event to the issue's stream on a successful render; `forge claim` refuses to
 * proceed until such an event exists for the issue this session/window.
 *
 * Mechanism (mirrors gate-events, deliberately): a PURE APPEND via the driver
 * primitives (`insertKernelEvent` + `listKernelEvents`), NOT the guarded
 * issue-mutation pipeline — context.loaded does not mutate the issue, so it must
 * not participate in the issue-revision CAS. Idempotency is enforced by a
 * window-bucketed key (so a re-read inside the freshness window mints no
 * duplicate, but a re-read in the NEXT window mints a fresh event that clears a
 * re-block) plus the unique idempotency index catching a concurrent race.
 *
 * Config-surface note: whether the gate is enabled lives in the runtime graph +
 * `.forge/config.yaml`; this module only records/reads the events.
 */

const { buildMigratedKernelIssueDeps } = require('../kernel/cli-broker-factory');
const { resolveIssueActor } = require('../forge-issues');

const CONTEXT_LOADED_EVENT = 'context.loaded';
const ISSUE_ENTITY_TYPE = 'issue';
const CONTEXT_EVENT_ORIGIN = 'cli';
// Tier-2 agnostic freshness floor: a stale-but-loaded issue re-blocks after this
// window; one `forge recap` clears it. Overridable via
// `workflow.gates.gate.read_first.window` at the call site (P2).
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve the kernel driver + config. Tests inject a shared, already-migrated
 * kernel via `deps`; the CLI path builds a fresh one for the short-lived process
 * (same shape as gate-events' resolveGateKernel).
 */
async function resolveGroundingKernel(projectRoot, deps = {}) {
  if (deps.kernelBroker && deps.kernelDriver) {
    return { broker: deps.kernelBroker, driver: deps.kernelDriver, config: deps.kernelBroker.config };
  }
  const built = await buildMigratedKernelIssueDeps({ projectRoot });
  return { broker: built.kernelBroker, driver: built.kernelDriver, config: built.kernelBroker.config };
}

/** Coarse window bucket for a timestamp — the roll-over that makes re-reads fresh. */
function windowBucket(nowMs, windowMs) {
  return Math.floor(nowMs / windowMs);
}

/**
 * Idempotency key for a context.loaded event. Scoped to issue + scope
 * (session id when present, else actor) + window bucket so a re-read inside the
 * window is idempotent, while the next window mints a fresh event.
 */
function contextLoadedIdempotencyKey(issueId, scope, bucket) {
  return `${CONTEXT_LOADED_EVENT}:${issueId}:${scope}:${bucket}`;
}

/** Shape a stored kernel_events row into the context-event view callers consume. */
function parseContextEvent(row) {
  let payload;
  try {
    payload = row.payload_json ? JSON.parse(row.payload_json) : {};
  } catch {
    payload = {};
  }
  const view = {
    event_type: row.event_type,
    actor: row.actor,
    created_at: row.created_at,
  };
  if (payload.session !== undefined) view.session = payload.session;
  if (payload.cmd !== undefined) view.cmd = payload.cmd;
  if (payload.budget !== undefined) view.budget = payload.budget;
  return view;
}

function isIdempotencyRace(error) {
  const message = error && error.message ? String(error.message) : '';
  return /UNIQUE constraint failed/i.test(message) && /idempotency_key/i.test(message);
}

/**
 * Record that an issue's context was loaded. Idempotent per issue+scope+window.
 * Validates the issue exists (no orphan events).
 *
 * @param {string} projectRoot
 * @param {Object} params
 * @param {string} params.issueId
 * @param {string} [params.cmd] - the command that loaded the context (recap|show).
 * @param {string} [params.session] - harness session id (Tier-1 scoping) when known.
 * @param {number|string} [params.budget]
 * @param {Object} [params.env] - env source for actor resolution.
 * @param {Object} [params.deps] - injected { kernelBroker, kernelDriver }.
 * @param {string} [params.now] - ISO timestamp (defaults to now).
 * @param {number} [params.windowMs] - freshness window (defaults to 24h).
 * @returns {Promise<{ ok: boolean, duplicate?: boolean, issueMissing?: boolean, event?: Object, actor?: string }>}
 */
async function recordContextLoaded(projectRoot, params = {}) {
  const { issueId, cmd, session, budget, env, deps, now, windowMs } = params;
  const actor = resolveIssueActor(env || process.env) || 'forge';
  const { driver, config } = await resolveGroundingKernel(projectRoot, deps);

  const entity = await driver.loadKernelEntity(ISSUE_ENTITY_TYPE, issueId, {}, config);
  if (!entity) {
    return { ok: false, issueMissing: true, actor };
  }

  const nowIso = now || new Date().toISOString();
  const win = Number.isFinite(windowMs) ? windowMs : DEFAULT_WINDOW_MS;
  const bucket = windowBucket(Date.parse(nowIso), win);
  const scope = session || actor;
  const idempotencyKey = contextLoadedIdempotencyKey(issueId, scope, bucket);

  const existing = await driver.loadKernelEventByIdempotencyKey(idempotencyKey, {}, config);
  if (existing) {
    return { ok: true, duplicate: true, event: parseContextEvent(existing), actor };
  }

  const payload = { actor };
  if (typeof session === 'string' && session.length > 0) payload.session = session;
  if (typeof cmd === 'string' && cmd.length > 0) payload.cmd = cmd;
  if (budget !== undefined) payload.budget = budget;

  const event = {
    entity_type: ISSUE_ENTITY_TYPE,
    entity_id: issueId,
    event_type: CONTEXT_LOADED_EVENT,
    idempotency_key: idempotencyKey,
    expected_revision: 0,
    actor,
    origin: CONTEXT_EVENT_ORIGIN,
    payload,
    created_at: nowIso,
  };

  try {
    const inserted = await driver.insertKernelEvent(event, {}, config);
    return { ok: true, duplicate: false, event: parseContextEvent(inserted), actor };
  } catch (error) {
    if (isIdempotencyRace(error)) {
      const winner = await driver.loadKernelEventByIdempotencyKey(idempotencyKey, {}, config);
      return { ok: true, duplicate: true, event: winner ? parseContextEvent(winner) : parseContextEvent(event), actor };
    }
    throw error;
  }
}

/**
 * List every context.loaded event on an issue, oldest first.
 *
 * @returns {Promise<Array<{ event_type: string, actor: string, created_at: string, session?: string, cmd?: string }>>}
 */
async function listContextLoadedEvents(projectRoot, issueId, options = {}) {
  const { driver, config } = await resolveGroundingKernel(projectRoot, options.deps);
  const rows = await driver.listKernelEvents(ISSUE_ENTITY_TYPE, issueId, {}, config);
  return (rows || [])
    .filter(row => row.event_type === CONTEXT_LOADED_EVENT)
    .map(parseContextEvent);
}

/**
 * True iff the issue has a context.loaded event that satisfies scoping:
 * - Tier-1 (session given): an event stamped with the SAME session.
 * - Tier-2 (no session): an event newer than the freshness window.
 *
 * @param {string} projectRoot
 * @param {string} issueId
 * @param {{ session?: string, windowMs?: number, now?: string, deps?: Object }} [options]
 * @returns {Promise<boolean>}
 */
async function hasFreshContextLoaded(projectRoot, issueId, options = {}) {
  const { session, windowMs, now, deps } = options;
  const events = await listContextLoadedEvents(projectRoot, issueId, { deps });
  return eventsSatisfyFreshness(events, { session, windowMs, now });
}

/** Shared freshness predicate over an already-listed event set. */
function eventsSatisfyFreshness(events, { session, windowMs, now } = {}) {
  if (!events || events.length === 0) return false;
  if (typeof session === 'string' && session.length > 0) {
    return events.some(event => event.session === session);
  }
  const nowMs = now ? Date.parse(now) : Date.now();
  const win = Number.isFinite(windowMs) ? windowMs : DEFAULT_WINDOW_MS;
  return events.some(event => {
    const ts = Date.parse(event.created_at);
    return Number.isFinite(ts) && (nowMs - ts) <= win;
  });
}

/**
 * The gate.read_first verdict for an issue, resolving the kernel ONCE:
 * - 'missing': the issue does not exist in the consulted kernel. The gate is
 *   INERT — grounding a phantom issue is meaningless and the real claim will
 *   fail on its own; this is also what keeps unit doubles (fake runner, no real
 *   store) from being false-blocked. No bypass for a REAL issue: a claim on a
 *   non-existent issue fails regardless.
 * - 'loaded': a context.loaded event satisfies session/window scoping -> allow.
 * - 'unread': the issue exists but has no fresh context.loaded event -> BLOCK.
 *
 * @returns {Promise<'missing'|'loaded'|'unread'>}
 */
async function readFirstVerdict(projectRoot, issueId, options = {}) {
  const { session, windowMs, now, deps } = options;
  const { driver, config } = await resolveGroundingKernel(projectRoot, deps);
  const entity = await driver.loadKernelEntity(ISSUE_ENTITY_TYPE, issueId, {}, config);
  if (!entity) return 'missing';
  const rows = await driver.listKernelEvents(ISSUE_ENTITY_TYPE, issueId, {}, config);
  const events = (rows || []).filter(row => row.event_type === CONTEXT_LOADED_EVENT).map(parseContextEvent);
  return eventsSatisfyFreshness(events, { session, windowMs, now }) ? 'loaded' : 'unread';
}

module.exports = {
  CONTEXT_LOADED_EVENT,
  DEFAULT_WINDOW_MS,
  contextLoadedIdempotencyKey,
  parseContextEvent,
  recordContextLoaded,
  listContextLoadedEvents,
  hasFreshContextLoaded,
  readFirstVerdict,
};
