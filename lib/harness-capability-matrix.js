'use strict';

const HARNESS_IDS = ['claude', 'cursor', 'codex'];

const CAPABILITY_IDS = [
  'instructions',
  'skills',
  'rules',
  'mcp',
  'hooks',
  'commands',
  'agents',
  'stages',
  'beads',
  'typedMemory',
  'patchOverrides',
  'marketplaceTrust',
  'extensionPacks',
];

const STAGE_IDS = [
  'status',
  'plan',
  'dev',
  'validate',
  'ship',
  'review',
  'premerge',
  'verify',
];

const SOURCES = [
  {
    label: 'S1',
    title: 'Claude Code skills',
    url: 'https://code.claude.com/docs/en/skills',
    summary: 'Claude Code skills use SKILL.md frontmatter descriptions for automatic invocation; commands remain compatible but skills are recommended.',
  },
  {
    label: 'S2',
    title: 'Claude Agent SDK skills',
    url: 'https://code.claude.com/docs/en/agent-sdk/skills',
    summary: 'Claude SDK loads project/user/plugin skills and invokes them based on description metadata.',
  },
  {
    label: 'S3',
    title: 'Cursor rules',
    url: 'https://docs.cursor.com/en/context',
    summary: 'Cursor project rules live in .cursor/rules as .mdc files with description, globs, and alwaysApply metadata.',
  },
  {
    label: 'S4',
    title: 'Cursor MCP',
    url: 'https://docs.cursor.com/context/model-context-protocol',
    summary: 'Cursor connects external tools and data sources through MCP using stdio, SSE, and streamable HTTP transports.',
  },
  {
    label: 'S5',
    title: 'Codex skills',
    url: 'https://developers.openai.com/codex/skills',
    summary: 'Codex skills package instructions, resources, and scripts; implicit invocation is based on the skill description.',
  },
  {
    label: 'S6',
    title: 'Codex MCP',
    url: 'https://developers.openai.com/codex/mcp',
    summary: 'Codex configures MCP servers in config.toml and supports plugin-provided MCP servers.',
  },
  {
    label: 'S7',
    title: 'Codex hooks',
    url: 'https://developers.openai.com/codex/hooks',
    summary: 'Codex hooks run deterministic scripts during lifecycle events.',
  },
  {
    label: 'S8',
    title: 'Codex plugins and marketplaces',
    url: 'https://developers.openai.com/codex/plugins/build',
    summary: 'Codex plugins can package skills, apps, MCP servers, hooks, and marketplace metadata.',
  },
  {
    label: 'S9',
    title: 'AGENTS.md standard',
    url: 'https://agents.md/',
    summary: 'AGENTS.md provides repository instructions for coding agents.',
  },
];

function capability(status, primarySurface, options = {}) {
  return {
    status,
    primarySurface,
    role: options.role || 'native surface',
    activation: options.activation || 'explicit or harness-defined',
    renderer: options.renderer || null,
    evidence: options.evidence || [],
    knownIssue: options.knownIssue || null,
  };
}

const HARNESS_NAMES = {
  claude: 'Claude Code',
  cursor: 'Cursor',
  codex: 'OpenAI Codex',
};

