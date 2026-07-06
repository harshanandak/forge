'use strict';

const { STAGE_IDS: WORKFLOW_STAGE_IDS } = require('./workflow/stages');

const HARNESS_IDS = ['claude', 'cursor', 'codex', 'hermes'];

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
  'permissions',
  'ignore',
  'sandbox',
];

const STAGE_IDS = [...WORKFLOW_STAGE_IDS];
const UTILITY_SKILL_IDS = ['status', 'shepherd'];

const SOURCE_ROWS = [
  ['S1', 'Claude Code skills', 'https://code.claude.com/docs/en/skills', 'Claude Code skills use SKILL.md frontmatter descriptions for automatic invocation; commands remain compatible but skills are recommended.'],
  ['S2', 'Claude Agent SDK skills', 'https://code.claude.com/docs/en/agent-sdk/skills.md', 'Claude SDK loads project/user/plugin skills and invokes them based on description metadata.'],
  ['S3', 'Cursor rules', 'https://docs.cursor.com/en/context', 'Cursor project rules live in .cursor/rules as .mdc files with description, globs, and alwaysApply metadata.'],
  ['S4', 'Cursor MCP', 'https://docs.cursor.com/context/model-context-protocol', 'Cursor connects external tools and data sources through MCP using stdio, SSE, and streamable HTTP transports.'],
  ['S5', 'Codex skills', 'https://developers.openai.com/codex/skills', 'Codex skills package instructions, resources, and scripts; Codex scans .agents/skills from cwd up to the repo root for repo-scope discovery. Forge generates .codex/skills packages for the global $CODEX_HOME install AND commits the repo-local .agents/skills mirror for teammate-clone discovery.'],
  ['S6', 'Codex MCP', 'https://developers.openai.com/codex/mcp', 'Codex configures MCP servers in config.toml and supports plugin-provided MCP servers.'],
  ['S7', 'Codex hooks', 'https://developers.openai.com/codex/hooks', 'Codex hooks run deterministic scripts during lifecycle events.'],
  ['S8', 'Codex plugins and marketplaces', 'https://developers.openai.com/codex/plugins/build', 'Codex plugins can package skills, apps, MCP servers, hooks, and marketplace metadata.'],
  ['S9', 'AGENTS.md standard', 'https://agents.md/', 'AGENTS.md provides repository instructions for coding agents.'],
  ['S10', 'Cursor Agent Skills', 'https://docs.cursor.com/en/agent/skills', 'Cursor reads on-demand Agent Skills from .cursor/skills/<name>/SKILL.md; Forge populates them at setup from the canonical skills/ source.'],
  ['S11', 'Claude Code settings permissions', 'https://docs.claude.com/en/docs/claude-code/settings', 'Claude Code reads project-local .claude/settings.json with a permissions block (allow/deny/ask rule arrays, evaluated deny then ask then allow); rule syntax is Bash(prefix:*), Read(glob), WebFetch(domain:...).'],
  ['S12', 'Cursor ignore files', 'https://cursor.com/docs/reference/ignore-file', 'Cursor reads project-local .cursorignore (blocks AI access + indexing) and .cursorindexingignore (index-only), gitignore-style; .gitignore and common secret/lock files are ignored by default.'],
  ['S13', 'Codex sandbox and approvals config', 'https://developers.openai.com/codex/config-reference', 'Codex config.toml sets sandbox_mode (read-only/workspace-write/danger-full-access) and approval_policy (untrusted/on-request/never); a project-local .codex/config.toml is honored ONLY when the project is trusted in the GLOBAL $CODEX_HOME/config.toml (projects.<path>.trust_level).'],
  ['S14', 'Claude Code hooks', 'https://code.claude.com/docs/en/hooks', 'Claude Code hooks live in .claude/settings.json under a `hooks` block; a PreToolUse matcher group (e.g. "Write|Edit"/"Bash") runs a command that can deny the tool call via hookSpecificOutput.permissionDecision.'],
  ['S15', 'Cursor hooks', 'https://cursor.com/docs/hooks', 'Cursor 1.7+ reads project-local .cursor/hooks.json ({ version: 1, hooks }); only before* events (beforeShellExecution/beforeReadFile/beforeMCPExecution) can deny — there is no pre-edit deny event, so afterFileEdit is observational.'],
];

