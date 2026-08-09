'use strict';

/**
 * `forge gate <enable|disable|approve|reject|status|check> ...`
 *
 * Two families over the same known-gate set:
 *
 *  TOGGLE (config surface): `enable|disable <gate-id>` set
 *  `workflow.gates.<gate-id>.enabled` true/false in `.forge/config.yaml`. The shipped
 *  resolver (`applyEnabledConfig`) already consumes this field, so `forge options
 *  gates --json` reflects the flip with zero new read code. Write-time validation:
 *  an unknown gate id (or a locked gate being disabled) errors BEFORE anything is
 *  written — never mid-run.
 *
 *  EVENTS (gates-as-kernel-events — Fable's insight): `approve|reject <issue> <gate>`
 *  record a durable `gate.approved` / `gate.rejected` event on the issue; `status`
 *  lists them (resume-safe after a compaction/crash); `check` exits 0 iff the gate is
 *  DISABLED or an approval event exists — the reusable enforcement primitive a stage
 *  skill calls. See lib/gate-events.js and docs/work/2026-07-04-kernel-native-skills/
 *  decisions.md.
 */

const path = require('node:path');
const { setConfigOverride } = require('../config-writer');
const { getDefaultRuntimeGraph, getResolvedRuntimeGraph } = require('../core/runtime-graph');
const {
  recordGateEvent,
  listGateEvents,
  evaluateGateApproval,
} = require('../gate-events');

// The doc-update gate folds under this noun as `gate doc` (P2, kernel issue
// 6ab3f30c) — it is a gate concern, not a `pr` one. `doc` delegates to the
// standalone doc-gate command (same code); bare `forge doc-gate` stays registered
// as a back-compat alias. Required lazily so the module graph has no cycle and the
// routed handler is resolved at dispatch time.
const docGate = require('./doc-gate');

const TOGGLE_ACTIONS = new Set(['enable', 'disable']);
const EVENT_ACTIONS = new Set(['approve', 'reject', 'status', 'check']);
const MAX_GATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function usage() {
  return [
    'Usage: forge gate <enable|disable|approve|reject|status|check> [<issue-id>] <gate-id> [--ttl <duration>] [--reason <text>] [--json]',
    '       forge gate doc <detect|check|init|okf|...> [args]   (doc-update gate; = forge doc-gate, run `forge doc-gate --help`)',
  ].join('\n');
}

function parseGateTtl(raw, issuedAt) {
  if (raw === undefined) return { ok: true, expiresAt: null, requestIdentity: null };
  const match = /^(\d+)(s|m|h|d)$/.exec(String(raw));
  if (!match) return { ok: false, error: 'TTL must be a positive duration such as 30s, 5m, 2h, or 1d.' };
  const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const ttlMs = Number(match[1]) * multipliers[match[2]];
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_GATE_TTL_MS) {
    return { ok: false, error: 'TTL must be greater than zero and no more than 30d.' };
  }
  const issuedMillis = Date.parse(issuedAt);
  if (!Number.isFinite(issuedMillis)) return { ok: false, error: 'Cannot issue a TTL approval without a valid clock.' };
  const expiresMillis = issuedMillis + ttlMs;
  if (!Number.isFinite(expiresMillis)) return { ok: false, error: 'TTL expiry is outside the supported date range.' };
  return {
    ok: true,
    expiresAt: new Date(expiresMillis).toISOString(),
    requestIdentity: `ttl-ms=${ttlMs}`,
  };
}

