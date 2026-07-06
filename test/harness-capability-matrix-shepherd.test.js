'use strict';

const { describe, test, expect } = require('bun:test');

const {
  STAGE_IDS,
  UTILITY_SKILL_IDS,
  getSkillsFirstStageGraph,
} = require('../lib/harness-capability-matrix');

describe('shepherd in the harness capability matrix', () => {
  test('shepherd is registered as a UTILITY skill, not a stage', () => {
    expect(UTILITY_SKILL_IDS).toContain('shepherd');
    expect(STAGE_IDS).not.toContain('shepherd');
  });

  test('shepherd appears in the utilitySkills graph with subskills and render targets', () => {
    const graph = getSkillsFirstStageGraph();

    const ids = graph.utilitySkills.map((s) => s.id);
    expect(ids).toContain('shepherd');
    // utilitySkills set is exactly UTILITY_SKILL_IDS (auto-derived)
    expect(ids).toEqual(UTILITY_SKILL_IDS);

    const shepherd = graph.utilitySkills.find((s) => s.id === 'shepherd');
    expect(shepherd.workflowStage).toBe(false);
    expect(shepherd.superSkill).toBe('shepherd');
    expect(shepherd.subskills.length).toBeGreaterThan(0);
    expect(shepherd.renderTargets.claude.skill).toBe('.claude/skills/shepherd/SKILL.md');
    expect(shepherd.renderTargets.cursor.skill).toBe('.cursor/skills/shepherd/SKILL.md');
    // Codex render target is the install path $CODEX_HOME/skills; .codex/skills is the
    // committed staging mirror (see harness-capability-matrix codex skill knownIssue).
    expect(shepherd.renderTargets.codex.skill).toBe('$CODEX_HOME/skills/shepherd/SKILL.md');
  });

  test('shepherd is NOT a workflow stage in the stage graph', () => {
    const graph = getSkillsFirstStageGraph();
    expect(graph.stages.map((s) => s.id)).not.toContain('shepherd');
  });
});