// The closed set of capability statuses. Every capability-matrix target status MUST
// be one of these — a test in test/harness-capability-matrix.test.js enforces it so
// no future row can introduce an off-vocabulary (and likely dishonest) status.
const STATUS_VOCABULARY = [
  'native',         // Forge renders the harness's native surface and it is delivered
  'shim',           // instruction shim (e.g. CLAUDE.md → AGENTS.md)
  'projection',     // policy projected into an instruction file (delivered)
  'cli-consumed',   // consumed through the forge CLI (Hermes)
  'forge-owned',    // Forge-owned state/projection (beads, patch overrides, .hermes/skills, locks)
  'packaged',       // packaged/staged for install into a global/harness location
  'fallback',       // skill fallback stands in for an unsupported surface
  'skill-first',    // stage delivered as a skill (no command surface)
  'plugin-aware',   // delivered via the harness plugin/marketplace mechanism
  'generated',      // composite of other generated surfaces
  'contract-only',  // capability delivered via a contract (git hooks), NOT a harness-native render
  'not-delivered',  // Forge does not yet render this surface (honest not-yet-delivered)
  'unsupported',    // the harness has no such surface
  'removed',        // the surface was intentionally removed
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
  hermes: 'Hermes',
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
    ['hermes', target('cli-consumed', 'AGENTS.md via forge orient/recap', { role: 'CLI-consumed instruction projection', evidence: ['S9'] })],
  ]),
  row('skills', 'skills', 'on-demand workflow', [
    ['claude', target('native', '.claude/skills/<skill>/SKILL.md', { activation: 'description match or /skill-name', evidence: ['S1', 'S2'] })],
    ['cursor', target('native', '.cursor/skills/<skill>/SKILL.md', { activation: 'description match or explicit skill invocation', evidence: ['S3', 'S10'] })],
    ['codex', target('packaged', '$CODEX_HOME/skills/<skill>/SKILL.md', { role: 'installed from the committed .codex/skills staging mirror', activation: 'description match or explicit $skill mention after install', evidence: ['S5'], knownIssue: 'Codex installs to the GLOBAL $CODEX_HOME/skills; .codex/skills is the packaging staging mirror, not the install path. Repo-local discovery uses .agents/skills/<skill>/SKILL.md, now generated at setup and committed for teammate-clone discovery (kernel issue 55dfeccf).' })],
    ['hermes', target('forge-owned', '.hermes/skills/<skill>/SKILL.md', { role: 'Forge-owned skill projection consumed via forge orient/recap', activation: 'forge orient/recap CLI' })],
  ]),
  row('rules', 'rules', null, [
    ['claude', target('shim', 'CLAUDE.md', { role: 'always-on policy projection', evidence: ['S1'] })],
    ['cursor', target('native', '.cursor/rules/<rule>.mdc', { role: 'always-on or scoped policy', activation: 'description, globs, alwaysApply, or manual rule mention', evidence: ['S3'] })],
    ['codex', target('projection', 'AGENTS.md', { role: 'always-on policy projection', evidence: ['S9'] })],
    ['hermes', target('projection', 'AGENTS.md via forge orient', { role: 'always-on policy projection', evidence: ['S9'] })],
  ]),
  row('mcp', 'mcp', 'tool and resource plumbing', [
    ['claude', target('native', '.mcp.json', { evidence: ['S1'] })],
    ['cursor', target('native', '.cursor/mcp.json', { evidence: ['S4'] })],
    ['codex', target('not-delivered', null, { role: 'Codex reads the GLOBAL $CODEX_HOME/config.toml (per agents-config.js), not a project-local file', knownIssue: 'Forge does not write the global Codex MCP config during project setup; the Codex TOML renderer exists and is tested but is not wired. Tracked as kernel epic 90f2f631.', evidence: ['S6'] })],
    ['hermes', target('unsupported', null, { knownIssue: 'Hermes consumes Forge state through the CLI (forge orient/recap); it has no native MCP config surface.' })],
  ]),
  row('hooks', 'hooks', 'lifecycle enforcement', [
    ['claude', target('native', '.claude/settings.json', { role: 'native PreToolUse hooks projecting Forge TDD-gate + protected-path enforcement (lib/hook-renderer.js), invoking the installed .forge/hooks/forge-native-hook.js adapter', evidence: ['S14'] })],
    ['cursor', target('native', '.cursor/hooks.json', { role: 'native Cursor 1.7+ hooks projecting Forge enforcement via the installed forge-native-hook.js adapter', knownIssue: 'Cursor 1.7+ has NO pre-edit deny event, so protected-path write-blocking + the TDD gate run on beforeShellExecution and afterFileEdit is an observational audit; the git-hook path remains the authoritative pre-commit gate.', evidence: ['S15'] })],
    ['codex', target('not-delivered', null, { role: 'Codex reads the GLOBAL ~/.codex/config.toml (per #311 / agents-config.js), so project setup cannot write it', knownIssue: 'Codex supports native hooks (S7) but they live in the global ~/.codex/config.toml; the Codex [hooks] TOML renderer exists and is tested (renderCodexHooksToml) but is intentionally not wired at project setup. Tracked for a global-config follow-up (epic 90f2f631).', evidence: ['S7'] })],
    ['hermes', target('unsupported', null, { knownIssue: 'No Hermes hook surface; lifecycle enforcement runs through Forge CLI gates and git hooks.' })],
  ]),
  row('commands', 'commands', null, [
    ['claude', target('removed', null, { role: 'legacy .claude/commands/ surface removed in A0d; stage skills live in .claude/skills/<stage>/SKILL.md', evidence: ['S1'] })],
    ['cursor', target('removed', null, { role: 'legacy .cursor/commands/ surface removed in A0d; stage skills live in .cursor/skills/<stage>/SKILL.md', evidence: ['S3'] })],
    ['codex', target('fallback', '$CODEX_HOME/skills/<stage>/SKILL.md', { role: 'skill fallback (installed from the .codex/skills staging mirror) instead of command authority', activation: 'explicit $skill or description match after install', evidence: ['S5'], knownIssue: 'Repo-local Codex discovery uses .agents/skills, now generated at setup and committed for teammate-clone discovery (kernel issue 55dfeccf).' })],
    ['hermes', target('cli-consumed', 'forge orient / forge recap', { role: 'CLI command surface instead of command files' })],
  ]),
  row('agents', 'agents', 'subagent role mapping', [
    ['claude', target('not-delivered', null, { role: 'Claude supports .claude/agents/<role>.md, but Forge renders no subagent files', knownIssue: 'The whole agents/subagents domain is unimplemented — no renderer, manifest, wiring, or tests for any harness. Tracked as kernel issue 802aa4d8 (epic 90f2f631).', evidence: ['S1'] })],
    ['cursor', target('not-delivered', null, { knownIssue: 'No Cursor subagent renderer; the agents domain is unimplemented. Tracked as kernel issue 802aa4d8 (epic 90f2f631).' })],
    ['codex', target('not-delivered', null, { role: 'skill-backing not implemented', knownIssue: 'No Codex subagent/skill-backing renderer; the agents domain is unimplemented. Tracked as kernel issue 802aa4d8 (epic 90f2f631).', evidence: ['S5'] })],
    ['hermes', target('unsupported', null, { knownIssue: 'Hermes has no subagent file contract; it is a CLI-consumed harness.' })],
  ]),
  row('stages', 'stage-graph', 'super skill with addressable subskills', [
    ['claude', target('skill-first', '.claude/skills/<stage>/SKILL.md', { evidence: ['S1'] })],
    ['cursor', target('native', '.cursor/skills/<stage>/SKILL.md', { evidence: ['S3', 'S10'] })],
    ['codex', target('skill-first', '$CODEX_HOME/skills/<stage>/SKILL.md', { role: 'installed from the .codex/skills staging mirror', evidence: ['S5'], knownIssue: 'Repo-local Codex discovery uses .agents/skills/<stage>/SKILL.md, now generated at setup and committed for teammate-clone discovery (kernel issue 55dfeccf).' })],
    ['hermes', target('forge-owned', '.hermes/skills/<stage>/SKILL.md', { role: 'Forge-owned stage-skill projection consumed via forge orient/recap' })],
  ]),
  row('beads', 'state-and-memory', 'issue and audit state authority', HARNESS_IDS.map(id => [id, target('forge-owned', 'forge CLI + bd adapter')])),
  row('typedMemory', 'state-and-memory', 'typed memory projection', [
    ['claude', target('not-delivered', null, { knownIssue: 'Typed memory is WRITE-ONLY (insights.js); no generator projects a memory section into any Claude instruction/rule file. Tracked as kernel issue dce9da46 (epic 90f2f631).' })],
    ['cursor', target('not-delivered', null, { knownIssue: 'Typed memory is write-only; no memory-projection renderer emits a Cursor memory section. Tracked as kernel issue dce9da46 (epic 90f2f631).' })],
    ['codex', target('not-delivered', null, { knownIssue: 'Typed memory is write-only; no memory-projection renderer emits a Codex memory section. Tracked as kernel issue dce9da46 (epic 90f2f631).' })],
    ['hermes', target('not-delivered', null, { knownIssue: 'Typed memory is write-only; forge recall reads notes but no renderer emits a Hermes memory section. Tracked as kernel issue dce9da46 (epic 90f2f631).' })],
  ]),
  row('patchOverrides', 'state-and-memory', 'project override source', HARNESS_IDS.map(id => [id, target('forge-owned', '.forge/patch.md')])),
  row('marketplaceTrust', 'distribution', 'trusted distribution metadata', [
    ['claude', target('plugin-aware', 'Claude plugin or Forge lock metadata', { evidence: ['S1'] })],
    ['cursor', target('forge-owned', 'extension lock metadata')],
    ['codex', target('native', '.agents/plugins/marketplace.json plus plugin lock metadata', { evidence: ['S8'] })],
    ['hermes', target('forge-owned', 'Forge extension lock metadata')],
  ]),
  row('extensionPacks', 'distribution', null, [
    ['claude', target('plugin-aware', 'plugin skills/commands/hooks', { role: 'installable Forge extension pack', evidence: ['S1'] })],
    ['cursor', target('generated', '.cursor/skills + .cursor/rules + .cursor/mcp.json', { role: 'installable Forge extension pack projection' })],
    ['codex', target('native', 'Codex plugin with skills, MCP servers, hooks, and apps', { role: 'installable Forge extension pack', evidence: ['S8'] })],
    ['hermes', target('forge-owned', '.hermes/skills projected from Forge extension state', { role: 'installable Forge extension pack projection' })],
  ]),
  // ---- Native SAFETY surfaces (Tier-2 parity) ----
  // Security/safety boundaries each harness ships that Forge sets sane defaults for.
  row('permissions', 'safety', 'tool-permission allowlist', [
    ['claude', target('native', '.claude/settings.json (permissions allow/deny/ask)', { role: 'declarative tool-permission allowlist rendered with safe forge/dev defaults', activation: 'evaluated deny -> ask -> allow on each tool call', evidence: ['S11'] })],
    ['cursor', target('unsupported', null, { knownIssue: 'Cursor command allow/deny lists are IDE/global settings (Settings > Chat & Composer), not a project-local committable file; Forge cannot render a project-local Cursor permission allowlist.' })],
    ['codex', target('not-delivered', null, { role: "Codex approvals live in config.toml (approval_policy)", knownIssue: 'Codex approval_policy is a config.toml surface honored project-locally ONLY when the project is trusted in the GLOBAL $CODEX_HOME/config.toml (projects.<path>.trust_level). Forge cannot grant that global trust during project-local setup, so it is deferred to global-scope wiring. Tracked as kernel epic 90f2f631 (#311).', evidence: ['S13'] })],
    ['hermes', target('unsupported', null, { knownIssue: 'Hermes is CLI-consumed (forge orient/recap); it has no tool-permission allowlist surface.' })],
  ]),
  row('ignore', 'safety', 'AI read/index boundary', [
    ['claude', target('projection', '.claude/settings.json (permissions.deny Read rules)', { role: 'read/secret boundary projected into permission deny rules (no dedicated ignore file)', knownIssue: 'Claude Code has no .claudeignore file; the read/secret boundary is delivered as permissions.deny Read(...) rules by the permissions renderer, not a separate ignore file.', evidence: ['S11'] })],
    ['cursor', target('native', '.cursorignore', { role: 'keeps secrets and large/generated dirs out of AI context + index (also .cursorindexingignore for index-only)', activation: 'gitignore-style patterns honored by Cursor AI features', evidence: ['S12'], knownIssue: '.cursorignore blocks Cursor AI features and indexing but is NOT a hard security boundary — terminal/MCP tools can still reach the files.' })],
    ['codex', target('unsupported', null, { knownIssue: 'Codex has no dedicated AI read/index-ignore file; it honors .gitignore. No project-local ignore surface for Forge to render.' })],
    ['hermes', target('unsupported', null, { knownIssue: 'Hermes has no AI index/read-ignore surface.' })],
  ]),
  row('sandbox', 'safety', 'execution sandbox and approval policy', [
    ['claude', target('unsupported', null, { role: 'no config-file execution sandbox', knownIssue: 'Claude Code has no config.toml-style execution sandbox; execution safety is delivered by the tool-permission allowlist (permissions row), not a sandbox surface.' })],
    ['cursor', target('unsupported', null, { knownIssue: 'Cursor has no project-local execution-sandbox config surface.' })],
    ['codex', target('not-delivered', null, { role: 'Codex sandbox_mode + approval_policy in config.toml', knownIssue: 'Codex sandbox_mode/approval_policy live in config.toml, honored project-locally ONLY when the project is trusted in the GLOBAL $CODEX_HOME/config.toml (projects.<path>.trust_level). Forge cannot grant that global trust during project-local setup, so a rendered project-local sandbox policy would not take effect; deferred to global-scope wiring. Tracked as kernel epic 90f2f631 (#311).', evidence: ['S13'] })],
    ['hermes', target('unsupported', null, { knownIssue: 'Hermes runs through the Forge CLI; it has no harness execution-sandbox surface.' })],
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
  verify: ['verify.merge_state', 'verify.default_branch_ci', 'verify.cleanup', 'verify.issue_close'],
};

function buildSkillsFirstStageGraph() {
  const renderTargetsForSkill = (id) => ({
    claude: {
      // Stage skills are skill-first: `.claude/commands/` was removed in A0d, so
      // there is NO command shim (that contradicted the commands capability row).
      skill: `.claude/skills/${id}/SKILL.md`,
    },
    cursor: {
      // Forge populates .cursor/skills/<stage>/SKILL.md at setup (populateAgentSkills).
      // No per-stage .cursor/rules/<stage>.mdc is generated — Forge only renders the
      // 4 policy rules — so no rule-policy fallback is advertised here.
      skill: `.cursor/skills/${id}/SKILL.md`,
      status: 'native',
    },
    codex: {
      // .codex/skills is the committed packaging staging mirror; skills install to
      // the GLOBAL $CODEX_HOME/skills. .agents/skills is the committed repo-local
      // discovery mirror (generated at setup) that Codex scans cwd → repo root.
      skill: `$CODEX_HOME/skills/${id}/SKILL.md`,
      stagingMirror: `.codex/skills/${id}/SKILL.md`,
      installTarget: '$CODEX_HOME/skills',
      directRepoDiscoveryTarget: `.agents/skills/${id}/SKILL.md`,
    },
    hermes: {
      // Forge populates .hermes/skills/<stage>/SKILL.md at setup (populateAgentSkills);
      // Hermes then consumes them through `forge orient` / `forge recap`.
      skill: `.hermes/skills/${id}/SKILL.md`,
      status: 'forge-owned',
      via: 'forge orient / forge recap',
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
  ['safety', 'Forge safety-surface manifest (permissions, ignore, sandbox)', ['permission scope (allow/deny/ask)', 'read/index ignore boundary', 'sandbox/approval policy or global-scope deferral note']],
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
  STATUS_VOCABULARY,
  UTILITY_SKILL_IDS,
  buildHarnessCapabilityEvidence,
  getHarnessCapabilityMatrix,
  getRendererContract,
  getSkillsFirstStageGraph,
};