function parseDecisionInput(action, rawArgs, flags) {
  const issueId = rawArgs[0];
  const gateId = rawArgs[1];
  if (!issueId || !gateId || issueId.startsWith('--') || gateId.startsWith('--')) {
    return { ok: false, error: `Missing issue id or gate id.\n${usage()}` };
  }
  if (flags.project !== undefined || flags['--project'] !== undefined) {
    return { ok: false, error: 'Gate approvals are issue-scoped; --project is not supported.' };
  }

  let ttl = flags.ttl ?? flags['--ttl'];
  let reason = flags.reason ?? flags['--reason'];
  const seen = new Set();
  for (let index = 2; index < rawArgs.length; index += 1) {
    const token = rawArgs[index];
    if (token === '--json') continue;
    const match = /^(--ttl|--reason)(?:=(.*))?$/.exec(token);
    if (!match) {
      const kind = token.startsWith('--') ? 'Unknown flag' : 'Unexpected argument';
      return { ok: false, error: `${kind} '${token}'.\n${usage()}` };
    }
    const name = match[1].slice(2);
    if (seen.has(name)) return { ok: false, error: `Duplicate --${name} flag.` };
    seen.add(name);
    let value = match[2];
    if (value === undefined) {
      value = rawArgs[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return { ok: false, error: `--${name} requires a value.` };
      }
      index += 1;
    }
    if (name === 'ttl') ttl = value;
    if (name === 'reason') reason = value;
  }
  if (action !== 'approve' && ttl !== undefined) {
    return { ok: false, error: '--ttl is valid only for gate approval.' };
  }
  return { ok: true, issueId, gateId, ttl, reason };
}

// The known-toggle set is gates PLUS unlocked toggleable rails (e.g.
// rail.kernel_tracking): both are governed through the same `forge gate
// enable|disable` surface and the resolver's rail-aware workflow.gates loop.
// The gate.* / rail.* id namespaces are disjoint, so one flat map is unambiguous.
function knownGates() {
  const graph = getDefaultRuntimeGraph();
  return new Map([...graph.gates, ...graph.rails].map(primitive => [primitive.id, primitive]));
}

// Kernel deps + env are threaded through the command opts (4th handler arg) so tests
// and the orchestrator can inject a shared, already-migrated kernel.
function kernelDeps(opts = {}) {
  return { kernelBroker: opts.kernelBroker, kernelDriver: opts.kernelDriver };
}

function validateKnownGate(gateId) {
  const gates = knownGates();
  const gate = gates.get(gateId);
  if (!gate) {
    return {
      ok: false,
      error: `Unknown gate '${gateId}'. Known gates: ${[...gates.keys()].join(', ')}`,
    };
  }
  return { ok: true, gate };
}

function handleToggle(action, gateId, projectRoot) {
  if (!gateId) {
    return { success: false, error: `Missing gate id.\n${usage()}` };
  }
  const known = validateKnownGate(gateId);
  if (!known.ok) return { success: false, error: known.error };
  if (action === 'disable' && known.gate.locked === true) {
    return { success: false, error: `Cannot disable locked gate '${gateId}'.` };
  }

  const enabled = action === 'enable';
  const { configPath } = setConfigOverride(
    projectRoot,
    ['workflow', 'gates', gateId, 'enabled'],
    enabled,
  );
  const where = path.relative(projectRoot, configPath) || configPath;
  return {
    success: true,
    output: `${action}d gate '${gateId}' (workflow.gates.${gateId}.enabled=${enabled}) in ${where}`,
  };
}

async function handleDecision(action, issueId, gateId, flags, rawArgs, projectRoot, opts) {
  const input = parseDecisionInput(action, rawArgs, flags);
  if (!input.ok) return { success: false, error: input.error };
  issueId = input.issueId;
  gateId = input.gateId;
  const known = validateKnownGate(gateId);
  if (!known.ok) return { success: false, error: known.error };

  const decision = action === 'approve' ? 'approved' : 'rejected';
  const reason = typeof input.reason === 'string' ? input.reason : undefined;
  const issuedAt = opts.now || new Date().toISOString();
  const expiry = parseGateTtl(input.ttl, issuedAt);
  if (!expiry.ok) return { success: false, error: expiry.error };
  const result = await recordGateEvent(projectRoot, {
    issueId,
    gateId,
    decision,
    reason,
    expiresAt: expiry.expiresAt,
    requestIdentity: expiry.requestIdentity,
    env: opts.env,
    deps: kernelDeps(opts),
    now: issuedAt,
  });

  if (result.issueMissing) {
    return { success: false, error: `Issue '${issueId}' not found.` };
  }

  const verb = action === 'approve' ? 'approved' : 'rejected';
  const suffix = result.duplicate ? ' (already recorded)' : '';
  const reasonNote = reason ? ` — ${reason}` : '';
  return {
    success: true,
    duplicate: result.duplicate === true,
    actor: result.actor,
    event: result.event,
    output: `${verb} gate '${gateId}' for ${issueId} (control ${result.event.control_id}; actor ${result.actor}; issued ${result.event.issued_at}; expires ${result.event.expires_at || 'never'})${reasonNote}${suffix}`,
  };
}