const CAPABILITY_ROWS = [
  {
    id: 'instructions',
    renderer: 'instructions',
    role: 'project instruction projection',
    harnesses: {
      claude: { status: 'shim', surface: 'CLAUDE.md', evidence: ['S1', 'S9'] },
      cursor: { status: 'native', surface: 'AGENTS.md', evidence: ['S3', 'S9'] },
      codex: { status: 'native', surface: 'AGENTS.md', evidence: ['S9'] },
    },
  },
  {
    id: 'skills',
    renderer: 'skills',
    role: 'on-demand workflow',
    harnesses: {
      claude: { status: 'native', surface: '.claude/skills/<skill>/SKILL.md', activation: 'description match or /skill-name', evidence: ['S1', 'S2'] },
      cursor: { status: 'native', surface: '.cursor/skills/<skill>/SKILL.md', activation: 'description match or explicit skill invocation', evidence: ['S3'] },
      codex: { status: 'native', surface: '.codex/skills/<skill>/SKILL.md', activation: 'description match or explicit $skill mention', evidence: ['S5'] },
    },
  },
  {
    id: 'rules',
    renderer: 'rules',
    harnesses: {
      claude: { status: 'shim', surface: 'CLAUDE.md', role: 'always-on policy projection', evidence: ['S1'] },
      cursor: { status: 'native', surface: '.cursor/rules/<rule>.mdc', role: 'always-on or scoped policy', activation: 'description, globs, alwaysApply, or manual rule mention', evidence: ['S3'] },
      codex: { status: 'projection', surface: 'AGENTS.md', role: 'always-on policy projection', evidence: ['S9'] },
    },
  },
  {
    id: 'mcp',
    renderer: 'mcp',
    role: 'tool and resource plumbing',
    harnesses: {
      claude: { status: 'native', surface: 'Claude MCP config', evidence: ['S1'] },
      cursor: { status: 'native', surface: 'mcp.json', evidence: ['S4'] },
      codex: { status: 'native', surface: '.codex/config.toml', evidence: ['S6'] },
    },
  },
  {
    id: 'hooks',
    renderer: 'hooks',
    role: 'lifecycle enforcement',
    harnesses: {
      claude: { status: 'native', surface: 'Claude settings hooks', evidence: ['S1'] },
      cursor: {
        status: 'unsupported',
        surface: null,
        knownIssue: 'No verified Cursor hook surface; use Forge CLI hooks or file-watcher fallback until Cursor hook support is proven.',
      },
      codex: { status: 'native', surface: 'Codex hooks config', evidence: ['S7'] },
    },
  },
  {
    id: 'commands',
    renderer: 'commands',
    harnesses: {
      claude: { status: 'shim', surface: '.claude/commands/<stage>.md', role: 'compatibility shim', activation: 'explicit slash command forwarding to stage skill', evidence: ['S1'] },
      cursor: { status: 'compatibility', surface: '.cursor/commands/<stage>.md', role: 'optional explicit command affordance', evidence: ['S3'] },
      codex: { status: 'fallback', surface: '.codex/skills/<stage>/SKILL.md', role: 'skill fallback instead of command authority', activation: 'explicit $skill or description match', evidence: ['S5'] },
    },
  },
  {
    id: 'agents',
    renderer: 'agents',
    role: 'subagent role mapping',
    harnesses: {
      claude: { status: 'native', surface: '.claude/agents/<role>.md', evidence: ['S1'] },
      cursor: { status: 'unproven', surface: '.cursor/agents/<role>.md', knownIssue: 'Cursor agent/subagent file contract is not proven in Forge tests yet.' },
      codex: { status: 'skill-backed', surface: '.codex/skills/<role>/SKILL.md', role: 'subagent role fallback through skill metadata', evidence: ['S5'] },
    },
  },
  {
    id: 'stages',
    renderer: 'stage-graph',
    role: 'super skill with addressable subskills',
    harnesses: {
      claude: { status: 'skill-first', surface: '.claude/skills/<stage>/SKILL.md', evidence: ['S1'] },
      cursor: { status: 'skill-first', surface: '.cursor/skills/<stage>/SKILL.md', evidence: ['S3'] },
      codex: { status: 'skill-first', surface: '.codex/skills/<stage>/SKILL.md', evidence: ['S5'] },
    },
  },
  {
    id: 'beads',
    renderer: 'state-and-memory',
    role: 'issue and audit state authority',
    harnesses: Object.fromEntries(HARNESS_IDS.map(id => [id, { status: 'forge-owned', surface: 'forge CLI + bd adapter' }])),
  },
  {
    id: 'typedMemory',
    renderer: 'state-and-memory',
    role: 'typed memory projection',
    harnesses: {
      claude: { status: 'projection', surface: 'CLAUDE.md plus generated memory sections' },
      cursor: { status: 'projection', surface: 'AGENTS.md and .cursor/rules memory projections' },
      codex: { status: 'projection', surface: 'AGENTS.md plus Codex skill references' },
    },
  },
  {
    id: 'patchOverrides',
    renderer: 'state-and-memory',
    role: 'project override source',
    harnesses: Object.fromEntries(HARNESS_IDS.map(id => [id, { status: 'forge-owned', surface: '.forge/patch.md' }])),
  },
  {
    id: 'marketplaceTrust',
    renderer: 'distribution',
    role: 'trusted distribution metadata',
    harnesses: {
      claude: { status: 'plugin-aware', surface: 'Claude plugin or Forge lock metadata', evidence: ['S1'] },
      cursor: { status: 'forge-owned', surface: 'extension lock metadata' },
      codex: { status: 'native', surface: '.agents/plugins/marketplace.json plus plugin lock metadata', evidence: ['S8'] },
    },
  },
  {
    id: 'extensionPacks',
    renderer: 'distribution',
    harnesses: {
      claude: { status: 'plugin-aware', surface: 'plugin skills/commands/hooks', role: 'installable Forge extension pack', evidence: ['S1'] },
      cursor: { status: 'generated', surface: '.cursor/skills + .cursor/rules + mcp.json', role: 'installable Forge extension pack projection' },
      codex: { status: 'native', surface: 'Codex plugin with skills, MCP servers, hooks, and apps', role: 'installable Forge extension pack', evidence: ['S8'] },
    },
  },
];

function rowCapability(row, harnessId) {
  const target = row.harnesses[harnessId];
  return capability(target.status, target.surface, {
    role: target.role || row.role,
    activation: target.activation || row.activation,
    renderer: row.renderer,
    evidence: target.evidence,
    knownIssue: target.knownIssue,
  });
}

function buildHarnessCapabilities(harnessId) {
  return Object.fromEntries(
    CAPABILITY_ROWS.map(row => [row.id, rowCapability(row, harnessId)]),
  );
}

