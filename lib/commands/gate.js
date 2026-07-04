'use strict';

/**
 * `forge gate <enable|disable> <gate-id>`
 *
 * Thin TOGGLE verb over the sparse config writer: sets
 * `workflow.gates.<gate-id>.enabled` true/false in `.forge/config.yaml`. The
 * shipped resolver (`applyEnabledConfig`) already consumes this field, so
 * `forge options gates --json` reflects the flip with zero new read code.
 *
 * Write-time validation: an unknown gate id (or a locked gate being disabled)
 * errors BEFORE anything is written — never mid-run.
 *
 * NOTE: `gate approve` (gates-as-events) is intentionally NOT implemented here.
 */

const path = require('node:path');
const { setConfigOverride } = require('../config-writer');
const { getDefaultRuntimeGraph } = require('../core/runtime-graph');

function usage() {
  return 'Usage: forge gate <enable|disable> <gate-id>';
}

function knownGates() {
  return new Map(getDefaultRuntimeGraph().gates.map(gate => [gate.id, gate]));
}

async function handler(args, _flags, projectRoot = process.cwd()) {
  const [action, gateId] = args;

  if (!action || (action !== 'enable' && action !== 'disable')) {
    return { success: false, error: `Expected 'enable' or 'disable'.\n${usage()}` };
  }
  if (!gateId) {
    return { success: false, error: `Missing gate id.\n${usage()}` };
  }

  const gates = knownGates();
  const gate = gates.get(gateId);
  if (!gate) {
    return {
      success: false,
      error: `Unknown gate '${gateId}'. Known gates: ${[...gates.keys()].join(', ')}`,
    };
  }
  if (action === 'disable' && gate.locked === true) {
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

module.exports = {
  name: 'gate',
  description: 'Enable or disable a workflow gate in .forge/config.yaml',
  usage: usage(),
  handler,
};
