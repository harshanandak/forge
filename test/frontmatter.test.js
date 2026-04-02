/**
 * Tests for lib/frontmatter.js — gray-matter utility.
 */

const { describe, test, expect } = require('bun:test');
const { parse, stringify, stripAll, keepOnly } = require('../lib/frontmatter');

describe('frontmatter', () => {
  describe('parse', () => {
    test('parses YAML frontmatter from markdown', () => {
      const raw = '---\ndescription: Test command\n---\n\nBody content here.\n';
      const result = parse(raw);
      expect(result.data.description).toBe('Test command');
      expect(result.content).toContain('Body content here.');
    });

    test('returns empty data when no frontmatter present', () => {
      const raw = '# No frontmatter\n\nJust body.\n';
      const result = parse(raw);
      expect(Object.keys(result.data)).toHaveLength(0);
      expect(result.content).toContain('No frontmatter');
    });

    test('handles multiple frontmatter fields', () => {
      const raw = '---\ndescription: Multi\nmode: code\ntools:\n  - git\n---\nBody\n';
      const result = parse(raw);
      expect(result.data.description).toBe('Multi');
      expect(result.data.mode).toBe('code');
      expect(result.data.tools).toEqual(['git']);
    });
  });

  describe('stringify', () => {
    test('builds frontmatter string from data and content', () => {
      const result = stringify({ description: 'Hello' }, '\nBody text.\n');
      expect(result).toContain('---');
      expect(result).toContain('description: Hello');
      expect(result).toContain('Body text.');
    });
  });

  describe('stripAll', () => {
    test('removes all frontmatter, returns body only', () => {
      const raw = '---\ndescription: Test\nmode: code\n---\n\nBody only.\n';
      const result = stripAll(raw);
      expect(result).toContain('Body only.');
      expect(result).not.toContain('description:');
      expect(result).not.toContain('mode:');
    });

    test('returns content unchanged when no frontmatter', () => {
      const raw = '# Hello\n\nWorld.\n';
      const result = stripAll(raw);
      expect(result).toContain('# Hello');
    });
  });

  describe('keepOnly', () => {
    test('keeps only specified fields', () => {
      const raw = '---\ndescription: Keep me\nmode: code\ntools:\n  - git\n---\n\nBody.\n';
      const result = keepOnly(raw, ['description']);
      expect(result).toContain('description: Keep me');
      expect(result).not.toContain('mode:');
      expect(result).not.toContain('tools:');
      expect(result).toContain('Body.');
    });

    test('returns body only when no specified fields exist', () => {
      const raw = '---\nmode: code\n---\n\nBody.\n';
      const result = keepOnly(raw, ['description']);
      expect(result).toContain('Body.');
      expect(result).not.toContain('---');
    });

    test('handles arguments field', () => {
      const raw = '---\ndescription: Test\narguments:\n  - name: query\n---\n\nBody.\n';
      const result = keepOnly(raw, ['description', 'arguments']);
      expect(result).toContain('description: Test');
      expect(result).toContain('arguments:');
    });
  });
});
