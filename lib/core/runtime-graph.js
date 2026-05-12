'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const RUNTIME_GRAPH_SCHEMA_VERSION = '0.0.12';
const CONFIG_SOURCE = '.forge/config.yaml';

const RUNTIME_GRAPH_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://forge.local/schemas/runtime-graph-0.0.12.json',
  title: 'Forge Runtime Graph Artifact',
  type: 'object',
  required: ['schemaVersion', 'kind', 'schema', 'graph'],
  properties: {
    schemaVersion: { const: RUNTIME_GRAPH_SCHEMA_VERSION },
    kind: { const: 'forge.runtimeGraph' },
    schema: {
      type: 'object',
      required: ['$schema', '$id'],
    },
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
        'rails',
        'adapters',
        'edges',
      ],
    },
  },
};

function withRuntimeState(primitive, { enabled = true, locked = false, configSource = 'package-defaults' } = {}) {
  return {
    ...primitive,
    enabled,
    disabled: enabled === false,
    locked,
    configSource,
  };
}

function Phase({ id, label, command, actions, artifacts, gates, evidence, enabled = true, locked = false }) {
  return withRuntimeState({ id, label, command, actions, artifacts, gates, evidence }, { enabled, locked });
}

function Action({ id, kind, command, label, reads = [], writes = [], evidence = [], enabled = true, locked = false }) {
  return withRuntimeState({ id, kind, command, label, reads, writes, evidence }, { enabled, locked });
}

function Artifact({ id, kind, path, description }) {
  return { id, kind, path, description };
}

function EvaluatorRegion({ id, label, phase, description }) {
  return { id, label, phase, description };
}

function Gate({ id, phase, label, requires, enabled = true, locked = false }) {
  return withRuntimeState({ id, phase, label, requires }, { enabled, locked });
}

function Evidence({ id, kind, source, description }) {
  return { id, kind, source, description };
}

function Rail({ id, key, label, description, locked = true, enabled = true }) {
  return withRuntimeState({ id, key, label, description, layer: 'L1' }, { enabled, locked });
}

function Adapter({ id, kind, label, config = {}, enabled = true }) {
  return withRuntimeState({ id, kind, label, config }, { enabled });
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
    Rail: 'rails',
    Adapter: 'adapters',
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
      source: 'bun run typecheck; bun run lint; bun test; bun audit',
      description: 'Fresh validation evidence for the branch.',
    }),
    Evidence({
      id: 'evidence.dry-run-report',
      kind: 'dry-run-output',
      source: 'forge migrate --dry-run',
      description: 'Resolved graph can be printed without side effects.',
    }),
  ],
  rails: [
    Rail({
      id: 'rail.tdd_intent',
      key: 'tdd_intent',
      label: 'TDD intent evidence',
      description: 'Source changes require test intent and TDD evidence.',
    }),
    Rail({
      id: 'rail.secret_scan',
      key: 'secret_scan',
      label: 'Secret scan',
      description: 'Validation must not knowingly ship secrets.',
    }),
    Rail({
      id: 'rail.branch_protection',
      key: 'branch_protection',
      label: 'Branch protection',
      description: 'Ship through reviewed branches instead of direct protected-branch edits.',
    }),
    Rail({
      id: 'rail.signed_commits',
      key: 'signed_commits',
      label: 'Signed commits',
      description: 'Preserve commit provenance requirements where configured.',
    }),
    Rail({
      id: 'rail.schema_integrity',
      key: 'schema_integrity',
      label: 'Schema integrity',
      description: 'Keep runtime graph and config schemas internally consistent.',
    }),
  ],
  adapters: [
    Adapter({
      id: 'adapter.issue',
      kind: 'issue',
      label: 'Issue tracking adapter',
      config: { primary: 'beads', mirrors: ['github'] },
    }),
    Adapter({
      id: 'adapter.harness',
      kind: 'harness',
      label: 'Agent harness adapter',
      config: { targets: ['codex', 'claude', 'cursor'] },
    }),
  ],
  protectedPaths: [],
  edges: [
    { from: 'phase.plan', to: 'phase.dev', reason: 'design and task list feed implementation' },
    { from: 'phase.dev', to: 'phase.validate', reason: 'implementation feeds validation' },
    { from: 'phase.validate', to: 'phase.ship', reason: 'validated branch can be shipped' },
  ],
};

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function getConfigPath(projectRoot = process.cwd()) {
  return path.join(projectRoot, '.forge', 'config.yaml');
}