async function handleStatus(issueId, flags, projectRoot, opts) {
  if (!issueId) {
    return { success: false, error: `Missing issue id.\n${usage()}` };
  }
  const events = await listGateEvents(projectRoot, issueId, { deps: kernelDeps(opts) });

  if (flags.json) {
    return { success: true, output: JSON.stringify({ issue: issueId, events }, null, 2) };
  }

  if (events.length === 0) {
    return { success: true, output: `No gate events for ${issueId}.` };
  }
  const lines = events.map(event => {
    const label = event.event_type === 'gate.approved' ? 'APPROVED' : 'REJECTED';
    const reason = event.reason ? ` — ${event.reason}` : '';
    return `${label} ${event.gate} for ${event.issue_id} (${event.control_id}) by ${event.actor} at ${event.issued_at}; expires ${event.expires_at || 'never'}${reason}`;
  });
  return { success: true, output: `Gate events for ${issueId}:\n${lines.join('\n')}` };
}

async function handleCheck(issueId, gateId, projectRoot, opts) {
  if (!issueId || !gateId) {
    return { success: false, error: `Missing issue id or gate id.\n${usage()}` };
  }
  const known = validateKnownGate(gateId);
  if (!known.ok) return { success: false, error: known.error };

  // Disabled gate/rail → satisfied without any approval event (read via the shipped
  // resolver). Rails share the workflow.gates toggle surface, so check both collections.
  const resolved = getResolvedRuntimeGraph({ projectRoot });
  const resolvedGate = [...resolved.gates, ...resolved.rails].find(gate => gate.id === gateId);
  if (resolvedGate && resolvedGate.enabled === false) {
    return { success: true, output: `gate ${gateId} is disabled — satisfied for ${issueId}` };
  }

  const events = await listGateEvents(projectRoot, issueId, { deps: kernelDeps(opts) });
  const decision = evaluateGateApproval(events, gateId, opts.now);
  const event = decision.event;
  if (decision.approved) {
    return {
      success: true,
      event,
      output: `gate ${gateId} approved for ${issueId} (control ${event.control_id}; actor ${event.actor}; decision ${event.decision}; issued ${event.issued_at}; expires ${event.expires_at || 'never'})`,
    };
  }
  const evidence = event
    ? ` (control ${event.control_id}; actor ${event.actor}; decision ${event.decision}; issued ${event.issued_at}; expires ${event.expires_at || 'never'})`
    : '';
  return { success: false, event, error: `gate ${gateId} not approved for ${issueId}${evidence}` };
}

async function handler(args, flags = {}, projectRoot = process.cwd(), opts = {}) {
  const [action, ...rest] = args;

  // `gate doc [<doc-gate sub> ...]` → the standalone doc-gate handler, with the
  // consumed `doc` token dropped so its own arg shape (detect/check/init/okf …)
  // and flags (`--base`/`--head`/`--json`/`--skip` …) reach it byte-identically.
  if (action === 'doc') {
    return docGate.handler(rest, flags, projectRoot, opts);
  }

  if (TOGGLE_ACTIONS.has(action)) {
    return handleToggle(action, rest[0], projectRoot);
  }
  if (EVENT_ACTIONS.has(action)) {
    if (action === 'status') {
      return handleStatus(rest[0], flags, projectRoot, opts);
    }
    if (action === 'check') {
      return handleCheck(rest[0], rest[1], projectRoot, opts);
    }
    return handleDecision(action, rest[0], rest[1], flags, rest, projectRoot, opts);
  }

  return {
    success: false,
    error: `Expected 'enable', 'disable', 'approve', 'reject', 'status', 'check', or 'doc'.\n${usage()}`,
  };
}

module.exports = {
  name: 'gate',
  description: 'Toggle a workflow gate, or record/query human-gate approval events',
  usage: usage(),
  handler,
  parseGateTtl,
  parseDecisionInput,
};
