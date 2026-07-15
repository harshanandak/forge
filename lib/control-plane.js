'use strict';

/**
 * @module control-plane
 *
 * The single source of truth for the **control-plane guarantee matrix**
 * (docs/reference/control-plane-guarantees.md): it classifies each control
 * surface, names its enforcement-locus, derives the tri-state label, renders the
 * honest read badge, and resolves a `forge control` write-intent into the ONE
 * resolver-enforced field — `workflow.gates.<id>.enabled`.
 *
 * Why this module exists: the cockpit uses a tri-state vocabulary
 * (`mandatory` / `optional` / `permission`), but that vocabulary is only
 * meaningful where Forge can actually DENY at run time — on gates and rails. On
 * MCP servers, rules, and skills there is no run-time deny; "mandatory" there
 * would mean nothing more than *the file is present*. This module draws that
 * line so the UI and the `forge control` command never sell enforcement Forge
 * cannot deliver. Pure + dependency-free so it is trivially testable and shared
 * by the command, `forge options`, and any dashboard snapshot.
 */

/** The closed set of human gates — satisfied by a `gate.approved` kernel EVENT. */
const HUMAN_GATE_IDS = new Set(['gate.intent', 'gate.plan-approval', 'gate.merge']);

const CONTROLLABLE_SURFACES = new Set(['gate', 'human-gate', 'rail']);

const GUARANTEE_DOC = 'docs/reference/control-plane-guarantees.md';

const VALID_STATES = new Set(['mandatory', 'optional', 'permission']);

/**
 * Classify a control id into its surface. The id namespaces are disjoint, so a
 * prefix match is unambiguous; the three human gates are singled out because
 * their enforcement-locus (a human approval event) differs from ordinary gates.
 *
 * @param {string} id
 * @returns {'gate'|'human-gate'|'rail'|'mcp'|'rule'|'skill'|'unknown'}
 */
function classifySurface(id) {
  if (typeof id !== 'string') return 'unknown';
  if (HUMAN_GATE_IDS.has(id)) return 'human-gate';
  if (id.startsWith('gate.')) return 'gate';
  if (id.startsWith('rail.')) return 'rail';
  if (id.startsWith('mcp.')) return 'mcp';
  if (id.startsWith('rule.')) return 'rule';
  if (id.startsWith('skill.')) return 'skill';
  return 'unknown';
}

/** True only for surfaces Forge can deny at run time (gates + rails). */
function isControllable(id) {
  return CONTROLLABLE_SURFACES.has(classifySurface(id));
}

/**
 * The honest enforcement-locus — WHERE and WHETHER Forge actually consumes this
 * flag TODAY (as of 2026-07-15). This deliberately does NOT claim `run-time-deny`
 * for the configurable gates/rails, because an adversarial grep of every consumer
 * of the resolved graph found NONE that denies on `workflow.gates.<id>.enabled`:
 *
 *  - stage-exit gates + rails: no runtime consumer reads their `.enabled` to
 *    refuse. `enforce-stage.js` enforces stage ORDER + kernel COMPLETION, which
 *    is independent of these flags. → "registry — declared, not yet enforced".
 *  - `gate.issue_verify`: consumed by lib/commands/_issue.js, but WARN-ONLY —
 *    a mismatch prints a warning and never overturns the write's `ok`.
 *  - human gates: the `forge gate approve`/`check` primitives are real and
 *    deny-CAPABLE, but no chokepoint auto-invokes `forge gate check`, so nothing
 *    denies on them yet. → "deny-on-check (no chokepoint yet)".
 *
 * Real enforcement today lives elsewhere and is independent of these flags: the
 * B3 lefthook TDD pre-commit hook, B2 fail-closed `validate`/`preflight`, and
 * `enforce-stage` order+completion. See docs/reference/control-plane-guarantees.md.
 *
 * @param {string} id
 */
function enforcementLocus(id) {
  const surface = classifySurface(id);
  if (surface === 'human-gate') {
    return 'deny-on-check (deny-capable via forge gate check; no chokepoint invokes it yet)';
  }
  if (id === 'gate.issue_verify') {
    return 'run-time verify (warn-only, never denies)';
  }
  if (surface === 'gate' || surface === 'rail') {
    return 'registry — declared, not yet enforced';
  }
  // mcp / rule / skill / unknown — presence written into harness config only.
  return 'render-time presence-only';
}

/**
 * Derive the tri-state label from the resolver-enforced fields, so state is
 * never stored twice (single source of truth = `enabled`).
 *
 * @param {{id: string, enabled?: boolean}} primitive
 * @returns {'mandatory'|'optional'|'permission'|null} null for advisory surfaces.
 */