function loadRuntimeGraphConfig({ projectRoot = process.cwd() } = {}) {
  const configPath = getConfigPath(projectRoot);
  if (!fs.existsSync(configPath)) {
    return { config: {}, configPath, exists: false, errors: [] };
  }

  try {
    const parsed = YAML.parse(fs.readFileSync(configPath, 'utf8')) ?? {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        config: {},
        configPath,
        exists: true,
        errors: [{
          code: 'CONFIG_ROOT_INVALID',
          message: `${CONFIG_SOURCE} root must be an object.`,
        }],
      };
    }
    return {
      config: parsed,
      configPath,
      exists: true,
      errors: [],
    };
  } catch (err) {
    return {
      config: {},
      configPath,
      exists: true,
      errors: [{
        code: 'CONFIG_PARSE_ERROR',
        message: `Invalid ${CONFIG_SOURCE}: ${err.message}`,
      }],
    };
  }
}

function markConfigured(primitive, options) {
  Object.assign(primitive, withRuntimeState(primitive, {
    enabled: options.enabled,
    locked: primitive.locked === true,
    configSource: CONFIG_SOURCE,
  }));
}

function readEnabledOption(options, errors, typeName, id) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    errors.push({
      code: 'INVALID_PRIMITIVE_CONFIG',
      message: `${typeName} '${id}' config must be an object.`,
    });
    return { present: false, valid: false, value: undefined };
  }
  if (!Object.hasOwn(options, 'enabled')) {
    return { present: false, valid: true, value: undefined };
  }
  if (typeof options.enabled !== 'boolean') {
    errors.push({
      code: 'INVALID_ENABLED_VALUE',
      message: `${typeName} '${id}' enabled must be a boolean.`,
    });
    return { present: true, valid: false, value: undefined };
  }
  return { present: true, valid: true, value: options.enabled };
}

function readConfigSection(parent, key, errors, path) {
  if (!Object.hasOwn(parent, key)) {
    return {};
  }
  const value = parent[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push({
      code: 'INVALID_CONFIG_SECTION',
      message: `${path} must be an object.`,
    });
    return {};
  }
  return value;
}

function applyEnabledConfig(collection, id, options, errors, typeName) {
  const primitive = collection.find(candidate => candidate.id === id);
  if (!primitive) {
    errors.push({
      code: `UNKNOWN_${typeName.toUpperCase()}`,
      message: `Unknown ${typeName} '${id}' in ${CONFIG_SOURCE}.`,
    });
    return;
  }

  const enabled = readEnabledOption(options, errors, typeName, id);
  if (!enabled.valid) return;
  if (enabled.present) {
    if (enabled.value === false && primitive.locked === true) {
      errors.push({
        code: 'LOCKED_PRIMITIVE_DISABLED',
        message: `Cannot disable locked ${typeName} '${id}'.`,
      });
      return;
    }
    markConfigured(primitive, { enabled: enabled.value });
  }
}

function applyRailConfig(graph, config, errors) {
  const rails = readConfigSection(config, 'rails', errors, 'rails');
  for (const [key, options] of Object.entries(rails)) {
    const rail = graph.rails.find(candidate => candidate.key === key || candidate.id === key);
    if (!rail) {
      errors.push({
        code: 'UNKNOWN_RAIL',
        message: `Unknown rail '${key}' in ${CONFIG_SOURCE}.`,
      });
      continue;
    }
    const enabled = readEnabledOption(options, errors, 'rail', key);
    if (!enabled.valid) {
      continue;
    }
    if (enabled.value === false) {
      errors.push({
        code: 'LOCKED_L1_RAIL_DISABLED',
        message: `Cannot disable locked L1 rail '${key}'.`,
      });
      continue;
    }
    if (options && Object.keys(options).length > 0) {
      rail.configSource = CONFIG_SOURCE;
    }
  }
}

