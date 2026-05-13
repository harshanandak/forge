const YAML = require('yaml');

const ADOPTION_VERSION = '0.0.15';
const RUNTIME_ANCESTRY = 'forge.runtimeGraph.currentCommandFlow@0.0.12';

const PROFILE_CONFIGS = Object.freeze({
  minimal: {
    description: 'Config-only adoption for a clean repository.',
    config: {
      workflow: {
        phases: {
          plan: { enabled: true },
          dev: { enabled: true },
          validate: { enabled: true },
          ship: { enabled: true },
        },
        gates: {
          'gate.plan-exit': { enabled: false },
          'gate.dev-exit': { enabled: false },
          'gate.validate-exit': { enabled: false },
          'gate.ship-entry': { enabled: false },
        },
      },
      adapters: {
        issue: {
          enabled: false,
          primary: 'none',
          mirrors: [],
        },
        harness: {
          enabled: false,
          targets: [],
        },
      },
      protectedPaths: ['.forge/config.yaml'],
    },
  },
  standard: {
    description: 'Default Forge command flow with Beads/GitHub issue tracking metadata.',
    config: {
      workflow: {
        phases: {
          plan: { enabled: true },
          dev: { enabled: true },
          validate: { enabled: true },
          ship: { enabled: true },
        },
        gates: {
          'gate.plan-exit': { enabled: true },
          'gate.dev-exit': { enabled: true },
          'gate.validate-exit': { enabled: true },
          'gate.ship-entry': { enabled: true },
        },
      },
      adapters: {
        issue: {
          enabled: true,
          primary: 'beads',
          mirrors: ['github'],
        },
        harness: {
          enabled: true,
          targets: ['codex', 'claude', 'cursor'],
        },
      },
      protectedPaths: ['.forge/config.yaml', 'AGENTS.md'],
    },
  },
  full: {
    description: 'Full adoption scaffold with all default rails explicit.',
    config: {
      rails: {
        tdd_intent: { enabled: true },
        secret_scan: { enabled: true },
        branch_protection: { enabled: true },
        signed_commits: { enabled: true },
        schema_integrity: { enabled: true },
      },
      workflow: {
        phases: {
          plan: { enabled: true },
          dev: { enabled: true },
          validate: { enabled: true },
          ship: { enabled: true },
        },
        gates: {
          'gate.plan-exit': { enabled: true },
          'gate.dev-exit': { enabled: true },
          'gate.validate-exit': { enabled: true },
          'gate.ship-entry': { enabled: true },
        },
      },
      adapters: {
        issue: {
          enabled: true,
          primary: 'beads',
          mirrors: ['github'],
        },
        harness: {
          enabled: true,
          targets: ['codex', 'claude', 'cursor', 'opencode', 'copilot'],
        },
      },
      protectedPaths: ['.forge/config.yaml', 'AGENTS.md', '.github/workflows/**'],
    },
  },
});

const ADOPTION_PROFILE_NAMES = Object.freeze(Object.keys(PROFILE_CONFIGS));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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
