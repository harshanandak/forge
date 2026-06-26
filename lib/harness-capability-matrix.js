'use strict';

const { STAGE_IDS: WORKFLOW_STAGE_IDS } = require('./workflow/stages');

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

const STAGE_IDS = [...WORKFLOW_STAGE_IDS];
const UTILITY_SKILL_IDS = ['status', 'shepherd'];

const SOURCE_ROWS = [
  ['S1', 'Claude Code skills', 'https://code.claude.com/docs/en/skills', 'Claude Code skills use SKILL.md frontmatter descriptions for automatic invocation; commands remain compatible but skills are recommended.'],
  ['S2', 'Claude Agent SDK skills', 'https://code.claude.com/docs/en/agent-sdk/skills.md', 'Claude SDK loads project/user/plugin skills and invokes them based on description metadata.'],
  ['S3', 'Cursor rules', 'https://docs.cursor.com/en/context', 'Cursor project rules live in .cursor/rules as .mdc files with description, globs, and alwaysApply metadata.'],
  ['S4', 'Cursor MCP', 'https://docs.cursor.com/context/model-context-protocol', 'Cursor connects external tools and data sources through MCP using stdio, SSE, and streamable HTTP transports.'],
  ['S5', 'Codex skills', 'https://developers.openai.com/codex/skills', 'Codex skills package instructions, resources, and scripts; Forge currently generates .codex/skills packages for installation, while direct Codex repo discovery uses .agents/skills.'],
  ['S6', 'Codex MCP', 'https://developers.openai.com/codex/mcp', 'Codex configures MCP servers in config.toml and supports plugin-provided MCP servers.'],
  ['S7', 'Codex hooks', 'https://developers.openai.com/codex/hooks', 'Codex hooks run deterministic scripts during lifecycle events.'],
  ['S8', 'Codex plugins and marketplaces', 'https://developers.openai.com/codex/plugins/build', 'Codex plugins can package skills, apps, MCP servers, hooks, and marketplace metadata.'],
  ['S9', 'AGENTS.md standard', 'https://agents.md/', 'AGENTS.md provides repository instructions for coding agents.'],
];

const SOURCES = SOURCE_ROWS.map(([label, title, url, summary]) => ({
  label,
  title,
  url,
  summary,
}));

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

function harnessTargets(entries) {
  return Object.fromEntries(entries.map(([id, target]) => [id, target]));
}

function target(status, surface, overrides = {}) {
  return { status, surface, ...overrides };
}

function row(id, renderer, role, entries) {
  return {
    id,
    renderer,
    role,
    harnesses: harnessTargets(entries),
  };
}