function applyWorkflowConfig(graph, config, errors) {
  const workflow = readConfigSection(config, 'workflow', errors, 'workflow');
  const phases = readConfigSection(workflow, 'phases', errors, 'workflow.phases');
  for (const [id, options] of Object.entries(phases)) {
    applyEnabledConfig(graph.phases, id, options ?? {}, errors, 'stage');
  }

  const gates = readConfigSection(workflow, 'gates', errors, 'workflow.gates');
  for (const [id, options] of Object.entries(gates)) {
    applyEnabledConfig(graph.gates, id, options ?? {}, errors, 'gate');
  }
}

function applyAdapterConfig(graph, config, errors) {
  const adapters = readConfigSection(config, 'adapters', errors, 'adapters');
  for (const [kind, options] of Object.entries(adapters)) {
    const adapter = graph.adapters.find(candidate => candidate.kind === kind || candidate.id === kind);
    if (!adapter) {
      errors.push({
        code: 'UNKNOWN_ADAPTER',
        message: `Unknown adapter '${kind}' in ${CONFIG_SOURCE}.`,
      });
      continue;
    }
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      errors.push({
        code: 'INVALID_ADAPTER_CONFIG',
        message: `adapter '${kind}' config must be an object.`,
      });
      continue;
    }
    const enabled = readEnabledOption(options, errors, 'adapter', kind);
    if (!enabled.valid) {
      continue;
    }
    const nextConfig = { ...options };
    delete nextConfig.enabled;
    if (enabled.present) {
      markConfigured(adapter, { enabled: enabled.value });
    }
    adapter.config = { ...adapter.config };
    Object.assign(adapter.config, nextConfig);
    if (enabled.present || Object.keys(nextConfig).length > 0) {
      adapter.configSource = CONFIG_SOURCE;
    }
  }
}

function validateProtectedPaths(config, errors) {
  if (!Object.hasOwn(config, 'protectedPaths')) {
    return [];
  }
  if (!Array.isArray(config.protectedPaths)) {
    errors.push({
      code: 'PROTECTED_PATHS_INVALID',
      message: 'protectedPaths must be a list of path patterns.',
    });
    return [];
  }

  const protectedPaths = [];
  for (const [index, entry] of config.protectedPaths.entries()) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      errors.push({
        code: 'PROTECTED_PATH_INVALID',
        message: `protectedPaths[${index}] must be a non-empty string.`,
      });
      continue;
    }
    const pattern = entry.trim();
    if (['*', '**', '**/*', '.', './', '/'].includes(pattern)) {
      errors.push({
        code: 'PROTECTED_PATH_TOO_BROAD',
        message: `protectedPaths[${index}] is too broad: ${pattern}`,
      });
      continue;
    }
    protectedPaths.push(pattern);
  }
  return protectedPaths;
}

function resolveRuntimeGraph({ projectRoot = process.cwd(), throwOnError = true } = {}) {
  const graph = cloneJson(RESOLVED_RUNTIME_GRAPH);
  const loaded = loadRuntimeGraphConfig({ projectRoot });
  const errors = [...loaded.errors];

  if (loaded.errors.length === 0) {
    applyRailConfig(graph, loaded.config, errors);
    applyWorkflowConfig(graph, loaded.config, errors);
    applyAdapterConfig(graph, loaded.config, errors);
    graph.protectedPaths = validateProtectedPaths(loaded.config, errors);
  }

  graph.config = {
    path: CONFIG_SOURCE,
    loaded: loaded.exists,
    errors,
  };

  if (throwOnError && errors.length > 0) {
    throw new Error(errors.map(error => error.message).join('\n'));
  }

  return { graph, errors };
}

function getResolvedRuntimeGraph(options = {}) {
  return resolveRuntimeGraph(options).graph;
}

function getDefaultRuntimeGraph() {
  return cloneJson(RESOLVED_RUNTIME_GRAPH);
}

function lintRuntimeGraphConfig(options = {}) {
  const { graph, errors } = resolveRuntimeGraph({ ...options, throwOnError: false });
  return {
    ok: errors.length === 0,
    errors,
    warnings: [],
    graph,
  };
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
  Rail,
  Adapter,
  loadRuntimeGraphConfig,
  lintRuntimeGraphConfig,
  resolveRuntimeGraph,
  getDefaultRuntimeGraph,
  buildRuntimeGraphEnvelope,
  getResolvedRuntimeGraph,
};
