'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const RUNTIME_GRAPH_SCHEMA_VERSION = '0.0.17';
const CONFIG_SOURCE = '.forge/config.yaml';

const RUNTIME_GRAPH_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://forge.local/schemas/runtime-graph-0.0.17.json',
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

function PlanningSubSkill({ id, label, inputs, outputs, evidence, gate, enabled = true }) {
  return withRuntimeState({ id, label, inputs, outputs, evidence, gate }, { enabled });
}

function Role({ id, role, skill, ideology, configSource = 'package-defaults' }) {
  const primitive = { id, role, skill, configSource };
  if (ideology !== undefined) primitive.ideology = ideology;
  return primitive;
}

// Role -> default skill binding. Role names are the canonical stage ids
// (lib/workflow/stages.js STAGE_IDS); each ships bound to its like-named skill.
// This is the closed set of KNOWN roles; the bound skill name is open-world
// (resolved via .skills/ > skills/), never checked against PLAN_SUBSKILL_IDS.
// Additive to the graph — see docs/work/2026-07-04-kernel-native-skills/
// extensibility-architecture.md.
const ROLE_DEFINITIONS = [
  { role: 'plan', skill: 'plan' },
  { role: 'dev', skill: 'dev' },
  { role: 'validate', skill: 'validate' },
  { role: 'ship', skill: 'ship' },
  { role: 'review', skill: 'review' },
  { role: 'verify', skill: 'verify' },
];

const ROLE_IDS = new Set(ROLE_DEFINITIONS.map(definition => definition.role));

function roleFromDefinition(definition) {
  return Role({ id: `role.${definition.role}`, role: definition.role, skill: definition.skill });
}

const PLAN_SUBSKILL_DEFINITIONS = [
  {
    id: 'plan.intent_capture',
    label: 'Intent capture',
    inputs: ['feature request', 'constraints'],
    outputs: ['purpose', 'success criteria', 'out of scope'],
    actionLabel: 'Capture planning intent',
    reads: [],
    writes: ['artifact.design-doc'],
  },
  {
    id: 'plan.parallel_research',
    label: 'Parallel research',
    inputs: ['intent capture'],
    outputs: ['technical approach options', 'risk notes'],
    actionLabel: 'Research planning options',
    reads: ['artifact.design-doc'],
    writes: ['artifact.design-doc'],
  },
  {
    id: 'plan.parallel_critics',
    label: 'Parallel critics',
    inputs: ['approach options'],
    outputs: ['spec critique', 'risk critique', 'test critique'],
    actionLabel: 'Critique planning options',
    reads: ['artifact.design-doc'],
    writes: ['artifact.design-doc'],
  },
  {
    id: 'plan.synthesis',
    label: 'Synthesis',
    inputs: ['research', 'critic output'],
    outputs: ['selected approach', 'tradeoffs'],
    actionLabel: 'Synthesize selected plan',
    reads: ['artifact.design-doc'],
    writes: ['artifact.design-doc'],
  },
  {
    id: 'plan.final_lock',
    label: 'Final lock',
    inputs: ['selected approach'],
    outputs: ['design doc', 'task list'],
    actionLabel: 'Lock planning artifacts',
    reads: ['artifact.design-doc'],
    writes: ['artifact.design-doc', 'artifact.task-list'],
  },
];

const PLAN_SUBSKILL_IDS = new Set(PLAN_SUBSKILL_DEFINITIONS.map(definition => definition.id));

// The `smith` orchestrator composes the stage skills end-to-end. Its sub-skills
// are the stage skill NAMES (each a real `skills/<name>/` dir), unlike plan's
// fine-grained internal planning phases. Both resolve through the ONE generic
// registry below (keyed by owning skill), so composition is no longer hardcoded
// to plan. See docs/work kernel-native-skills composition epic (a0776e61) +
// smith-orchestrator (7da81cbd).
const SMITH_SUBSKILL_DEFINITIONS = ['plan', 'dev', 'validate', 'ship', 'review', 'verify']
  .map(stage => ({ id: stage, label: `${stage} stage`, owner: 'smith' }));

