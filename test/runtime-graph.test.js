const fs = require('node:fs');
const path = require('node:path');
const { describe, expect, test } = require('bun:test');

const {
  RUNTIME_GRAPH_SCHEMA_VERSION,
  RUNTIME_GRAPH_SCHEMA,
  buildRuntimeGraphEnvelope,
  getResolvedRuntimeGraph,
} = require('../lib/core/runtime-graph');

describe('runtime graph contract', () => {
  test('publishes a versioned JSON schema envelope for runtime graph artifacts', () => {
    const envelope = buildRuntimeGraphEnvelope();

    expect(envelope.schemaVersion).toBe(RUNTIME_GRAPH_SCHEMA_VERSION);
    expect(envelope.kind).toBe('forge.runtimeGraph');
    expect(envelope.schema).toEqual(RUNTIME_GRAPH_SCHEMA);
    expect(envelope.graph).toEqual(getResolvedRuntimeGraph());
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
  });

  test('defines the required runtime graph primitives', () => {
    const graph = getResolvedRuntimeGraph();

    expect(graph.phases.length).toBeGreaterThanOrEqual(4);
    expect(graph.actions.length).toBeGreaterThanOrEqual(4);
    expect(graph.artifacts.length).toBeGreaterThanOrEqual(3);
    expect(graph.evaluatorRegions.length).toBeGreaterThanOrEqual(3);
    expect(graph.gates.length).toBeGreaterThanOrEqual(4);
    expect(graph.evidence.length).toBeGreaterThanOrEqual(4);

    expect(graph.primitives).toEqual({
      Phase: 'phases',
      Action: 'actions',
      Artifact: 'artifacts',
      EvaluatorRegion: 'evaluatorRegions',
      Gate: 'gates',
      Evidence: 'evidence',
    });
  });

  test('represents the current plan to ship command flow as a resolved graph', () => {
    const graph = getResolvedRuntimeGraph();
    const phaseIds = graph.phases.map(phase => phase.id);
    const commandActionIds = graph.actions
      .filter(action => action.kind === 'command')
      .map(action => action.command);

    expect(phaseIds).toEqual(['plan', 'dev', 'validate', 'ship']);
    expect(commandActionIds).toEqual(['plan', 'dev', 'validate', 'ship']);
    expect(graph.edges).toEqual([
      { from: 'phase.plan', to: 'phase.dev', reason: 'design and task list feed implementation' },
      { from: 'phase.dev', to: 'phase.validate', reason: 'implementation feeds validation' },
      { from: 'phase.validate', to: 'phase.ship', reason: 'validated branch can be shipped' },
    ]);
  });

  test('keeps graph command actions compatible with checked-in command docs', () => {
    const repoRoot = path.resolve(__dirname, '..');
    const graph = getResolvedRuntimeGraph();
    const commandActions = graph.actions.filter(action => action.kind === 'command');

    for (const action of commandActions) {
      const docPath = path.join(repoRoot, '.claude', 'commands', `${action.command}.md`);
      expect(fs.existsSync(docPath), `${action.id} should have ${docPath}`).toBe(true);
      const doc = fs.readFileSync(docPath, 'utf8');
      expect(doc).toContain(`/${action.command}`);
    }
  });

  test('does not make phase entry gates depend on artifacts produced by the same phase', () => {
    const graph = getResolvedRuntimeGraph();

    for (const gate of graph.gates.filter(candidate => candidate.label.includes('entry'))) {
      const phase = graph.phases.find(candidate => candidate.id === gate.phase);
      const phaseActions = graph.actions.filter(action => phase.actions.includes(action.id));
      const samePhaseWrites = new Set(phaseActions.flatMap(action => action.writes));

      for (const requirement of gate.requires) {
        expect(
          samePhaseWrites.has(requirement),
          `${gate.id} should not require ${requirement} before ${phase.id} actions run`
        ).toBe(false);
      }
    }
  });
});
