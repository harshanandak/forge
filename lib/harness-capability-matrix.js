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

function buildHarnessCapabilityMatrix() {
  return {
    schemaVersion: '1.0.0',
    kind: 'forge.harnessCapabilityMatrix',
    scope: 'v3.0-mvp',
    harnesses: {
      claude: {
        id: 'claude',
        name: 'Claude Code',
        capabilities: {
          instructions: capability('shim', 'CLAUDE.md', {
            role: 'project instruction projection',
            renderer: 'instructions',
            evidence: ['S1', 'S9'],
          }),
          skills: capability('native', '.claude/skills/<skill>/SKILL.md', {
            role: 'on-demand workflow',
            activation: 'description match or /skill-name',
            renderer: 'skills',
            evidence: ['S1', 'S2'],
          }),
          rules: capability('shim', 'CLAUDE.md', {
            role: 'always-on policy projection',
            renderer: 'rules',
            evidence: ['S1'],
          }),
          mcp: capability('native', 'Claude MCP config', {
            role: 'tool and resource plumbing',
            renderer: 'mcp',
            evidence: ['S1'],
          }),
          hooks: capability('native', 'Claude settings hooks', {
            role: 'lifecycle enforcement',
            renderer: 'hooks',
            evidence: ['S1'],
          }),
          commands: capability('shim', '.claude/commands/<stage>.md', {
            role: 'compatibility shim',
            activation: 'explicit slash command forwarding to stage skill',
            renderer: 'commands',
            evidence: ['S1'],
          }),
          agents: capability('native', '.claude/agents/<role>.md', {
            role: 'subagent role mapping',
            renderer: 'agents',
            evidence: ['S1'],
          }),
          stages: capability('skill-first', '.claude/skills/<stage>/SKILL.md', {
            role: 'super skill with addressable subskills',
            renderer: 'stage-graph',
            evidence: ['S1'],
          }),
          beads: capability('forge-owned', 'forge CLI + bd adapter', {
            role: 'issue and audit state authority',
            renderer: 'state-and-memory',
          }),
          typedMemory: capability('projection', 'CLAUDE.md plus generated memory sections', {
            role: 'typed memory projection',
            renderer: 'state-and-memory',
          }),
          patchOverrides: capability('forge-owned', '.forge/patch.md', {
            role: 'project override source',
            renderer: 'state-and-memory',
          }),
          marketplaceTrust: capability('plugin-aware', 'Claude plugin or Forge lock metadata', {
            role: 'trusted distribution metadata',
            renderer: 'distribution',
            evidence: ['S1'],
          }),
          extensionPacks: capability('plugin-aware', 'plugin skills/commands/hooks', {
            role: 'installable Forge extension pack',
            renderer: 'distribution',
            evidence: ['S1'],
          }),
        },
      },
      cursor: {
        id: 'cursor',
        name: 'Cursor',
        capabilities: {
          instructions: capability('native', 'AGENTS.md', {
            role: 'project instruction projection',
            renderer: 'instructions',
            evidence: ['S3', 'S9'],
          }),
          skills: capability('native', '.cursor/skills/<skill>/SKILL.md', {
            role: 'on-demand workflow',
            activation: 'description match or explicit skill invocation',
            renderer: 'skills',
            evidence: ['S3'],
          }),
          rules: capability('native', '.cursor/rules/<rule>.mdc', {
            role: 'always-on or scoped policy',
            activation: 'description, globs, alwaysApply, or manual rule mention',
            renderer: 'rules',
            evidence: ['S3'],
          }),
          mcp: capability('native', 'mcp.json', {
            role: 'tool and resource plumbing',
            renderer: 'mcp',
            evidence: ['S4'],
          }),
          hooks: capability('unsupported', null, {
            role: 'lifecycle enforcement',
            renderer: 'hooks',
            knownIssue: 'No verified Cursor hook surface; use Forge CLI hooks or file-watcher fallback until Cursor hook support is proven.',
          }),
          commands: capability('compatibility', '.cursor/commands/<stage>.md', {
            role: 'optional explicit command affordance',
            renderer: 'commands',
            evidence: ['S3'],
          }),
          agents: capability('unproven', '.cursor/agents/<role>.md', {
            role: 'subagent role mapping',
            renderer: 'agents',
            knownIssue: 'Cursor agent/subagent file contract is not proven in Forge tests yet.',
          }),
          stages: capability('skill-first', '.cursor/skills/<stage>/SKILL.md', {
            role: 'super skill with addressable subskills',
            renderer: 'stage-graph',
            evidence: ['S3'],
          }),
          beads: capability('forge-owned', 'forge CLI + bd adapter', {
            role: 'issue and audit state authority',
            renderer: 'state-and-memory',
          }),
          typedMemory: capability('projection', 'AGENTS.md and .cursor/rules memory projections', {
            role: 'typed memory projection',
            renderer: 'state-and-memory',
          }),
          patchOverrides: capability('forge-owned', '.forge/patch.md', {
            role: 'project override source',
            renderer: 'state-and-memory',
          }),
          marketplaceTrust: capability('forge-owned', 'extension lock metadata', {
            role: 'trusted distribution metadata',
            renderer: 'distribution',
          }),
          extensionPacks: capability('generated', '.cursor/skills + .cursor/rules + mcp.json', {
            role: 'installable Forge extension pack projection',
            renderer: 'distribution',
          }),
        },
      },
      codex: {
        id: 'codex',
        name: 'OpenAI Codex',
        capabilities: {
          instructions: capability('native', 'AGENTS.md', {
            role: 'project instruction projection',
            renderer: 'instructions',
            evidence: ['S9'],
          }),
          skills: capability('native', '.codex/skills/<skill>/SKILL.md', {
            role: 'on-demand workflow',
            activation: 'description match or explicit $skill mention',
            renderer: 'skills',
            evidence: ['S5'],
          }),
          rules: capability('projection', 'AGENTS.md', {
            role: 'always-on policy projection',
            renderer: 'rules',
            evidence: ['S9'],
          }),
          mcp: capability('native', '.codex/config.toml', {
            role: 'tool and resource plumbing',
            renderer: 'mcp',
            evidence: ['S6'],
          }),
          hooks: capability('native', 'Codex hooks config', {
            role: 'lifecycle enforcement',
            renderer: 'hooks',
            evidence: ['S7'],
          }),
          commands: capability('fallback', '.codex/skills/<stage>/SKILL.md', {
            role: 'skill fallback instead of command authority',
            activation: 'explicit $skill or description match',
            renderer: 'commands',
            evidence: ['S5'],
          }),
          agents: capability('skill-backed', '.codex/skills/<role>/SKILL.md', {
            role: 'subagent role fallback through skill metadata',
            renderer: 'agents',
            evidence: ['S5'],
          }),
          stages: capability('skill-first', '.codex/skills/<stage>/SKILL.md', {
            role: 'super skill with addressable subskills',
            renderer: 'stage-graph',
            evidence: ['S5'],
          }),
          beads: capability('forge-owned', 'forge CLI + bd adapter', {
            role: 'issue and audit state authority',
            renderer: 'state-and-memory',
          }),
          typedMemory: capability('projection', 'AGENTS.md plus Codex skill references', {
            role: 'typed memory projection',
            renderer: 'state-and-memory',
          }),
          patchOverrides: capability('forge-owned', '.forge/patch.md', {
            role: 'project override source',
            renderer: 'state-and-memory',
          }),
          marketplaceTrust: capability('native', '.agents/plugins/marketplace.json plus plugin lock metadata', {
            role: 'trusted distribution metadata',
            renderer: 'distribution',
            evidence: ['S8'],
          }),
          extensionPacks: capability('native', 'Codex plugin with skills, MCP servers, hooks, and apps', {
            role: 'installable Forge extension pack',
            renderer: 'distribution',
            evidence: ['S8'],
          }),
        },
      },
    },
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
    rendererFamilies: [
      {
        id: 'instructions',
        canonicalInput: 'Forge typed instruction sections',
        requiredEvidence: ['semantic section comparison', 'target path exists'],
      },
      {
        id: 'skills',
        canonicalInput: 'agentskills.io-compatible SKILL.md',
        requiredEvidence: ['frontmatter name/description', 'description-match fixture'],
      },
      {
        id: 'rules',
        canonicalInput: 'Forge rule manifest',
        requiredEvidence: ['policy scope', 'activation metadata', 'unsupported target note'],
      },
      {
        id: 'mcp',
        canonicalInput: 'Forge MCP manifest',
        requiredEvidence: ['config render', 'server probe or known issue'],
      },
      {
        id: 'hooks',
        canonicalInput: 'Forge hook manifest',
        requiredEvidence: ['lifecycle event mapping', 'deny/allow behavior proof'],
      },
      {
        id: 'commands',
        canonicalInput: 'Forge command shim manifest',
        requiredEvidence: ['shim points to canonical skill', 'no duplicated stage body'],
      },
      {
        id: 'agents',
        canonicalInput: 'Forge agent role spec',
        requiredEvidence: ['role mapping', 'parallelism or fallback policy'],
      },
      {
        id: 'stage-graph',
        canonicalInput: 'Forge skills-first stage graph',
        requiredEvidence: ['super skill target', 'subskill target list', 'gate mapping'],
      },
      {
        id: 'state-and-memory',
        canonicalInput: 'Beads, typed memory, and patch override manifests',
        requiredEvidence: ['state authority', 'projection provenance', 'protected path policy'],
      },
      {
        id: 'distribution',
        canonicalInput: 'Forge extension manifest and lock metadata',
        requiredEvidence: ['lock hash', 'trusted source', 'generated target inventory'],
      },
    ],
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
