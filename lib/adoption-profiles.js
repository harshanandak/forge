const YAML = require('yaml');

const ADOPTION_VERSION = '0.0.15';
const RUNTIME_ANCESTRY = 'forge.runtimeGraph.currentCommandFlow@0.0.17';
const WORKFLOW_PHASES = Object.freeze(['plan', 'dev', 'validate', 'ship']);
const WORKFLOW_GATES = Object.freeze(['gate.plan-exit', 'gate.dev-exit', 'gate.validate-exit', 'gate.ship-entry']);

function enabledEntries(names, enabled = true) {
  return Object.fromEntries(names.map(name => [name, { enabled }]));
}

function issueAdapter(enabled) {
  if (!enabled) {
    return {
      enabled: false,
      primary: 'none',
      mirrors: [],
    };
  }

  return {
    enabled: true,
    primary: 'kernel',
    mirrors: ['github'],
  };
}

function harnessAdapter(targets) {
  return {
    enabled: targets.length > 0,
    targets,
  };
}

function adoptionConfig({ gatesEnabled, issueEnabled, harnessTargets, protectedPaths, rails }) {
  return {
    ...(rails ? { rails } : {}),
    workflow: {
      phases: enabledEntries(WORKFLOW_PHASES),
      gates: enabledEntries(WORKFLOW_GATES, gatesEnabled),
    },
    adapters: {
      issue: issueAdapter(issueEnabled),
      harness: harnessAdapter(harnessTargets),
    },
    protectedPaths,
  };
}

const PROFILE_CONFIGS = Object.freeze({
  minimal: {
    description: 'Config-only adoption for a clean repository.',
    config: adoptionConfig({
      gatesEnabled: false,
      issueEnabled: false,
      harnessTargets: [],
      protectedPaths: ['.forge/config.yaml'],
    }),
  },
  standard: {
    description: 'Default Forge command flow with Kernel issue tracking and GitHub mirror metadata.',
    config: adoptionConfig({
      gatesEnabled: true,
      issueEnabled: true,
      harnessTargets: ['codex', 'claude', 'cursor'],
      protectedPaths: ['.forge/config.yaml', 'AGENTS.md'],
    }),
  },
  full: {
    description: 'Full adoption scaffold with all default rails explicit.',
    config: adoptionConfig({
      rails: {
        tdd_intent: { enabled: true },
        secret_scan: { enabled: true },
        branch_protection: { enabled: true },
        signed_commits: { enabled: true },
        schema_integrity: { enabled: true },
      },
      gatesEnabled: true,
      issueEnabled: true,
      harnessTargets: ['codex', 'claude', 'cursor'],
      protectedPaths: ['.forge/config.yaml', 'AGENTS.md', '.github/workflows/**'],
    }),
  },
});

const ADOPTION_PROFILE_NAMES = Object.freeze(Object.keys(PROFILE_CONFIGS));

function clone(value) {
  return structuredClone(value);
}

function assertProfile(profile) {
  if (!Object.hasOwn(PROFILE_CONFIGS, profile)) {
    throw new Error(`Unknown adoption profile '${profile}'. Available profiles: ${ADOPTION_PROFILE_NAMES.join(', ')}`);
  }
}

function buildAdoptionConfig(profile = 'standard') {
  assertProfile(profile);
  const definition = PROFILE_CONFIGS[profile];
  return {
    template: {
      kind: 'forge.adoptionTemplate',
      version: ADOPTION_VERSION,
      profile,
      description: definition.description,
      ancestry: [
        RUNTIME_ANCESTRY,
        `forge.profile.${profile}@${ADOPTION_VERSION}`,
      ],
    },
    ...clone(definition.config),
  };
}

function renderAdoptionConfigYaml(profile = 'standard') {
  return YAML.stringify(buildAdoptionConfig(profile));
}

module.exports = {
  ADOPTION_PROFILE_NAMES,
  ADOPTION_VERSION,
  buildAdoptionConfig,
  renderAdoptionConfigYaml,
};
