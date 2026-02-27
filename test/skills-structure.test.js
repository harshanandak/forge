const { describe, test, expect } = require('bun:test');
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
      expect(fs.existsSync(path.join(ROOT, 'skills'))).toBeTruthy();
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
        expect(fs.existsSync(path.join(ROOT, 'skills', skill))).toBeTruthy();
      });

      test(`skills/${skill}/SKILL.md exists`, () => {
        expect(fs.existsSync(path.join(ROOT, 'skills', skill, 'SKILL.md'))).toBeTruthy();
      });
    }
  });

  describe('SKILL.md frontmatter validation', () => {
    for (const skill of requiredSkills) {
      test(`skills/${skill}/SKILL.md has valid frontmatter (name + description)`, () => {
        const skillPath = path.join(ROOT, 'skills', skill, 'SKILL.md');
        if (!fs.existsSync(skillPath)) return; // skip if file missing (caught above)
        const fm = parseFrontmatter(skillPath);
        expect(fm).toBeTruthy();
        expect(fm.name).toBeTruthy();
        expect(fm.description).toBeTruthy();
      });

      test(`skills/${skill}/SKILL.md name matches directory name`, () => {
        const skillPath = path.join(ROOT, 'skills', skill, 'SKILL.md');
        if (!fs.existsSync(skillPath)) return;
        const fm = parseFrontmatter(skillPath);
        if (!fm) return;
        expect(fm.name).toBe(skill);
      });
    }
  });

  describe('skill content validation', () => {
    test('parallel-web-search SKILL.md references Search API or search endpoint', () => {
      const filePath = path.join(ROOT, 'skills', 'parallel-web-search', 'SKILL.md');
      if (!fs.existsSync(filePath)) return;
      const content = fs.readFileSync(filePath, 'utf8');
      expect(content.includes('/search') || content.includes('Search')).toBeTruthy();
    });

    test('parallel-web-extract SKILL.md references Extract API or extract endpoint', () => {
      const filePath = path.join(ROOT, 'skills', 'parallel-web-extract', 'SKILL.md');
      if (!fs.existsSync(filePath)) return;
      const content = fs.readFileSync(filePath, 'utf8');
      expect(content.includes('/extract') || content.includes('Extract')).toBeTruthy();
    });

    test('parallel-deep-research SKILL.md references pro or ultra processor', () => {
      const filePath = path.join(ROOT, 'skills', 'parallel-deep-research', 'SKILL.md');
      if (!fs.existsSync(filePath)) return;
      const content = fs.readFileSync(filePath, 'utf8');
      expect(content.includes('pro') || content.includes('ultra')).toBeTruthy();
    });

    test('parallel-data-enrichment SKILL.md references core or base processor', () => {
      const filePath = path.join(ROOT, 'skills', 'parallel-data-enrichment', 'SKILL.md');
      if (!fs.existsSync(filePath)) return;
      const content = fs.readFileSync(filePath, 'utf8');
      expect(content.includes('core') || content.includes('base')).toBeTruthy();
    });

    test('sonarcloud-analysis SKILL.md references SonarCloud API', () => {
      const filePath = path.join(ROOT, 'skills', 'sonarcloud-analysis', 'SKILL.md');
      if (!fs.existsSync(filePath)) return;
      const content = fs.readFileSync(filePath, 'utf8');
      expect(content.includes('sonarcloud.io') || content.includes('SonarCloud')).toBeTruthy();
    });

    test('citation-standards SKILL.md contains citation format examples (URL or Sources)', () => {
      const filePath = path.join(ROOT, 'skills', 'citation-standards', 'SKILL.md');
      if (!fs.existsSync(filePath)) return;
      const content = fs.readFileSync(filePath, 'utf8');
      expect(content.includes('URL') || content.includes('Sources') || content.includes('url')).toBeTruthy();
    });
  });

  describe('reference files', () => {
    test('skills/sonarcloud-analysis/references/api-reference.md exists', () => {
      expect(fs.existsSync(
          path.join(ROOT, 'skills', 'sonarcloud-analysis', 'references', 'api-reference.md')
        )).toBeTruthy();
    });
  });

  describe('legacy .claude/skills/ removal', () => {
    test('.claude/skills/parallel-ai/ directory no longer exists', () => {
      expect(!fs.existsSync(path.join(ROOT, '.claude', 'skills', 'parallel-ai'))).toBeTruthy();
    });

    test('.claude/skills/sonarcloud/ directory no longer exists', () => {
      expect(!fs.existsSync(path.join(ROOT, '.claude', 'skills', 'sonarcloud'))).toBeTruthy();
    });
  });
});
