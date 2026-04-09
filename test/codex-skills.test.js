const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { afterEach, describe, expect, test } = require('bun:test');
const {
  buildCodexSkillInstallPlan,
  formatCodexSkillsInstallDir,
  listCodexSkillEntries,
  resolveCodexHome,
  resolveCodexSkillsInstallDir,
} = require('../lib/codex-skills');

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-codex-skills-dedicated-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('codex-skills helpers', () => {
  test('returns no packaged skill entries when .codex/skills is missing', () => {
    const tmpDir = makeTempDir();

    expect(listCodexSkillEntries(tmpDir)).toEqual([]);
    expect(buildCodexSkillInstallPlan(tmpDir)).toEqual([]);
  });

  test('resolveCodexHome normalizes a relative CODEX_HOME override', () => {
    const relativeCodexHome = path.join('tmp', 'codex-home');

    expect(resolveCodexHome({ env: { CODEX_HOME: relativeCodexHome } })).toBe(path.resolve(relativeCodexHome));
  });

  test('resolveCodexSkillsInstallDir handles CODEX_HOME values with trailing separators', () => {
    const tmpDir = makeTempDir();
    const codexHome = `${path.join(tmpDir, '.codex-home')}${path.sep}`;

    expect(resolveCodexSkillsInstallDir({ env: { CODEX_HOME: codexHome }, homeDir: tmpDir }))
      .toBe(path.join(tmpDir, '.codex-home', 'skills'));
    expect(formatCodexSkillsInstallDir({ env: { CODEX_HOME: codexHome }, homeDir: tmpDir }))
      .toBe('$CODEX_HOME/skills');
  });

  test('formatCodexSkillsInstallDir uses the default home shorthand when CODEX_HOME is unset', () => {
    const tmpDir = makeTempDir();

    expect(formatCodexSkillsInstallDir({ env: {}, homeDir: tmpDir })).toBe('~/.codex/skills');
  });
});
