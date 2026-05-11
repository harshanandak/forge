'use strict';

const RUNTIME_GRAPH_SCHEMA_VERSION = '0.0.12';

const RUNTIME_GRAPH_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://forge.local/schemas/runtime-graph-0.0.12.json',
  title: 'Forge Runtime Graph Artifact',
  type: 'object',
  required: ['schemaVersion', 'kind', 'graph'],
  properties: {
    schemaVersion: { const: RUNTIME_GRAPH_SCHEMA_VERSION },
    kind: { const: 'forge.runtimeGraph' },
    graph: {
      type: 'object',
      required: [
        'primitives',
        'phases',
        'actions',
        'artifacts',
        'evaluatorRegions',
        'gates',
        'evidence',
        'edges',
      ],
    },
  },
};

function Phase({ id, label, command, actions, artifacts, gates, evidence }) {
  return { id, label, command, actions, artifacts, gates, evidence };
}

function Action({ id, kind, command, label, reads = [], writes = [], evidence = [] }) {
  return { id, kind, command, label, reads, writes, evidence };
}

function Artifact({ id, kind, path, description }) {
  return { id, kind, path, description };
}

function EvaluatorRegion({ id, label, phase, description }) {
  return { id, label, phase, description };
}

function Gate({ id, phase, label, requires }) {
  return { id, phase, label, requires };
}

function Evidence({ id, kind, source, description }) {
  return { id, kind, source, description };
}

