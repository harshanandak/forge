'use strict';

/**
 * `forge control <gate-id|rail-id> <mandatory|optional|permission>`
 * `forge control status [--json]`
 *
 * Tri-state control for the gate/rail CONFIG registry (`gate.*` / `rail.*`) —
 * this sets *declared* intent, NOT runtime enforcement. Setting a state writes
 * the SAME resolver-consumed field `forge gate` writes
 * (`workflow.gates.<id>.enabled`); there is deliberately NO parallel `controls:`
 * key, because a key the resolver never reads would be doubly-fake. The tri-state
 * is the vocabulary; `enabled` is the stored truth (state is derived at read
 * time). IMPORTANT: as of 2026-07-15 no runtime consumer denies on these flags —
 * real enforcement lives independently (lefthook TDD hook, fail-closed
 * validate/preflight, enforce-stage order+completion). See the guarantee matrix.
 *
 * For MCP servers / rules / skills it REFUSES with a clear "presence-only, not
 * enforceable" message pointing at docs/reference/control-plane-guarantees.md,
 * rather than pretend a control it cannot honor.
 *
 * `status` renders the all-surface read view with enforcement-locus badges
 * (724356ea) so the UI never implies enforcement a surface lacks.
 */

const path = require('node:path');
const { setConfigOverride } = require('../config-writer');
const { getDefaultRuntimeGraph, getResolvedRuntimeGraph } = require('../core/runtime-graph');
const {
  classifySurface,
  isControllable,
  describeControl,
  planControl,
  GUARANTEE_DOC,
} = require('../control-plane');

function usage() {
  return [
    'Usage: forge control <gate-id|rail-id> <mandatory|optional|permission>',
    '       forge control status [--json]',
    '',
    `Tri-state control for the gate/rail registry. These flags are DECLARED intent`,
    `— today no runtime consumer denies on them (see the guarantee matrix). MCP/`,
    `rules/skills are presence-only and refused — see ${GUARANTEE_DOC}.`,
  ].join('\n');
}

// The known toggleable set is gates PLUS unlocked rails — exactly the surface
// `forge gate` governs. Combined lookup because gate.* / rail.* namespaces are
// disjoint. Used to validate an id BEFORE writing (never mid-run).
function knownPrimitive(id) {
  const graph = getDefaultRuntimeGraph();
  return [...graph.gates, ...graph.rails].find(primitive => primitive.id === id);
}

function resolvedControls(projectRoot) {
  const graph = getResolvedRuntimeGraph({ projectRoot });
  return [...graph.gates, ...graph.rails].map(describeControl);
}

function renderStatus(records) {
  const lines = ['Control plane — enforcement-locus per surface (honest to today wiring):', ''];
  for (const rec of records) {
    const state = rec.state ? ` [${rec.state}]` : '';
    lines.push(`- ${rec.id}${state}  ${rec.badge}  (${rec.locus})`);
  }
  lines.push('');
  lines.push(`No flag above is a wired runtime deny yet: real enforcement lives in`);
  lines.push(`the lefthook TDD hook, fail-closed validate/preflight, and enforce-stage`);
  lines.push(`order+completion — all independent of these flags. MCP/rules/skills are`);
  lines.push(`presence-only (advisory) and not controllable here. See ${GUARANTEE_DOC}.`);
  return `${lines.join('\n')}\n`;
}

function statusCommand(projectRoot, json) {
  const records = resolvedControls(projectRoot);
  if (json) {
    return { success: true, output: `${JSON.stringify({ items: records }, null, 2)}\n` };
  }
  return { success: true, output: renderStatus(records) };
}

function setCommand(id, state, projectRoot) {
  // Advisory surfaces (and unknown namespaces) are refused up front with the
  // guarantee-matrix pointer — nothing is written.
  if (!isControllable(id)) {
    const plan = planControl({ id }, state);
    return { success: false, error: plan.error };
  }

  // Validate the id is a real primitive BEFORE writing (mirrors `forge gate`).
  const primitive = knownPrimitive(id);
  if (!primitive) {
    return {
      success: false,
      error: `Unknown ${classifySurface(id)} '${id}'. Run 'forge control status' to list controllable surfaces.`,
    };
  }

  const plan = planControl({ id, locked: primitive.locked === true }, state);
  if (!plan.ok) {
    return { success: false, error: plan.error };
  }

  const { configPath } = setConfigOverride(
    projectRoot,
    ['workflow', 'gates', id, 'enabled'],
    plan.enabled,
  );
  const where = path.relative(projectRoot, configPath) || configPath;
  return {
    success: true,
    output: `set '${id}' to ${state} (workflow.gates.${id}.enabled=${plan.enabled}) in ${where}`,
  };
}

async function handler(args, flags = {}, projectRoot = process.cwd()) {
  const [first, second] = args;

  if (first === 'status') {
    // Reject junk after `status` (only the optional --json flag is allowed) so a
    // typo like `forge control status enabled` errors instead of silently
    // ignoring the extra token.
    const extra = args.slice(1).filter(arg => arg !== '--json');
    if (extra.length > 0) {
      return {
        success: false,
        error: `Unexpected argument(s) for status: ${extra.join(', ')}.\n${usage()}`,
      };
    }
    return statusCommand(projectRoot, flags.json === true || args.includes('--json'));
  }

  if (!first) {
    return { success: false, error: usage() };
  }
  if (!second) {
    return { success: false, error: `Missing state.\n${usage()}` };
  }

  return setCommand(first, second, projectRoot);
}

module.exports = {
  name: 'control',
  description: 'Set tri-state control (mandatory/optional/permission) for a gate or rail',
  usage: usage(),
  handler,
};
