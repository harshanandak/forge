const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  listCanonicalSkills,
  populateAgentSkills,
  diffSkillDir,
  checkSkillsSync,
  AGENT_SKILL_DIRS,
} = require('../../lib/skills-sync');

let tmp;

function write(rel, content) {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-sync-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('skills-sync: listCanonicalSkills', () => {
  test('returns dirs with SKILL.md, sorted, ignoring non-skill dirs', () => {
    write('skills/bar/SKILL.md', 'bar');
    write('skills/foo/SKILL.md', 'foo');
    write('skills/nope/README.md', 'no skill md here');
    fs.mkdirSync(path.join(tmp, 'skills/empty'), { recursive: true });

    const skills = listCanonicalSkills(tmp);
    expect(skills.map((s) => s.name)).toEqual(['bar', 'foo']);
  });

  test('honors the `only` filter', () => {
    write('skills/foo/SKILL.md', 'foo');
    write('skills/bar/SKILL.md', 'bar');
    const skills = listCanonicalSkills(tmp, { only: ['foo'] });
    expect(skills.map((s) => s.name)).toEqual(['foo']);
  });

  test('returns [] when skills/ is absent', () => {
    expect(listCanonicalSkills(tmp)).toEqual([]);
  });
});

describe('skills-sync: populateAgentSkills', () => {
  test('copies every canonical skill (recursively) into the target dir', () => {
    write('skills/plan/SKILL.md', 'plan body');
    write('skills/research/SKILL.md', 'research body');
    write('skills/research/evals/evals.json', '{"a":1}');

    const target = path.join(tmp, '.codex/skills');
    const { written } = populateAgentSkills({ sourceRoot: tmp, targetSkillsDir: target });

    expect(written.sort()).toEqual(['plan', 'research']);
    expect(fs.readFileSync(path.join(target, 'plan/SKILL.md'), 'utf8')).toBe('plan body');
    expect(fs.readFileSync(path.join(target, 'research/evals/evals.json'), 'utf8')).toBe('{"a":1}');
  });

  test('clean removes stale managed dirs but leaves canonical ones', () => {
    write('skills/plan/SKILL.md', 'plan');
    const target = path.join(tmp, '.codex/skills');
    fs.mkdirSync(path.join(target, 'gone'), { recursive: true });
    fs.writeFileSync(path.join(target, 'gone/SKILL.md'), 'stale', 'utf8');

    populateAgentSkills({ sourceRoot: tmp, targetSkillsDir: target, clean: true });

    expect(fs.existsSync(path.join(target, 'gone'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'plan/SKILL.md'))).toBe(true);
  });

  test('honors `only`', () => {
    write('skills/plan/SKILL.md', 'plan');
    write('skills/dev/SKILL.md', 'dev');
    const target = path.join(tmp, '.codex/skills');
    const { written } = populateAgentSkills({ sourceRoot: tmp, targetSkillsDir: target, only: ['plan'] });
    expect(written).toEqual(['plan']);
    expect(fs.existsSync(path.join(target, 'dev'))).toBe(false);
  });
});

describe('skills-sync: diffSkillDir', () => {
  test('CRLF vs LF is not reported as drift', () => {
    write('skills/plan/SKILL.md', 'line1\nline2\n');
    const target = path.join(tmp, '.codex/skills/plan');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'SKILL.md'), 'line1\r\nline2\r\n', 'utf8');

    const drift = diffSkillDir(path.join(tmp, 'skills/plan'), target);
    expect(drift).toEqual([]);
  });

  test('detects changed, missing, and extra files', () => {
    write('skills/plan/SKILL.md', 'canonical');
    write('skills/plan/ref.md', 'ref');
    const target = path.join(tmp, '.codex/skills/plan');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'SKILL.md'), 'STALE', 'utf8');
    fs.writeFileSync(path.join(target, 'unexpected.md'), 'x', 'utf8');

    const drift = diffSkillDir(path.join(tmp, 'skills/plan'), target);
    const byStatus = Object.fromEntries(drift.map((d) => [d.file, d.status]));
    expect(byStatus['SKILL.md']).toBe('changed');
    expect(byStatus['ref.md']).toBe('missing');
    expect(byStatus['unexpected.md']).toBe('extra');
  });
});

describe('skills-sync: checkSkillsSync', () => {
  test('a freshly populated mirror is in sync', () => {
    write('skills/plan/SKILL.md', 'plan');
    write('skills/dev/SKILL.md', 'dev');
    populateAgentSkills({ sourceRoot: tmp, targetSkillsDir: path.join(tmp, '.codex/skills') });

    const result = checkSkillsSync({ repoRoot: tmp });
    expect(result.inSync).toBe(true);
    expect(result.checkedAgents).toContain('.codex/skills');
    expect(result.drift).toEqual([]);
  });

  test('absent agent skill dirs are skipped (not drift)', () => {
    write('skills/plan/SKILL.md', 'plan');
    // No .codex/skills, .claude/skills, etc. created at all.
    const result = checkSkillsSync({ repoRoot: tmp });
    expect(result.inSync).toBe(true);
    expect(result.checkedAgents).toEqual([]);
  });

  test('flags a changed mirror file', () => {
    write('skills/plan/SKILL.md', 'plan');
    const target = path.join(tmp, '.codex/skills');
    populateAgentSkills({ sourceRoot: tmp, targetSkillsDir: target });
    fs.writeFileSync(path.join(target, 'plan/SKILL.md'), 'tampered', 'utf8');

    const result = checkSkillsSync({ repoRoot: tmp });
    expect(result.inSync).toBe(false);
    expect(result.drift.some((d) => d.skill === 'plan' && d.status === 'changed')).toBe(true);
  });

  test('flags a stale mirror dir with no canonical source', () => {
    write('skills/plan/SKILL.md', 'plan');
    const target = path.join(tmp, '.codex/skills');
    populateAgentSkills({ sourceRoot: tmp, targetSkillsDir: target });
    fs.mkdirSync(path.join(target, 'ghost'), { recursive: true });
    fs.writeFileSync(path.join(target, 'ghost/SKILL.md'), 'ghost', 'utf8');

    const result = checkSkillsSync({ repoRoot: tmp });
    expect(result.drift.some((d) => d.skill === 'ghost' && d.status === 'stale')).toBe(true);
  });

  test('flags a missing canonical skill in an existing mirror', () => {
    write('skills/plan/SKILL.md', 'plan');
    write('skills/dev/SKILL.md', 'dev');
    const target = path.join(tmp, '.codex/skills');
    populateAgentSkills({ sourceRoot: tmp, targetSkillsDir: target, only: ['plan'] });

    const result = checkSkillsSync({ repoRoot: tmp });
    expect(result.drift.some((d) => d.skill === 'dev' && d.status === 'missing')).toBe(true);
  });

  test('exposes the standard agent skill dirs', () => {
    expect(AGENT_SKILL_DIRS).toContain('.codex/skills');
    expect(AGENT_SKILL_DIRS).toContain('.claude/skills');
    expect(AGENT_SKILL_DIRS).toContain('.cursor/skills');
    expect(AGENT_SKILL_DIRS).toContain('.hermes/skills');
  });
});
