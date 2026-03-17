const { describe, test, expect } = require('bun:test');
const { readFileSync, existsSync } = require('fs');
const { join } = require('path');

const AGENT_PATH = join(__dirname, '..', '..', '.claude', 'agents', 'command-grader.md');

describe('command-grader agent', () => {
  test('agent file exists at .claude/agents/command-grader.md', () => {
    expect(existsSync(AGENT_PATH)).toBe(true);
  });

  describe('frontmatter', () => {
    test('has valid frontmatter with name and description fields', () => {
      const content = readFileSync(AGENT_PATH, 'utf-8');

      // Must start with ---
      expect(content.startsWith('---')).toBe(true);

      // Must have closing ---
      const closingIndex = content.indexOf('---', 3);
      expect(closingIndex).toBeGreaterThan(3);

      const frontmatter = content.slice(3, closingIndex).trim();

      // Extract name field
      const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
      expect(nameMatch).not.toBeNull();
      expect(nameMatch[1].trim()).toBe('command-grader');

      // Extract description field
      const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
      expect(descMatch).not.toBeNull();
      expect(descMatch[1].trim().length).toBeGreaterThan(0);
    });
  });

  describe('system prompt content', () => {
    let systemPrompt;

    // Extract the body (everything after the second ---)
    function getSystemPrompt() {
      if (systemPrompt) return systemPrompt;
      const content = readFileSync(AGENT_PATH, 'utf-8');
      const closingIndex = content.indexOf('---', 3);
      systemPrompt = content.slice(closingIndex + 3).trim();
      return systemPrompt;
    }

    test('mentions all three assertion types (standard, hard-gate, contract)', () => {
      const prompt = getSystemPrompt();

      // Must mention "standard" assertion type
      expect(prompt).toMatch(/\bstandard\b/i);

      // Must mention "hard-gate" assertion type
      expect(prompt).toMatch(/\bhard-gate\b/i);

      // Must mention "contract" assertion type
      expect(prompt).toMatch(/\bcontract\b/i);

      // Each type should have a description/definition section
      // Standard: check if transcript content matches
      expect(prompt).toMatch(/standard.*transcript|transcript.*standard/is);

      // Hard-gate: agent should stop when precondition not met
      expect(prompt).toMatch(/hard-gate.*stop|stop.*hard-gate/is);

      // Contract: output contains artifact for downstream
      expect(prompt).toMatch(/contract.*artifact|artifact.*contract|contract.*downstream|downstream.*contract/is);
    });

    test('includes JSON output format specification', () => {
      const prompt = getSystemPrompt();

      // Must contain "results" array in JSON format
      expect(prompt).toMatch(/"results"/);

      // Must specify pass boolean
      expect(prompt).toMatch(/"pass"/);

      // Must specify reasoning string
      expect(prompt).toMatch(/"reasoning"/);

      // Must specify assertion object
      expect(prompt).toMatch(/"assertion"/);

      // Must specify type field
      expect(prompt).toMatch(/"type"/);

      // Must specify check field
      expect(prompt).toMatch(/"check"/);
    });
  });
});