// Generic per-skill sub-skill registry, keyed by owning skill id. Generalizes
// plan's previously hardcoded PLAN_SUBSKILL_DEFINITIONS / validatePlanSubSkillList
// so any composing skill (plan, smith, ...) declares its sub-skill set through a
// single mechanism. Add an owner here to give a new skill a validated sub-skill
// composition without touching the validators.
const SUBSKILL_REGISTRY = {
  plan: PLAN_SUBSKILL_DEFINITIONS,
  smith: SMITH_SUBSKILL_DEFINITIONS,
};

const SUBSKILL_IDS_BY_OWNER = {
  plan: PLAN_SUBSKILL_IDS,
  smith: new Set(SMITH_SUBSKILL_DEFINITIONS.map(d => d.id)),
};

function getSubSkillDefinitions(owner) {
  return SUBSKILL_REGISTRY[owner] ? [...SUBSKILL_REGISTRY[owner]] : [];
}

function getSubSkillIds(owner) {
  return new Set(SUBSKILL_IDS_BY_OWNER[owner] || []);
}

function planningSubSkillFromDefinition(definition) {
  return PlanningSubSkill({
    id: definition.id,
    label: definition.label,
    inputs: definition.inputs,
    outputs: definition.outputs,
    evidence: ['evidence.command-docs'],
    gate: 'gate.plan-exit',
  });
}

function planningActionFromDefinition(definition) {
  return Action({
    id: `action.${definition.id}`,
    kind: 'plan-subskill',
    command: definition.id,
    label: definition.actionLabel,
    reads: definition.reads,
    writes: definition.writes,
    evidence: ['evidence.command-docs'],
  });
}

