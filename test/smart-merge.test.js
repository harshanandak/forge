const { describe, it, expect } = require('bun:test');
const { smartMergeAgentsMd } = require('../lib/smart-merge');

describe('smartMergeAgentsMd', () => {
  const forgeSectionNew = [
    '<!-- FORGE:START - Do not edit below -->',
    '## Forge Workflow',
    'Some forge content here.',
    '<!-- FORGE:END -->',
  ].join('\n');

  const newContent = `# AGENTS.md\n\n<!-- USER:START -->\n<!-- USER:END -->\n\n${forgeSectionNew}\n`;

  describe('no markers at all', () => {
    it('preserves existing content inside USER markers and appends FORGE section', () => {
      const existing = '# My Project\n\nCustom instructions here.\n';
      const result = smartMergeAgentsMd(existing, newContent);

      // Existing content should be wrapped in USER markers
      expect(result).toContain('<!-- USER:START -->');
      expect(result).toContain('Custom instructions here.');
      expect(result).toContain('<!-- USER:END -->');
      // FORGE section from new content should be appended
      expect(result).toContain('<!-- FORGE:START');
      expect(result).toContain('Some forge content here.');
      expect(result).toContain('<!-- FORGE:END -->');
    });

    it('does not return empty string', () => {
      const existing = '# My Project\n\nCustom instructions here.\n';
      const result = smartMergeAgentsMd(existing, newContent);
      expect(result).not.toBe('');
    });
  });

  describe('USER markers only (no FORGE markers)', () => {
    it('keeps USER section and inserts FORGE section', () => {
      const existing = [
        '# AGENTS.md',
        '',
        '<!-- USER:START -->',
        '## My Custom Rules',
        'Do not use semicolons.',
        '<!-- USER:END -->',
        '',
      ].join('\n');

      const result = smartMergeAgentsMd(existing, newContent);

      // USER content preserved
      expect(result).toContain('Do not use semicolons.');
      expect(result).toContain('<!-- USER:START -->');
      expect(result).toContain('<!-- USER:END -->');
      // FORGE section inserted
      expect(result).toContain('<!-- FORGE:START');
      expect(result).toContain('Some forge content here.');
      expect(result).toContain('<!-- FORGE:END -->');
    });

    it('does not return empty string', () => {
      const existing = [
        '<!-- USER:START -->',
        'My rules',
        '<!-- USER:END -->',
      ].join('\n');
      const result = smartMergeAgentsMd(existing, newContent);
      expect(result).not.toBe('');
    });
  });

  describe('both markers present', () => {
    it('preserves USER section and updates FORGE section', () => {
      const existing = [
        '# AGENTS.md',
        '',
        '<!-- USER:START -->',
        '## My Rules',
        'Keep it simple.',
        '<!-- USER:END -->',
        '',
        '<!-- FORGE:START - Do not edit below -->',
        '## Old Forge Content',
        'This is outdated.',
        '<!-- FORGE:END -->',
      ].join('\n');

      const result = smartMergeAgentsMd(existing, newContent);

      // USER content preserved
      expect(result).toContain('Keep it simple.');
      // Old FORGE content replaced with new
      expect(result).not.toContain('This is outdated.');
      expect(result).toContain('Some forge content here.');
    });
  });

  describe('Forge markers without USER markers', () => {
    it('updates Forge-only content without creating a USER block or duplicating it', () => {
      const existing = [
        '# AGENTS.md',
        '',
        '<!-- FORGE:START - Do not edit below -->',
        '## Old Forge Content',
        'This is outdated.',
        '<!-- FORGE:END -->',
      ].join('\n');

      const result = smartMergeAgentsMd(existing, newContent);

      expect(result).not.toContain('This is outdated.');
      expect(result).toContain('Some forge content here.');
      expect(result.match(/<!-- FORGE:START/g)).toHaveLength(1);
      expect(result.match(/<!-- FORGE:END -->/g)).toHaveLength(1);
      expect(result).not.toMatch(/<!-- USER:START -->[\s\S]*<!-- USER:END -->/);
    });

    it('preserves unmarked content surrounding the Forge block as USER content', () => {
      const existing = [
        'Project-specific instructions',
        '',
        '<!-- FORGE:START - Do not edit below -->',
        '## Old Forge Content',
        'This is outdated.',
        '<!-- FORGE:END -->',
        '',
        'Additional project instructions',
      ].join('\n');

      const result = smartMergeAgentsMd(existing, newContent);

      expect(result).toContain('<!-- USER:START -->');
      expect(result).toContain('Project-specific instructions');
      expect(result).toContain('Additional project instructions');
      expect(result).toContain('<!-- USER:END -->');
      expect(result).not.toContain('This is outdated.');
      expect(result.match(/<!-- FORGE:START/g)).toHaveLength(1);
      expect(result.match(/<!-- FORGE:END -->/g)).toHaveLength(1);
    });

    it('keeps generated wrapper content idempotent across repeated smart merges', () => {
      const first = smartMergeAgentsMd('', newContent);
      const second = smartMergeAgentsMd(first, newContent);
      const third = smartMergeAgentsMd(second, newContent);

      expect(third.match(/<!-- FORGE:START/g)).toHaveLength(1);
      expect(third.match(/<!-- FORGE:END -->/g)).toHaveLength(1);
      expect(third.match(/## Improving This Workflow/g)).toHaveLength(1);
      expect(third).not.toMatch(/<!-- USER:START -->[\s\S]*<!-- USER:END -->/);
    });

    it('removes the generated footer before preserving trailing user text', () => {
      const generated = smartMergeAgentsMd('', newContent);
      const existing = `${generated}\nProject instructions after the generated footer`;

      const result = smartMergeAgentsMd(existing, newContent);

      expect(result).toContain('<!-- USER:START -->');
      expect(result).toContain('Project instructions after the generated footer');
      expect(result).toContain('<!-- USER:END -->');
      expect(result.match(/## Improving This Workflow/g)).toHaveLength(1);
    });

    it('recognizes generated wrapper content with CRLF line endings', () => {
      const existing = smartMergeAgentsMd('', newContent).replace(/\n/g, '\r\n');

      const result = smartMergeAgentsMd(existing, newContent);

      expect(result.match(/## Improving This Workflow/g)).toHaveLength(1);
      expect(result).not.toMatch(/<!-- USER:START -->[\s\S]*<!-- USER:END -->/);
    });
  });

  describe('empty existing content', () => {
    it('returns only FORGE section (no empty USER block)', () => {
      const existing = '';
      const result = smartMergeAgentsMd(existing, newContent);

      // Should have FORGE section
      expect(result).toContain('<!-- FORGE:START');
      expect(result).toContain('Some forge content here.');
      expect(result).toContain('<!-- FORGE:END -->');
      // Should NOT have empty USER markers
      expect(result).not.toMatch(/<!-- USER:START -->\s*<!-- USER:END -->/);
    });

    it('does not return empty string', () => {
      const existing = '';
      const result = smartMergeAgentsMd(existing, newContent);
      expect(result).not.toBe('');
    });
  });
});
