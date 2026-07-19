const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');

const {
  getResolvedRuntimeGraph,
  lintRuntimeGraphConfig,
  resolveRuntimeGraph,
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
  secret_scan:
    enabled: false
`);

    expect(() => getResolvedRuntimeGraph({ projectRoot })).toThrow('locked L1 rail');
  });

  test('allows disabling the unlocked tdd_intent rail (strong default, not a floor)', () => {
    // rail.tdd_intent was reclassified from a locked L1 floor to a default-ON
    // toggleable rail (issue eda6d866) so progressive setup can honestly turn
    // TDD enforcement off. Both config surfaces must accept the disable.
    const viaRails = makeProject(`
rails:
  tdd_intent:
    enabled: false
`);
    const railGraph = getResolvedRuntimeGraph({ projectRoot: viaRails });
    expect(railGraph.rails.find(rail => rail.id === 'rail.tdd_intent').enabled).toBe(false);

    const viaGates = makeProject(`
workflow:
  gates:
    "rail.tdd_intent":
      enabled: false
`);
    const gateGraph = getResolvedRuntimeGraph({ projectRoot: viaGates });
    expect(gateGraph.rails.find(rail => rail.id === 'rail.tdd_intent').enabled).toBe(false);
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
    const nullRoot = makeProject('null');

    for (const projectRoot of [scalarRoot, arrayRoot, nullRoot]) {
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

  test('rejects null workflow primitive config entries', () => {
    const projectRoot = makeProject(`
workflow:
  gates:
    gate.ship-entry: null
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

  test('exposes configurable planning template defaults in the resolved graph', () => {
    const graph = getResolvedRuntimeGraph({ projectRoot: makeProject(null) });

    expect(graph.planning.template.mode).toBe('full');
    expect(graph.planning.template.criticSet).toEqual(['spec', 'risk', 'test']);
    expect(graph.planning.subSkills.map(skill => skill.id)).toEqual([
      'plan.intent_capture',
      'plan.parallel_research',
      'plan.parallel_critics',
      'plan.synthesis',
      'plan.final_lock',
    ]);
    expect(graph.primitives.PlanningSubSkill).toBe('planning.subSkills');
    expect(graph.phases.find(phase => phase.id === 'plan').actions).toEqual([
      'action.plan.intent_capture',
      'action.plan.parallel_research',
      'action.plan.parallel_critics',
      'action.plan.synthesis',
      'action.plan.final_lock',
    ]);
    expect(graph.actions.find(action => action.id === 'action.plan.intent_capture')).toBeTruthy();
  });

  test('loads planning template configuration from .forge/config.yaml', () => {
    const projectRoot = makeProject(`
planning:
  template:
    mode: partial
    convergenceThreshold: 0.82
    criticSet:
      - spec
      - security
    partialInvocation:
      only:
        - plan.parallel_critics
      skip:
        - plan.parallel_research
`);

    const graph = getResolvedRuntimeGraph({ projectRoot });

    expect(graph.planning.template.mode).toBe('partial');
    expect(graph.planning.template.convergenceThreshold).toBe(0.82);
    expect(graph.planning.template.criticSet).toEqual(['spec', 'security']);
    expect(graph.planning.template.partialInvocation.only).toEqual(['plan.parallel_critics']);
    expect(graph.planning.template.partialInvocation.skip).toEqual(['plan.parallel_research']);
    expect(graph.planning.template.configSource).toBe('.forge/config.yaml');
  });

  test('rejects invalid planning template configuration', () => {
    const projectRoot = makeProject(`
planning:
  template:
    mode: all-at-once
    convergenceThreshold: .nan
    criticSet:
      - ""
    partialInvocation:
      only:
        - plan.nope
`);

    const result = lintRuntimeGraphConfig({ projectRoot });

    expect(result.ok).toBe(false);
    expect(result.errors.map(error => error.code)).toContain('INVALID_PLANNING_MODE');
    expect(result.errors.map(error => error.code)).toContain('INVALID_CONVERGENCE_THRESHOLD');
    expect(result.errors.map(error => error.code)).toContain('INVALID_CRITIC');
    expect(result.errors.map(error => error.code)).toContain('UNKNOWN_PLAN_SUBSKILL');
  });

  test('fails closed when planning template partial invocation contains unknown subskills', () => {
    const projectRoot = makeProject(`
planning:
  template:
    partialInvocation:
      only:
        - plan.intent_capture
        - plan.nope
      skip:
        - plan.final_lock
`);

    const { graph } = resolveRuntimeGraph({ projectRoot, throwOnError: false });

    expect(graph.planning.template.partialInvocation.only).toEqual([]);
    expect(graph.planning.template.partialInvocation.skip).toEqual(['plan.final_lock']);
  });

  // Guards the W2 registry split: `research` is a COMPOSED whole-skill of plan
  // (its SKILL.md subskills), NOT a partialInvocation micro-phase. partialInvocation
  // maps ids to runtime-graph plan.* actions, so accepting `research` here would be
  // silent dead config. It must fail closed.
  test('rejects a composed whole-skill (research) in planning template partial invocation', () => {
    const projectRoot = makeProject(`
planning:
  template:
    partialInvocation:
      only:
        - research
`);

    const result = lintRuntimeGraphConfig({ projectRoot });

    expect(result.ok).toBe(false);
    expect(result.errors.map(error => error.code)).toContain('UNKNOWN_PLAN_SUBSKILL');

    const { graph } = resolveRuntimeGraph({ projectRoot, throwOnError: false });
    // Dead config dropped — never mapped into the runtime graph.
    expect(graph.planning.template.partialInvocation.only).toEqual([]);
  });
});
