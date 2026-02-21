const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Returns { name, description, ...rest } or null if no frontmatter found.
 */
function parseFrontmatter(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  if (!content.startsWith('---')) return null;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return null;
  const yaml = content.slice(4, end);
  const result = {};
  for (const line of yaml.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (key && val) result[key] = val;
  }
  return result;
}

describe('skills/ directory structure', () => {
  describe('root skills/ directory', () => {
    test('skills/ directory exists at repo root', () => {
      assert.ok(
        fs.existsSync(path.join(ROOT, 'skills')),
        'skills/ directory should exist at repo root'
      );
    });
  });

  const requiredSkills = [
    'parallel-web-search',
    'parallel-web-extract',
    'parallel-deep-research',
    'parallel-data-enrichment',
    'sonarcloud-analysis',
    'citation-standards',
  ];

  describe('required skill directories', () => {
    for (const skill of requiredSkills) {
      test(`skills/${skill}/ directory exists`, () => {
        assert.ok(
          fs.existsSync(path.join(ROOT, 'skills', skill)),
          `skills/${skill}/ directory should exist`
        );
      });

      test(`skills/${skill}/SKILL.md exists`, () => {
        assert.ok(
          fs.existsSync(path.join(ROOT, 'skills', skill, 'SKILL.md')),
          `skills/${skill}/SKILL.md should exist`
        );
      });
    }
  });

  describe('SKILL.md frontmatter validation', () => {
    for (const skill of requiredSkills) {
      test(`skills/${skill}/SKILL.md has valid frontmatter (name + description)`, () => {
        const skillPath = path.join(ROOT, 'skills', skill, 'SKILL.md');
        if (!fs.existsSync(skillPath)) return; // skip if file missing (caught above)
        const fm = parseFrontmatter(skillPath);
        assert.ok(fm, `${skill}/SKILL.md should have YAML frontmatter`);
        assert.ok(fm.name, `${skill}/SKILL.md frontmatter should have 'name' field`);
        assert.ok(fm.description, `${skill}/SKILL.md frontmatter should have 'description' field`);
      });

      test(`skills/${skill}/SKILL.md name matches directory name`, () => {
        const skillPath = path.join(ROOT, 'skills', skill, 'SKILL.md');
        if (!fs.existsSync(skillPath)) return;
        const fm = parseFrontmatter(skillPath);
        if (!fm) return;
        assert.strictEqual(fm.name, skill, `${skill}/SKILL.md 'name' should equal '${skill}'`);
      });
    }
  });

  describe('skill content validation', () => {
    test('parallel-web-search SKILL.md references Search API or search endpoint', () => {
      const filePath = path.join(ROOT, 'skills', 'parallel-web-search', 'SKILL.md');
      if (!fs.existsSync(filePath)) return;
      const content = fs.readFileSync(filePath, 'utf8');
      assert.ok(
        content.includes('/search') || content.includes('Search'),
        'parallel-web-search should reference the Search API'
      );
    });

    test('parallel-web-extract SKILL.md references Extract API or extract endpoint', () => {
      const filePath = path.join(ROOT, 'skills', 'parallel-web-extract', 'SKILL.md');
      if (!fs.existsSync(filePath)) return;
      const content = fs.readFileSync(filePath, 'utf8');
      assert.ok(
        content.includes('/extract') || content.includes('Extract'),
        'parallel-web-extract should reference the Extract API'
      );
    });

    test('parallel-deep-research SKILL.md references pro or ultra processor', () => {
      const filePath = path.join(ROOT, 'skills', 'parallel-deep-research', 'SKILL.md');
      if (!fs.existsSync(filePath)) return;
      const content = fs.readFileSync(filePath, 'utf8');
      assert.ok(
        content.includes('pro') || content.includes('ultra'),
        'parallel-deep-research should reference pro or ultra processor'
      );
    });

    test('parallel-data-enrichment SKILL.md references core or base processor', () => {
      const filePath = path.join(ROOT, 'skills', 'parallel-data-enrichment', 'SKILL.md');
      if (!fs.existsSync(filePath)) return;
      const content = fs.readFileSync(filePath, 'utf8');
      assert.ok(
        content.includes('core') || content.includes('base'),
        'parallel-data-enrichment should reference core or base processor'
      );
    });

    test('sonarcloud-analysis SKILL.md references SonarCloud API', () => {
      const filePath = path.join(ROOT, 'skills', 'sonarcloud-analysis', 'SKILL.md');
      if (!fs.existsSync(filePath)) return;
      const content = fs.readFileSync(filePath, 'utf8');
      assert.ok(
        content.includes('sonarcloud.io') || content.includes('SonarCloud'),
        'sonarcloud-analysis should reference SonarCloud'
      );
    });

    test('citation-standards SKILL.md contains citation format examples (URL or Sources)', () => {
      const filePath = path.join(ROOT, 'skills', 'citation-standards', 'SKILL.md');
      if (!fs.existsSync(filePath)) return;
      const content = fs.readFileSync(filePath, 'utf8');
      assert.ok(
        content.includes('URL') || content.includes('Sources') || content.includes('url'),
        'citation-standards should contain citation format guidance'
      );
    });
  });

  describe('reference files', () => {
    test('skills/sonarcloud-analysis/references/api-reference.md exists', () => {
      assert.ok(
        fs.existsSync(
          path.join(ROOT, 'skills', 'sonarcloud-analysis', 'references', 'api-reference.md')
        ),
        'sonarcloud-analysis should have references/api-reference.md'
      );
    });
  });

  describe('legacy .claude/skills/ removal', () => {
    test('.claude/skills/parallel-ai/ directory no longer exists', () => {
      assert.ok(
        !fs.existsSync(path.join(ROOT, '.claude', 'skills', 'parallel-ai')),
        '.claude/skills/parallel-ai/ should be removed after migration'
      );
    });

    test('.claude/skills/sonarcloud/ directory no longer exists', () => {
      assert.ok(
        !fs.existsSync(path.join(ROOT, '.claude', 'skills', 'sonarcloud')),
        '.claude/skills/sonarcloud/ should be removed after migration'
      );
    });
  });
});
