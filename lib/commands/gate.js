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
  isGateApproved,
} = require('../gate-events');

// The doc-update gate folds under this noun as `gate doc` (P2, kernel issue
// 6ab3f30c) — it is a gate concern, not a `pr` one. `doc` delegates to the
// standalone doc-gate command (same code); bare `forge doc-gate` stays registered
// as a back-compat alias. Required lazily so the module graph has no cycle and the
// routed handler is resolved at dispatch time.
const docGate = require('./doc-gate');

const TOGGLE_ACTIONS = new Set(['enable', 'disable']);
const EVENT_ACTIONS = new Set(['approve', 'reject', 'status', 'check']);

function usage() {
  return 'Usage: forge gate <enable|disable|approve|reject|status|check> [<issue-id>] <gate-id> [--reason <text>] [--json]';
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

async function handleDecision(action, issueId, gateId, flags, projectRoot, opts) {
  if (!issueId || !gateId) {
    return { success: false, error: `Missing issue id or gate id.\n${usage()}` };
  }
  const known = validateKnownGate(gateId);
  if (!known.ok) return { success: false, error: known.error };

  const decision = action === 'approve' ? 'approved' : 'rejected';
  const reason = typeof flags.reason === 'string' ? flags.reason : undefined;
  const result = await recordGateEvent(projectRoot, {
    issueId,
    gateId,
    decision,
    reason,
    env: opts.env,
    deps: kernelDeps(opts),
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
    output: `${verb} gate '${gateId}' for ${issueId} (actor ${result.actor})${reasonNote}${suffix}`,
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
    return `${label} ${event.gate} by ${event.actor} at ${event.created_at}${reason}`;
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

  const approved = await isGateApproved(projectRoot, issueId, gateId, { deps: kernelDeps(opts) });
  if (approved) {
    return { success: true, output: `gate ${gateId} approved for ${issueId}` };
  }
  return { success: false, error: `gate ${gateId} not approved for ${issueId}` };
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
    return handleDecision(action, rest[0], rest[1], flags, projectRoot, opts);
  }

  return {
    success: false,
    error: `Expected 'enable', 'disable', 'approve', 'reject', 'status', or 'check'.\n${usage()}`,
  };
}

module.exports = {
  name: 'gate',
  description: 'Toggle a workflow gate, or record/query human-gate approval events',
  usage: usage(),
  handler,
};
