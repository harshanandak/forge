const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');

const {
  getResolvedRuntimeGraph,
  lintRuntimeGraphConfig,
} = require('../lib/core/runtime-graph');

const tempRoots = [];

function makeProject(configBody) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-graph-config-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  if (configBody !== null) {
    fs.writeFileSync(path.join(root, '.forge', 'config.yaml'), configBody);
  }
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('runtime graph config resolution', () => {
  test('loads .forge/config.yaml and preserves disabled primitives with provenance', () => {
    const projectRoot = makeProject(`
workflow:
  gates:
    gate.ship-entry:
      enabled: false
adapters:
  issue:
    primary: github
`);

    const graph = getResolvedRuntimeGraph({ projectRoot });
    const shipGate = graph.gates.find(gate => gate.id === 'gate.ship-entry');

    expect(shipGate.enabled).toBe(false);
    expect(shipGate.disabled).toBe(true);
    expect(shipGate.configSource).toBe('.forge/config.yaml');
    expect(graph.adapters.find(adapter => adapter.id === 'adapter.issue').config.primary).toBe('github');
  });

  test('loads adapter enabled state separately from adapter config', () => {
    const projectRoot = makeProject(`
adapters:
  issue:
    enabled: false
    primary: github
`);

    const graph = getResolvedRuntimeGraph({ projectRoot });
    const issueAdapter = graph.adapters.find(adapter => adapter.id === 'adapter.issue');

    expect(issueAdapter.enabled).toBe(false);
    expect(issueAdapter.disabled).toBe(true);
    expect(issueAdapter.configSource).toBe('.forge/config.yaml');
    expect(issueAdapter.config.primary).toBe('github');
    expect(issueAdapter.config.enabled).toBeUndefined();
  });

  test('rejects config that disables a locked L1 rail', () => {
    const projectRoot = makeProject(`
rails:
  tdd_intent:
    enabled: false
`);

    expect(() => getResolvedRuntimeGraph({ projectRoot })).toThrow('locked L1 rail');
  });

  test('reports malformed YAML and unknown primitive IDs during config lint', () => {
    const malformedRoot = makeProject('workflow: [');
    const unknownRoot = makeProject(`
workflow:
  gates:
    gate.nope:
      enabled: false
`);

    expect(lintRuntimeGraphConfig({ projectRoot: malformedRoot }).ok).toBe(false);
    const result = lintRuntimeGraphConfig({ projectRoot: unknownRoot });
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toContain('Unknown gate');
  });

  test('rejects non-object top-level config roots', () => {
    const scalarRoot = makeProject('false');
    const arrayRoot = makeProject('[]');

    for (const projectRoot of [scalarRoot, arrayRoot]) {
      const result = lintRuntimeGraphConfig({ projectRoot });

      expect(result.ok).toBe(false);
      expect(result.errors[0].code).toBe('CONFIG_ROOT_INVALID');
      expect(result.errors[0].message).toContain('root must be an object');
    }
  });

  test('rejects non-boolean enabled values in workflow config', () => {
    const projectRoot = makeProject(`
workflow:
  gates:
    gate.ship-entry:
      enabled: "false"
`);

    const result = lintRuntimeGraphConfig({ projectRoot });

    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_ENABLED_VALUE');
    expect(result.errors[0].message).toContain('enabled must be a boolean');
  });

  test('rejects scalar workflow primitive config entries', () => {
    const projectRoot = makeProject(`
workflow:
  gates:
    gate.ship-entry: false
`);

    const result = lintRuntimeGraphConfig({ projectRoot });

    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_PRIMITIVE_CONFIG');
    expect(result.errors[0].message).toContain('config must be an object');
  });

  test('rejects scalar workflow section config entries', () => {
    const projectRoot = makeProject(`
workflow:
  gates: false
`);

    const result = lintRuntimeGraphConfig({ projectRoot });

    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_CONFIG_SECTION');
    expect(result.errors[0].message).toContain('workflow.gates must be an object');
  });

  test('rejects scalar adapter config entries', () => {
    const projectRoot = makeProject(`
adapters:
  issue: false
`);

    const result = lintRuntimeGraphConfig({ projectRoot });

    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_ADAPTER_CONFIG');
    expect(result.errors[0].message).toContain("adapter 'issue' config must be an object");
  });

  test('rejects non-boolean enabled values in adapter config', () => {
    const projectRoot = makeProject(`
adapters:
  issue:
    enabled: "false"
`);

    const result = lintRuntimeGraphConfig({ projectRoot });

    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_ENABLED_VALUE');
    expect(result.errors[0].message).toContain("adapter 'issue' enabled must be a boolean");
  });

  test('validates protected path policy entries', () => {
    const projectRoot = makeProject(`
protectedPaths:
  - "**/*"
  - 42
`);

    const result = lintRuntimeGraphConfig({ projectRoot });

    expect(result.ok).toBe(false);
    expect(result.errors.map(error => error.code)).toContain('PROTECTED_PATH_TOO_BROAD');
    expect(result.errors.map(error => error.code)).toContain('PROTECTED_PATH_INVALID');
  });
});