const RESOLVED_RUNTIME_GRAPH = {
  id: 'forge.runtimeGraph.currentCommandFlow',
  version: RUNTIME_GRAPH_SCHEMA_VERSION,
  description: 'Resolved graph for the current /plan -> /dev -> /validate -> /ship command flow.',
  primitives: {
    Phase: 'phases',
    Action: 'actions',
    Artifact: 'artifacts',
    EvaluatorRegion: 'evaluatorRegions',
    Gate: 'gates',
    Evidence: 'evidence',
  },
  phases: [
    Phase({
      id: 'plan',
      label: '/plan',
      command: 'plan',
      actions: ['action.plan.command'],
      artifacts: ['artifact.design-doc', 'artifact.task-list'],
      gates: ['gate.plan-exit'],
      evidence: ['evidence.command-docs'],
    }),
    Phase({
      id: 'dev',
      label: '/dev',
      command: 'dev',
      actions: ['action.dev.command'],
      artifacts: ['artifact.changed-files'],
      gates: ['gate.dev-exit'],
      evidence: ['evidence.tdd-tests'],
    }),
    Phase({
      id: 'validate',
      label: '/validate',
      command: 'validate',
      actions: ['action.validate.command'],
      artifacts: ['artifact.validation-output'],
      gates: ['gate.validate-exit'],
      evidence: ['evidence.validation-output'],
    }),
    Phase({
      id: 'ship',
      label: '/ship',
      command: 'ship',
      actions: ['action.ship.command'],
      artifacts: ['artifact.pull-request'],
      gates: ['gate.ship-entry'],
      evidence: ['evidence.dry-run-report'],
    }),
  ],
  actions: [
    Action({
      id: 'action.plan.command',
      kind: 'command',
      command: 'plan',
      label: 'Capture design intent and task list',
      writes: ['artifact.design-doc', 'artifact.task-list'],
      evidence: ['evidence.command-docs'],
    }),
    Action({
      id: 'action.dev.command',
      kind: 'command',
      command: 'dev',
      label: 'Implement tasks with TDD evidence',
      reads: ['artifact.design-doc', 'artifact.task-list'],
      writes: ['artifact.changed-files'],
      evidence: ['evidence.tdd-tests'],
    }),
    Action({
      id: 'action.validate.command',
      kind: 'command',
      command: 'validate',
      label: 'Run type, lint, test, and security checks',
      reads: ['artifact.changed-files'],
      writes: ['artifact.validation-output'],
      evidence: ['evidence.validation-output'],
    }),
    Action({
      id: 'action.ship.command',
      kind: 'command',
      command: 'ship',
      label: 'Push branch and open a pull request',
      reads: ['artifact.validation-output'],
      writes: ['artifact.pull-request'],
      evidence: ['evidence.dry-run-report'],
    }),
  ],
  artifacts: [
    Artifact({
      id: 'artifact.design-doc',
      kind: 'markdown',
      path: 'docs/work/YYYY-MM-DD-<slug>/design.md',
      description: 'Design intent, constraints, and research.',
    }),
    Artifact({
      id: 'artifact.task-list',
      kind: 'markdown',
      path: 'docs/work/YYYY-MM-DD-<slug>/tasks.md',
      description: 'TDD task list consumed by /dev.',
    }),
    Artifact({
      id: 'artifact.changed-files',
      kind: 'git-diff',
      path: '<worktree>',
      description: 'Source and test changes produced during /dev.',
    }),
    Artifact({
      id: 'artifact.validation-output',
      kind: 'terminal-output',
      path: '<session>',
      description: 'Fresh validation command output.',
    }),
    Artifact({
      id: 'artifact.pull-request',
      kind: 'github-pr',
      path: '<pr-url>',
      description: 'Pull request created by /ship.',
    }),
  ],
  evaluatorRegions: [
    EvaluatorRegion({
      id: 'evaluator.plan-entry',
      label: 'Plan entry and exit gates',
      phase: 'plan',
      description: 'Checks worktree isolation, design artifacts, and task handoff.',
    }),
    EvaluatorRegion({
      id: 'evaluator.tdd-loop',
      label: 'TDD implementation loop',
      phase: 'dev',
      description: 'Checks RED/GREEN/REFACTOR evidence and task completion.',
    }),
    EvaluatorRegion({
      id: 'evaluator.validation-suite',
      label: 'Validation suite',
      phase: 'validate',
      description: 'Checks type, lint, tests, and security scan evidence.',
    }),
    EvaluatorRegion({
      id: 'evaluator.ship-readiness',
      label: 'Ship readiness',
      phase: 'ship',
      description: 'Checks branch freshness, PR body, and issue linkage.',
    }),
  ],
  gates: [
    Gate({
      id: 'gate.plan-exit',
      phase: 'plan',
      label: '/plan exit',
      requires: ['artifact.design-doc', 'artifact.task-list', 'evidence.command-docs'],
    }),
    Gate({
      id: 'gate.dev-exit',
      phase: 'dev',
      label: '/dev exit',
      requires: ['artifact.changed-files', 'evidence.tdd-tests'],
    }),
    Gate({
      id: 'gate.validate-exit',
      phase: 'validate',
      label: '/validate exit',
      requires: ['artifact.validation-output', 'evidence.validation-output'],
    }),
    Gate({
      id: 'gate.ship-entry',
      phase: 'ship',
      label: '/ship entry',
      requires: ['artifact.validation-output'],
    }),
  ],
  evidence: [
    Evidence({
      id: 'evidence.command-docs',
      kind: 'checked-in-doc',
      source: '.claude/commands/*.md',
      description: 'Command docs define the compatibility surface.',
    }),
    Evidence({
      id: 'evidence.tdd-tests',
      kind: 'test-output',
      source: 'bun test',
      description: 'Task-level failing then passing test output.',
    }),
    Evidence({
      id: 'evidence.validation-output',
      kind: 'validation-output',
      source: 'bun run typecheck; bun run lint; bun test; npm audit',
      description: 'Fresh validation evidence for the branch.',
    }),
    Evidence({
      id: 'evidence.dry-run-report',
      kind: 'dry-run-output',
      source: 'forge migrate --dry-run',
      description: 'Resolved graph can be printed without side effects.',
    }),
  ],
  edges: [
    { from: 'phase.plan', to: 'phase.dev', reason: 'design and task list feed implementation' },
    { from: 'phase.dev', to: 'phase.validate', reason: 'implementation feeds validation' },
    { from: 'phase.validate', to: 'phase.ship', reason: 'validated branch can be shipped' },
  ],
};

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function getResolvedRuntimeGraph() {
  return cloneJson(RESOLVED_RUNTIME_GRAPH);
}

function buildRuntimeGraphEnvelope(graph = getResolvedRuntimeGraph()) {
  return {
    schemaVersion: RUNTIME_GRAPH_SCHEMA_VERSION,
    kind: 'forge.runtimeGraph',
    schema: cloneJson(RUNTIME_GRAPH_SCHEMA),
    graph: cloneJson(graph),
  };
}

module.exports = {
  RUNTIME_GRAPH_SCHEMA_VERSION,
  RUNTIME_GRAPH_SCHEMA,
  Phase,
  Action,
  Artifact,
  EvaluatorRegion,
  Gate,
  Evidence,
  buildRuntimeGraphEnvelope,
  getResolvedRuntimeGraph,
};