const RESOLVED_RUNTIME_GRAPH = {
  id: 'forge.runtimeGraph.currentCommandFlow',
  version: RUNTIME_GRAPH_SCHEMA_VERSION,
  description: 'Resolved graph for the current /plan -> /dev -> /validate -> /ship command flow.',
  primitives: {
    Phase: 'phases',
    Action: 'actions',
    PlanningSubSkill: 'planning.subSkills',
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
      actions: PLAN_SUBSKILL_DEFINITIONS.map(definition => `action.${definition.id}`),
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
  planning: {
    template: {
      mode: 'full',
      convergenceThreshold: 0.75,
      criticSet: ['spec', 'risk', 'test'],
      partialInvocation: {
        only: [],
        skip: [],
      },
      configSource: 'package-defaults',
    },
    subSkills: PLAN_SUBSKILL_DEFINITIONS.map(planningSubSkillFromDefinition),
  },
  roles: ROLE_DEFINITIONS.map(roleFromDefinition),
  actions: [
    Action({
      id: 'action.plan.command',
      kind: 'command',
      command: 'plan',
      label: 'Capture design intent and task list',
      writes: ['artifact.design-doc', 'artifact.task-list'],
      evidence: ['evidence.command-docs'],
    }),
    ...PLAN_SUBSKILL_DEFINITIONS.map(planningActionFromDefinition),
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
      path: 'docs/work/YYYY-MM-DD-<slug>/plan.md',
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
    // Human gates — satisfied by a `gate.approved` kernel EVENT on the issue, not by
    // an artifact (see lib/gate-events.js + docs/work/2026-07-04-kernel-native-skills/
    // decisions.md). Additive + backward-compatible: they widen the known-gate set so
    // `forge gate approve|reject|status|check` recognize them and each is toggleable
    // via `workflow.gates.<id>.enabled`. `requires: []` because approval, not evidence,
    // is the exit condition. Default three: intent · plan-approval · merge.
    Gate({
      id: 'gate.intent',
      phase: 'plan',
      label: 'Intent approval',
      requires: [],
    }),
    Gate({
      id: 'gate.plan-approval',
      phase: 'plan',
      label: 'Plan approval',
      requires: [],
    }),
    Gate({
      id: 'gate.merge',
      phase: 'ship',
      label: 'Merge approval',
      requires: [],
    }),
    // gate.issue_verify — check-after-write verification on kernel issue mutations
    // (create|update|close|claim|comment) at the lib/commands/_issue.js boundary:
    // after a successful write, re-read through the same broker and confirm the
    // intended delta landed (verified/mismatches in the envelope; warn-only — the
    // write's ok is never overturned). Default ON and UNLOCKED, toggled via
    // `forge gate disable gate.issue_verify` through the same workflow.gates
    // surface as rail.kernel_tracking. Justified by two proven "ok:true lied"
    // bugs: 145d9ad1 (close --reason/closed_at dropped in the projection) and
    // d71a824b (idempotent claim replay telling a losing agent it won). No phase:
    // it guards the issue-command boundary, not a workflow stage exit.
    // `requires: []` — the read-back itself, not evidence, is the check.
    Gate({
      id: 'gate.issue_verify',
      label: 'Issue write verification (check-after-write)',
      requires: [],
    }),
    // Grounding gates (epic 6ef96e92, design docs/work/2026-07-16-grounding-
    // enforcement/design.md) — the first gates that DENY (fd4c03b3's first real
    // payment). gate.read_first: acting on an issue requires having read it —
    // consulted fail-closed at the `forge claim` boundary against a
    // `context.loaded` kernel event (lib/grounding/context-events.js), remedy
    // `forge recap <id>`. gate.cite: shipped artifacts must cite their sources —
    // registered here (togglable) but its scanner lands in P3; it denies nothing
    // yet. Both phase-less, default-ON, UNLOCKED, same toggle surface as
    // gate.issue_verify (`forge gate disable gate.read_first`). Master switch is
    // the unlocked rail.grounding below. `requires: []` — the context.loaded
    // event (not evidence) is the exit condition.
    Gate({
      id: 'gate.read_first',
      label: 'Read the issue before acting on it',
      requires: [],
    }),
    Gate({
      id: 'gate.cite',
      label: 'Cite sources in shipped artifacts',
      requires: [],
    }),
  ],
  evidence: [
    Evidence({
      id: 'evidence.command-docs',
      kind: 'checked-in-doc',
      source: 'skills/*/SKILL.md',
      description: 'Skill docs define the compatibility surface.',
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
  // Rails are declared as a data table and mapped through Rail() so each entry
  // stays a single line (Rail defaults locked: true; kernel_tracking is the one
  // UNLOCKED, default-ON rail — it ingrains "file every issue/idea/bug/decision
  // to the kernel immediately; nothing discussed goes missing", and a maintainer
  // may opt out via `forge gate disable rail.kernel_tracking`, consumed by the
  // resolver's rail-aware gate loop over workflow.gates.<id>.enabled).
  rails: [
    { key: 'tdd_intent', label: 'TDD intent evidence', description: 'Source changes require test intent and TDD evidence. Strong default (ON), but not a hard floor — disable with `forge gate disable rail.tdd_intent`.', locked: false },
    { key: 'secret_scan', label: 'Secret scan', description: 'Validation must not knowingly ship secrets.' },
    { key: 'branch_protection', label: 'Branch protection', description: 'Ship through reviewed branches instead of direct protected-branch edits.' },
    { key: 'signed_commits', label: 'Signed commits', description: 'Preserve commit provenance requirements where configured.' },
    { key: 'schema_integrity', label: 'Schema integrity', description: 'Keep runtime graph and config schemas internally consistent.' },
    { key: 'kernel_tracking', label: 'Kernel issue tracking', description: 'Every issue, idea, bug, and decision discussed is filed to the Forge Kernel.', locked: false },
    { key: 'auto_shepherd', label: 'Auto-start PR shepherd watch', description: 'On `forge ship` success, auto-start the detached, self-stopping `forge shepherd watch <pr>` monitor so a shipped PR is tended without a manual trigger. Default-ON, UNLOCKED — opt out with `forge gate disable rail.auto_shepherd`.', locked: false },
    // grounding — the one-switch master toggle over gate.read_first + gate.cite.
    // UNLOCKED, default-ON (like kernel_tracking): a maintainer may opt out via
    // `forge gate disable rail.grounding`, which the read_first consult treats as
    // "allow, logged". Ingrains "read the documented source before acting; cite it".
    { key: 'grounding', label: 'Documented-grounding enforcement', description: 'Read the issue before acting on it; cite sources in shipped artifacts.', locked: false },
  ].map(def => Rail({ id: `rail.${def.key}`, ...def })),
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
    const rawConfig = fs.readFileSync(configPath, 'utf8');
    const parsed = rawConfig.trim() === '' ? {} : YAML.parse(rawConfig);
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
    if (enabled.value === false && rail.locked === true) {
      // Locked L1 rails remain a non-negotiable floor; only unlocked rails
      // (e.g. tdd_intent, kernel_tracking) may be disabled via config.
      errors.push({
        code: 'LOCKED_L1_RAIL_DISABLED',
        message: `Cannot disable locked L1 rail '${key}'.`,
      });
      continue;
    }
    if (enabled.present) {
      markConfigured(rail, { enabled: enabled.value });
    } else if (options && Object.keys(options).length > 0) {
      rail.configSource = CONFIG_SOURCE;
    }
  }
}

function applyWorkflowConfig(graph, config, errors) {
  const workflow = readConfigSection(config, 'workflow', errors, 'workflow');
  const phases = readConfigSection(workflow, 'phases', errors, 'workflow.phases');
  for (const [id, options] of Object.entries(phases)) {
    applyEnabledConfig(graph.phases, id, options, errors, 'stage');
  }

  // The `workflow.gates.<id>.enabled` surface (driven by `forge gate enable|disable`)
  // governs gates AND unlocked toggleable rails (e.g. rail.kernel_tracking): the id
  // namespaces are disjoint (gate.* vs rail.*), so a single combined lookup routes each
  // id to its primitive. applyEnabledConfig still honors each primitive's `locked` flag,
  // so a locked L1 rail cannot be disabled through this surface either.
  const gates = readConfigSection(workflow, 'gates', errors, 'workflow.gates');
  const toggleable = [...graph.gates, ...graph.rails];
  for (const [id, options] of Object.entries(gates)) {
    applyEnabledConfig(toggleable, id, options, errors, 'gate');
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

function readRoleStringField(options, field, role, errors) {
  if (!Object.hasOwn(options, field)) {
    return { present: false, value: undefined };
  }
  const value = options[field];
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push({
      code: `INVALID_ROLE_${field.toUpperCase()}`,
      message: `role '${role}' ${field} must be a non-empty string.`,
    });
    return { present: true, value: undefined };
  }
  return { present: true, value: value.trim() };
}

// Reader for the `roles` section (sibling to `workflow.gates`). Role names are
// the KNOWN closed set (ROLE_IDS); the bound `skill` / `ideology` names are
// OPEN-WORLD — validated only as non-empty strings here, never against
// PLAN_SUBSKILL_IDS (that closed enum stays scoped to
// planning.template.partialInvocation). Skill EXISTENCE is enforced at write
// time by the `forge role` verb, not mid-run.
function applyRoleConfig(graph, config, errors) {
  const roles = readConfigSection(config, 'roles', errors, 'roles');
  for (const [role, options] of Object.entries(roles)) {
    const entry = graph.roles.find(candidate => candidate.role === role || candidate.id === role);
    if (!entry) {
      errors.push({
        code: 'UNKNOWN_ROLE',
        message: `Unknown role '${role}' in ${CONFIG_SOURCE}.`,
      });
      continue;
    }
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      errors.push({
        code: 'INVALID_ROLE_CONFIG',
        message: `role '${role}' config must be an object.`,
      });
      continue;
    }

    let changed = false;
    const skill = readRoleStringField(options, 'skill', role, errors);
    if (skill.present && skill.value !== undefined) {
      entry.skill = skill.value;
      changed = true;
    }
    const ideology = readRoleStringField(options, 'ideology', role, errors);
    if (ideology.present && ideology.value !== undefined) {
      entry.ideology = ideology.value;
      changed = true;
    }
    if (changed) {
      entry.configSource = CONFIG_SOURCE;
    }
  }
}

function assertStringList(value, errors, code, message) {
  if (!Array.isArray(value)) {
    errors.push({ code, message });
    return false;
  }

  let valid = true;
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      errors.push({ code, message });
      valid = false;
      break;
    }
  }
  return valid;
}

// Generic sub-skill list validator, keyed by owning skill. Replaces the
// plan-hardcoded validator with an owner-parameterized one; `validatePlanSubSkillList`
// below is the backward-compatible plan wrapper.
function validateSubSkillList(owner, value, errors, path) {
  const knownIds = SUBSKILL_IDS_BY_OWNER[owner] || new Set();
  const listCode = owner === 'plan' ? 'INVALID_PLAN_SUBSKILL_LIST' : 'INVALID_SUBSKILL_LIST';
  const unknownCode = owner === 'plan' ? 'UNKNOWN_PLAN_SUBSKILL' : 'UNKNOWN_SUBSKILL';
  const noun = owner === 'plan' ? 'planning sub-skill' : `${owner} sub-skill`;

  if (!assertStringList(
    value,
    errors,
    listCode,
    `${path} must be a list of ${noun} IDs.`
  )) {
    return undefined;
  }

  const normalized = value.map(item => item.trim());
  let hasUnknown = false;
  for (const id of normalized) {
    if (!knownIds.has(id)) {
      hasUnknown = true;
      errors.push({
        code: unknownCode,
        message: `Unknown ${noun} '${id}' in ${CONFIG_SOURCE}.`,
      });
    }
  }
  if (hasUnknown) {
    return undefined;
  }
  return normalized;
}

function validatePlanSubSkillList(value, errors, path) {
  return validateSubSkillList('plan', value, errors, path);
}

function applyPlanningMode(template, nextTemplate, errors) {
  if (!Object.hasOwn(template, 'mode')) return;
  if (!['full', 'partial'].includes(template.mode)) {
    errors.push({
      code: 'INVALID_PLANNING_MODE',
      message: 'planning.template.mode must be full or partial.',
    });
    return;
  }
  nextTemplate.mode = template.mode;
}

function applyConvergenceThreshold(template, nextTemplate, errors) {
  if (!Object.hasOwn(template, 'convergenceThreshold')) return;
  if (!Number.isFinite(template.convergenceThreshold)
    || template.convergenceThreshold < 0
    || template.convergenceThreshold > 1) {
    errors.push({
      code: 'INVALID_CONVERGENCE_THRESHOLD',
      message: 'planning.template.convergenceThreshold must be a number from 0 to 1.',
    });
    return;
  }
  nextTemplate.convergenceThreshold = template.convergenceThreshold;
}

function applyCriticSet(template, nextTemplate, errors) {
  if (!Object.hasOwn(template, 'criticSet')) return;
  if (assertStringList(template.criticSet, errors, 'INVALID_CRITIC', 'planning.template.criticSet must contain non-empty strings.')) {
    nextTemplate.criticSet = template.criticSet.map(item => item.trim());
  }
}

function applyPartialInvocation(template, nextTemplate, errors) {
  if (!Object.hasOwn(template, 'partialInvocation')) return;
  const partial = readConfigSection(template, 'partialInvocation', errors, 'planning.template.partialInvocation');
  if (Object.hasOwn(partial, 'only')) {
    const only = validatePlanSubSkillList(partial.only, errors, 'planning.template.partialInvocation.only');
    if (only) nextTemplate.partialInvocation.only = only;
  }
  if (Object.hasOwn(partial, 'skip')) {
    const skip = validatePlanSubSkillList(partial.skip, errors, 'planning.template.partialInvocation.skip');
    if (skip) nextTemplate.partialInvocation.skip = skip;
  }
}

function applyPlanningConfig(graph, config, errors) {
  const planning = readConfigSection(config, 'planning', errors, 'planning');
  const template = readConfigSection(planning, 'template', errors, 'planning.template');
  if (Object.keys(template).length === 0) {
    return;
  }

  const nextTemplate = { ...graph.planning.template, partialInvocation: { ...graph.planning.template.partialInvocation } };
  applyPlanningMode(template, nextTemplate, errors);
  applyConvergenceThreshold(template, nextTemplate, errors);
  applyCriticSet(template, nextTemplate, errors);
  applyPartialInvocation(template, nextTemplate, errors);
  nextTemplate.configSource = CONFIG_SOURCE;
  graph.planning.template = nextTemplate;
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
    applyRoleConfig(graph, loaded.config, errors);
    applyPlanningConfig(graph, loaded.config, errors);
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
  PlanningSubSkill,
  Role,
  ROLE_IDS,
  SUBSKILL_REGISTRY,
  getSubSkillDefinitions,
  getSubSkillIds,
  validateSubSkillList,
  validatePlanSubSkillList,
  loadRuntimeGraphConfig,
  lintRuntimeGraphConfig,
  resolveRuntimeGraph,
  getDefaultRuntimeGraph,
  buildRuntimeGraphEnvelope,
  getResolvedRuntimeGraph,
};
