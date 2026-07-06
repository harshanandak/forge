const { describe, expect, test } = require('bun:test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const {
  CAPABILITY_IDS,
  HARNESS_IDS,
  STAGE_IDS,
  UTILITY_SKILL_IDS,
  buildHarnessCapabilityEvidence,
  getHarnessCapabilityMatrix,
  getRendererContract,
  getSkillsFirstStageGraph,
} = require('../lib/harness-capability-matrix');

const ROOT = path.resolve(__dirname, '..');

describe('harness capability matrix', () => {
  test('covers every v3.0 harness and parity capability', () => {
    const matrix = getHarnessCapabilityMatrix();

    expect(Object.keys(matrix.harnesses)).toEqual(HARNESS_IDS);
    for (const harnessId of HARNESS_IDS) {
      expect(Object.keys(matrix.harnesses[harnessId].capabilities)).toEqual(CAPABILITY_IDS);
    }
  });

  test('models Cursor skills and rules as different surfaces', () => {
    const cursor = getHarnessCapabilityMatrix().harnesses.cursor.capabilities;

    expect(cursor.skills.status).toBe('unproven');
    expect(cursor.skills.primarySurface).toBe('.cursor/skills/<skill>/SKILL.md');
    expect(cursor.skills.role).toBe('on-demand workflow');
    expect(cursor.skills.evidence).toEqual([]);
    expect(cursor.skills.knownIssue).toContain('matching source evidence');
    expect(cursor.rules.primarySurface).toBe('.cursor/rules/<rule>.mdc');
    expect(cursor.rules.role).toBe('always-on or scoped policy');
    expect(cursor.rules.activation).toContain('description');
  });

  test('records known unsupported or unproven harness surfaces explicitly', () => {
    const matrix = getHarnessCapabilityMatrix();

    expect(matrix.harnesses.cursor.capabilities.hooks.status).toBe('unsupported');
    expect(matrix.harnesses.cursor.capabilities.hooks.knownIssue).toContain('No verified Cursor hook surface');
    expect(matrix.harnesses.cursor.capabilities.agents.status).toBe('unproven');
    expect(matrix.harnesses.claude.capabilities.commands.status).toBe('removed');
    expect(matrix.harnesses.claude.capabilities.commands.role).toContain('legacy .claude/commands/ surface removed');
    expect(matrix.harnesses.cursor.capabilities.commands.status).toBe('removed');
    expect(matrix.harnesses.cursor.capabilities.mcp.primarySurface).toBe('.cursor/mcp.json');
    expect(matrix.harnesses.cursor.capabilities.extensionPacks.primarySurface).toContain('.cursor/mcp.json');
  });

  test('evidence object is machine-readable and source-backed', () => {
    const evidence = buildHarnessCapabilityEvidence();

    expect(evidence.kind).toBe('forge.harnessCapabilityEvidence');
    expect(evidence.schemaVersion).toBe('1.0.0');
    expect(evidence.harnesses.map(harness => harness.id)).toEqual(HARNESS_IDS);
    expect(evidence.sources.every(source => source.label && source.url)).toBe(true);
    expect(JSON.parse(JSON.stringify(evidence))).toEqual(evidence);
  });
});

describe('skills-first stage graph', () => {
  test('represents every default stage as a super skill with subskills', () => {
    const graph = getSkillsFirstStageGraph();

    expect(graph.stages.map(stage => stage.id)).toEqual(STAGE_IDS);
    expect(graph.stages.map(stage => stage.id)).not.toContain('status');
    for (const stage of graph.stages) {
      expect(stage.canonicalSurface).toBe('skill');
      expect(stage.workflowStage).toBe(true);
      expect(stage.superSkill).toBe(`${stage.id}`);
      expect(stage.subskills.length).toBeGreaterThan(0);
      expect(stage.renderTargets.claude.skill).toBe(`.claude/skills/${stage.id}/SKILL.md`);
      expect(stage.renderTargets.cursor.skill).toBe(`.cursor/skills/${stage.id}/SKILL.md`);
      expect(stage.renderTargets.cursor.status).toBe('unproven');
      expect(stage.renderTargets.cursor.knownIssue).toContain('matching source evidence');
      expect(stage.renderTargets.codex.skill).toBe(`.codex/skills/${stage.id}/SKILL.md`);
      expect(stage.renderTargets.codex.directRepoDiscoveryTarget).toBe(`.agents/skills/${stage.id}/SKILL.md`);
    }
  });

  test('models status as a utility skill outside workflow stages', () => {
    const graph = getSkillsFirstStageGraph();

    expect(graph.utilitySkills.map(skill => skill.id)).toEqual(UTILITY_SKILL_IDS);
    expect(graph.utilitySkills).toContainEqual(expect.objectContaining({
      id: 'status',
      canonicalSurface: 'skill',
      workflowStage: false,
      superSkill: 'status',
    }));
  });

  test('renders Claude stages skill-first with NO command shim (commands removed in A0d)', () => {
    const graph = getSkillsFirstStageGraph();

    for (const stage of graph.stages) {
      // The legacy `.claude/commands/` surface was removed; the stage SKILL is
      // the authority. Emitting a command shim contradicted the commands
      // capability row (which records Claude commands as `removed`).
      expect(stage.renderTargets.claude.skill).toBe(`.claude/skills/${stage.id}/SKILL.md`);
      expect(stage.renderTargets.claude.commandShim).toBeUndefined();
    }
  });

  test('models Hermes stages as CLI-consumed (no per-stage skill file)', () => {
    const graph = getSkillsFirstStageGraph();

    for (const stage of graph.stages) {
      expect(stage.renderTargets.hermes).toEqual({
        cliConsumed: true,
        via: 'forge orient / forge recap',
      });
    }
  });

  test('exposes plan phases as addressable subskills', () => {
    const plan = getSkillsFirstStageGraph().stages.find(stage => stage.id === 'plan');

    expect(plan.subskills.map(subskill => subskill.id)).toEqual([
      'plan.intent_capture',
      'plan.parallel_research',
      'plan.parallel_critics',
      'plan.synthesis',
      'plan.final_lock',
    ]);
  });
});

describe('renderer contract', () => {
  test('requires renderer evidence before broad harness generation', () => {
    const contract = getRendererContract();

    expect(contract.scope).toBe('contract-only');
    expect(contract.beforeAddingRenderer).toEqual([
      'capability-matrix-entry',
      'target-path-contract',
      'activation-metadata-contract',
      'machine-readable-evidence',
      'known-issue-if-unproven',
    ]);
  });

  test('binds each renderer family to canonical Forge input and evidence', () => {
    const contract = getRendererContract();
    const rendererIds = contract.rendererFamilies.map(renderer => renderer.id);

    expect(rendererIds).toEqual([
      'instructions',
      'skills',
      'rules',
      'mcp',
      'hooks',
      'commands',
      'agents',
      'stage-graph',
      'state-and-memory',
      'distribution',
    ]);
    expect(contract.rendererFamilies.every(renderer => renderer.canonicalInput && renderer.requiredEvidence.length > 0)).toBe(true);
  });
});

describe('harness capability evidence CLI', () => {
  test('prints the matrix as JSON for machine-readable evidence', () => {
    const output = execFileSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'spikes', 'harness-capability-matrix.js')],
      { cwd: ROOT, encoding: 'utf8' },
    );
    const parsed = JSON.parse(output);

    expect(parsed.kind).toBe('forge.harnessCapabilityEvidence');
    expect(parsed.stageGraph.kind).toBe('forge.skillsFirstStageGraph');
    expect(parsed.rendererContract.kind).toBe('forge.harnessRendererContract');
  });
});