function buildHarnessCapabilityMatrix() {
  return {
    schemaVersion: '1.0.0',
    kind: 'forge.harnessCapabilityMatrix',
    scope: 'v3.0-mvp',
    harnesses: Object.fromEntries(HARNESS_IDS.map(id => [id, {
      id,
      name: HARNESS_NAMES[id],
      capabilities: buildHarnessCapabilities(id),
    }])),
  };
}

const STAGE_SUBSKILLS = {
  status: ['status.context_scan', 'status.issue_scan', 'status.git_scan'],
  plan: ['plan.intent_capture', 'plan.parallel_research', 'plan.parallel_critics', 'plan.synthesis', 'plan.final_lock'],
  dev: ['dev.red', 'dev.green', 'dev.refactor', 'dev.spec_review', 'dev.quality_review'],
  validate: ['validate.typecheck', 'validate.lint', 'validate.tests', 'validate.security', 'validate.context'],
  ship: ['ship.freshness', 'ship.push', 'ship.pr_body', 'ship.pr_create'],
  review: ['review.collect_feedback', 'review.classify', 'review.fix', 'review.resolve_threads'],
  premerge: ['premerge.docs', 'premerge.ci', 'premerge.handoff'],
  verify: ['verify.merge_state', 'verify.default_branch_ci', 'verify.cleanup', 'verify.issue_close'],
};

function buildSkillsFirstStageGraph() {
  return {
    schemaVersion: '1.0.0',
    kind: 'forge.skillsFirstStageGraph',
    rule: 'Stages are canonical super skills; commands are compatibility shims only.',
    stages: STAGE_IDS.map(id => ({
      id,
      canonicalSurface: 'skill',
      superSkill: id,
      subskills: STAGE_SUBSKILLS[id].map(subskillId => ({
        id: subskillId,
        parent: id,
      })),
      renderTargets: {
        claude: {
          skill: `.claude/skills/${id}/SKILL.md`,
          commandShim: {
            path: `.claude/commands/${id}.md`,
            pointsTo: `.claude/skills/${id}/SKILL.md`,
            shimOnly: true,
          },
        },
        cursor: {
          skill: `.cursor/skills/${id}/SKILL.md`,
          rulePolicy: `.cursor/rules/${id}.mdc`,
        },
        codex: {
          skill: `.codex/skills/${id}/SKILL.md`,
        },
      },
    })),
  };
}

const RENDERER_FAMILIES = [
  ['instructions', 'Forge typed instruction sections', ['semantic section comparison', 'target path exists']],
  ['skills', 'agentskills.io-compatible SKILL.md', ['frontmatter name/description', 'description-match fixture']],
  ['rules', 'Forge rule manifest', ['policy scope', 'activation metadata', 'unsupported target note']],
  ['mcp', 'Forge MCP manifest', ['config render', 'server probe or known issue']],
  ['hooks', 'Forge hook manifest', ['lifecycle event mapping', 'deny/allow behavior proof']],
  ['commands', 'Forge command shim manifest', ['shim points to canonical skill', 'no duplicated stage body']],
  ['agents', 'Forge agent role spec', ['role mapping', 'parallelism or fallback policy']],
  ['stage-graph', 'Forge skills-first stage graph', ['super skill target', 'subskill target list', 'gate mapping']],
  ['state-and-memory', 'Beads, typed memory, and patch override manifests', ['state authority', 'projection provenance', 'protected path policy']],
  ['distribution', 'Forge extension manifest and lock metadata', ['lock hash', 'trusted source', 'generated target inventory']],
];

function buildRendererContract() {
  return {
    schemaVersion: '1.0.0',
    kind: 'forge.harnessRendererContract',
    scope: 'contract-only',
    beforeAddingRenderer: [
      'capability-matrix-entry',
      'target-path-contract',
      'activation-metadata-contract',
      'machine-readable-evidence',
      'known-issue-if-unproven',
    ],
    rendererFamilies: RENDERER_FAMILIES.map(([id, canonicalInput, requiredEvidence]) => ({
      id,
      canonicalInput,
      requiredEvidence,
    })),
  };
}

function getHarnessCapabilityMatrix() {
  return buildHarnessCapabilityMatrix();
}

function getSkillsFirstStageGraph() {
  return buildSkillsFirstStageGraph();
}

function getRendererContract() {
  return buildRendererContract();
}

function buildHarnessCapabilityEvidence() {
  const matrix = getHarnessCapabilityMatrix();
  return {
    schemaVersion: matrix.schemaVersion,
    kind: matrix.kind,
    scope: matrix.scope,
    harnesses: HARNESS_IDS.map(id => ({
      id,
      name: matrix.harnesses[id].name,
      capabilities: matrix.harnesses[id].capabilities,
    })),
    stageGraph: getSkillsFirstStageGraph(),
    rendererContract: getRendererContract(),
    sources: SOURCES,
  };
}

module.exports = {
  CAPABILITY_IDS,
  HARNESS_IDS,
  SOURCES,
  STAGE_IDS,
  buildHarnessCapabilityEvidence,
  getHarnessCapabilityMatrix,
  getRendererContract,
  getSkillsFirstStageGraph,
};
