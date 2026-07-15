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
 * The honest enforcement-locus for a surface kind — WHERE and WHETHER Forge
 * actually enforces it. Advisory surfaces resolve to render-time presence-only.
 */
function enforcementLocus(surface) {
  switch (surface) {
    case 'gate':
      return 'run-time-deny (gate)';
    case 'rail':
      return 'run-time-deny (rail)';
    case 'human-gate':
      return 'run-time-deny (permission)';
    default:
      // mcp / rule / skill / unknown — no run-time deny.
      return 'render-time presence-only';
  }
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
 * The read-view badge: reflects the enforcement-locus AND the current state, so
 * the UI can never imply enforcement a surface lacks. A `locked` primitive
 * appends a `LOCKED` marker (it cannot be lowered).
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
    badge = 'PERMISSION (human approval)';
  } else if (surface === 'rail') {
    badge = 'ENFORCED (rail)';
  } else {
    badge = 'ENFORCED (gate)';
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
    locus: enforcementLocus(surface),
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