const CAPABILITY_ROWS = [
  row('instructions', 'instructions', 'project instruction projection', [
    ['claude', target('shim', 'CLAUDE.md', { evidence: ['S1', 'S9'] })],
    ['cursor', target('native', 'AGENTS.md', { evidence: ['S3', 'S9'] })],
    ['codex', target('native', 'AGENTS.md', { evidence: ['S9'] })],
  ]),
  row('skills', 'skills', 'on-demand workflow', [
    ['claude', target('native', '.claude/skills/<skill>/SKILL.md', { activation: 'description match or /skill-name', evidence: ['S1', 'S2'] })],
    ['cursor', target('unproven', '.cursor/skills/<skill>/SKILL.md', { activation: 'description match or explicit skill invocation', knownIssue: 'Cursor Agent Skills are the intended on-demand workflow target, but Forge does not yet have matching source evidence or live invocation proof.' })],
    ['codex', target('packaged', '.codex/skills/<skill>/SKILL.md', { activation: 'description match or explicit $skill mention after install', evidence: ['S5'], knownIssue: 'Direct Codex repo discovery uses .agents/skills; migrate Forge generators before changing this renderer target.' })],
  ]),
  row('rules', 'rules', null, [
    ['claude', target('shim', 'CLAUDE.md', { role: 'always-on policy projection', evidence: ['S1'] })],
    ['cursor', target('native', '.cursor/rules/<rule>.mdc', { role: 'always-on or scoped policy', activation: 'description, globs, alwaysApply, or manual rule mention', evidence: ['S3'] })],
    ['codex', target('projection', 'AGENTS.md', { role: 'always-on policy projection', evidence: ['S9'] })],
  ]),
  row('mcp', 'mcp', 'tool and resource plumbing', [
    ['claude', target('native', 'Claude MCP config', { evidence: ['S1'] })],
    ['cursor', target('native', '.cursor/mcp.json', { evidence: ['S4'] })],
    ['codex', target('native', '.codex/config.toml', { evidence: ['S6'] })],
  ]),
  row('hooks', 'hooks', 'lifecycle enforcement', [
    ['claude', target('native', 'Claude settings hooks', { evidence: ['S1'] })],
    ['cursor', target('unsupported', null, { knownIssue: 'No verified Cursor hook surface; use Forge CLI hooks or file-watcher fallback until Cursor hook support is proven.' })],
    ['codex', target('native', 'Codex hooks config', { evidence: ['S7'] })],
  ]),
  row('commands', 'commands', null, [
    ['claude', target('shim', '.claude/commands/<stage>.md', { role: 'compatibility shim', activation: 'explicit slash command forwarding to stage skill', evidence: ['S1'] })],
    ['cursor', target('compatibility', '.cursor/commands/<stage>.md', { role: 'optional explicit command affordance', evidence: ['S3'] })],
    ['codex', target('fallback', '.codex/skills/<stage>/SKILL.md', { role: 'skill fallback instead of command authority', activation: 'explicit $skill or description match after install', evidence: ['S5'], knownIssue: 'Direct Codex repo discovery uses .agents/skills; migrate Forge generators before changing this renderer target.' })],
  ]),
  row('agents', 'agents', 'subagent role mapping', [
    ['claude', target('native', '.claude/agents/<role>.md', { evidence: ['S1'] })],
    ['cursor', target('unproven', '.cursor/agents/<role>.md', { knownIssue: 'Cursor agent/subagent file contract is not proven in Forge tests yet.' })],
    ['codex', target('skill-backed', '.codex/skills/<role>/SKILL.md', { role: 'subagent role fallback through skill metadata', evidence: ['S5'], knownIssue: 'Direct Codex repo discovery uses .agents/skills; migrate Forge generators before changing this renderer target.' })],
  ]),
  row('stages', 'stage-graph', 'super skill with addressable subskills', [
    ['claude', target('skill-first', '.claude/skills/<stage>/SKILL.md', { evidence: ['S1'] })],
    ['cursor', target('unproven', '.cursor/skills/<stage>/SKILL.md', { knownIssue: 'Cursor Agent Skills are the intended stage target, but Forge does not yet have matching source evidence or live invocation proof.' })],
    ['codex', target('skill-first', '.codex/skills/<stage>/SKILL.md', { evidence: ['S5'], knownIssue: 'Direct Codex repo discovery uses .agents/skills; migrate Forge generators before changing this renderer target.' })],
  ]),
  row('beads', 'state-and-memory', 'issue and audit state authority', HARNESS_IDS.map(id => [id, target('forge-owned', 'forge CLI + bd adapter')])),
  row('typedMemory', 'state-and-memory', 'typed memory projection', [
    ['claude', target('projection', 'CLAUDE.md plus generated memory sections')],
    ['cursor', target('projection', 'AGENTS.md and .cursor/rules memory projections')],
    ['codex', target('projection', 'AGENTS.md plus Codex skill references')],
  ]),
  row('patchOverrides', 'state-and-memory', 'project override source', HARNESS_IDS.map(id => [id, target('forge-owned', '.forge/patch.md')])),
  row('marketplaceTrust', 'distribution', 'trusted distribution metadata', [
    ['claude', target('plugin-aware', 'Claude plugin or Forge lock metadata', { evidence: ['S1'] })],
    ['cursor', target('forge-owned', 'extension lock metadata')],
    ['codex', target('native', '.agents/plugins/marketplace.json plus plugin lock metadata', { evidence: ['S8'] })],
  ]),
  row('extensionPacks', 'distribution', null, [
    ['claude', target('plugin-aware', 'plugin skills/commands/hooks', { role: 'installable Forge extension pack', evidence: ['S1'] })],
    ['cursor', target('generated', '.cursor/skills + .cursor/rules + .cursor/mcp.json', { role: 'installable Forge extension pack projection' })],
    ['codex', target('native', 'Codex plugin with skills, MCP servers, hooks, and apps', { role: 'installable Forge extension pack', evidence: ['S8'] })],
  ]),
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
  shepherd: ['shepherd.poll', 'shepherd.rerun', 'shepherd.escalate'],
  plan: ['plan.intent_capture', 'plan.parallel_research', 'plan.parallel_critics', 'plan.synthesis', 'plan.final_lock'],
  dev: ['dev.red', 'dev.green', 'dev.refactor', 'dev.spec_review', 'dev.quality_review'],
  validate: ['validate.typecheck', 'validate.lint', 'validate.tests', 'validate.security', 'validate.context'],
  ship: ['ship.freshness', 'ship.push', 'ship.pr_body', 'ship.pr_create'],
  review: ['review.collect_feedback', 'review.classify', 'review.fix', 'review.resolve_threads'],
  premerge: ['premerge.docs', 'premerge.ci', 'premerge.handoff'],
  verify: ['verify.merge_state', 'verify.default_branch_ci', 'verify.cleanup', 'verify.issue_close'],
};

function buildSkillsFirstStageGraph() {
  const renderTargetsForSkill = (id) => ({
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
      status: 'unproven',
      knownIssue: 'Cursor Agent Skills are the intended stage target, but Forge does not yet have matching source evidence or live invocation proof.',
      rulePolicy: `.cursor/rules/${id}.mdc`,
    },
    codex: {
      skill: `.codex/skills/${id}/SKILL.md`,
      installTarget: '$CODEX_HOME/skills',
      directRepoDiscoveryTarget: `.agents/skills/${id}/SKILL.md`,
    },
  });

  return {
    schemaVersion: '1.0.0',
    kind: 'forge.skillsFirstStageGraph',
    rule: 'Stages are canonical super skills; commands are compatibility shims only.',
    stages: STAGE_IDS.map(id => ({
      id,
      canonicalSurface: 'skill',
      workflowStage: true,
      superSkill: id,
      subskills: STAGE_SUBSKILLS[id].map(subskillId => ({
        id: subskillId,
        parent: id,
      })),
      renderTargets: renderTargetsForSkill(id),
    })),
    utilitySkills: UTILITY_SKILL_IDS.map(id => ({
      id,
      canonicalSurface: 'skill',
      workflowStage: false,
      superSkill: id,
      subskills: STAGE_SUBSKILLS[id].map(subskillId => ({
        id: subskillId,
        parent: id,
      })),
      renderTargets: renderTargetsForSkill(id),
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
    kind: 'forge.harnessCapabilityEvidence',
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
  UTILITY_SKILL_IDS,
  buildHarnessCapabilityEvidence,
  getHarnessCapabilityMatrix,
  getRendererContract,
  getSkillsFirstStageGraph,
};