function deriveState(primitive) {
  const surface = classifySurface(primitive.id);
  if (!CONTROLLABLE_SURFACES.has(surface)) return null;
  const enabled = primitive.enabled !== false;
  if (surface === 'human-gate') return enabled ? 'permission' : 'optional';
  return enabled ? 'mandatory' : 'optional';
}

/**
 * The read-view badge: reflects the HONEST wiring status TODAY, never the
 * author's intent, so the UI can never imply enforcement a surface lacks.
 * `ENFORCED` is reserved strictly for a wired runtime deny — a set that is
 * EMPTY today for these configurable flags, so this function never returns it.
 * A `locked` primitive appends a `LOCKED` marker (it cannot be lowered).
 *
 * @param {{id: string, enabled?: boolean, locked?: boolean}} primitive
 * @returns {string}
 */
function badgeFor(primitive) {
  const surface = classifySurface(primitive.id);
  if (!CONTROLLABLE_SURFACES.has(surface)) return 'PRESENT (advisory)';

  const enabled = primitive.enabled !== false;
  let badge;
  if (!enabled) {
    badge = 'OFF (optional)';
  } else if (surface === 'human-gate') {
    // Deny-capable via `forge gate check`, but no chokepoint invokes it yet.
    badge = 'DENY-ON-CHECK';
  } else if (primitive.id === 'gate.issue_verify') {
    // Consumed by _issue.js, but warn-only — never overturns a write.
    badge = 'VERIFY (warn-only)';
  } else {
    // stage-exit gates + rails: declared in the registry, no runtime consumer.
    badge = 'DECLARED (no runtime consumer yet)';
  }
  return primitive.locked === true ? `${badge} · LOCKED` : badge;
}

/**
 * The full read record for a primitive — everything a read view / badge needs.
 *
 * @param {{id: string, enabled?: boolean, locked?: boolean}} primitive
 */
function describeControl(primitive) {
  const surface = classifySurface(primitive.id);
  return {
    id: primitive.id,
    surface,
    controllable: CONTROLLABLE_SURFACES.has(surface),
    state: deriveState(primitive),
    locus: enforcementLocus(primitive.id),
    badge: badgeFor(primitive),
    locked: primitive.locked === true,
  };
}

/**
 * Resolve a `forge control <id> <state>` write-intent into the enabled boolean
 * for `workflow.gates.<id>.enabled` — or an honest refusal. This is the guard
 * that keeps the tri-state vocabulary from over-promising:
 *
 *  - advisory surfaces (mcp/rule/skill/unknown) → refused (presence-only).
 *  - `permission` is valid ONLY for human gates; elsewhere it has no path.
 *  - `mandatory` on a human gate → refused, directed to `permission`.
 *  - `optional` on a `locked` primitive → refused (cannot be lowered).
 *
 * @param {{id: string, locked?: boolean}} primitive
 * @param {string} state - requested tri-state
 * @returns {{ok: true, enabled: boolean}|{ok: false, error: string}}
 */
function planControl(primitive, state) {
  const surface = classifySurface(primitive.id);

  if (!CONTROLLABLE_SURFACES.has(surface)) {
    return {
      ok: false,
      error: `${primitive.id} is presence-only, not enforceable — Forge has no `
        + `run-time deny for this surface. It stays read-only in the cockpit `
        + `(badge PRESENT (advisory)). See ${GUARANTEE_DOC}.`,
    };
  }

  if (!VALID_STATES.has(state)) {
    return {
      ok: false,
      error: `Unknown state '${state}'. Use one of: mandatory, optional, permission.`,
    };
  }

  const isHuman = surface === 'human-gate';

  if (state === 'permission' && !isHuman) {
    return {
      ok: false,
      error: `'permission' applies only to a human gate `
        + `(${[...HUMAN_GATE_IDS].join(', ')}); ${primitive.id} enforces evidence, `
        + `not approval. Use 'mandatory' or 'optional'. See ${GUARANTEE_DOC}.`,
    };
  }

  if (state === 'mandatory' && isHuman) {
    return {
      ok: false,
      error: `${primitive.id} is a human gate — it blocks until a human approval `
        + `event, so use 'permission' (not 'mandatory'). See ${GUARANTEE_DOC}.`,
    };
  }

  if (state === 'optional' && primitive.locked === true) {
    return {
      ok: false,
      error: `Cannot lower locked ${surface} '${primitive.id}' to optional.`,
    };
  }

  // mandatory / permission → enabled; optional → disabled. Written to the ONE
  // field the resolver honors, so enforcement is genuine.
  return { ok: true, enabled: state !== 'optional' };
}

module.exports = {
  HUMAN_GATE_IDS,
  GUARANTEE_DOC,
  classifySurface,
  isControllable,
  enforcementLocus,
  deriveState,
  badgeFor,
  describeControl,
  planControl,
};
