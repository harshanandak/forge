/**
 * Tests for commands/ canonical source directory.
 *
 * Verifies that the canonical source exists, contains expected commands,
 * and each file has valid frontmatter with at least a description field.
 */

const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');
const { parse } = require('../lib/frontmatter');

const repoRoot = path.resolve(__dirname, '..');
const canonicalDir = path.join(repoRoot, 'commands');
const claudeDir = path.join(repoRoot, '.claude', 'commands');

describe('canonical commands/ directory', () => {
  test('commands/ directory exists', () => {
    expect(fs.existsSync(canonicalDir)).toBe(true);
  });

  test('contains at least the core workflow commands', () => {
    const files = fs.readdirSync(canonicalDir).filter(f => f.endsWith('.md'));
    const names = files.map(f => f.replace(/\.md$/, ''));
    const required = ['plan', 'dev', 'validate', 'ship', 'review', 'status'];
    for (const cmd of required) {
      expect(names).toContain(cmd);
    }
  });

  test('each file has valid frontmatter with description', () => {
    const files = fs.readdirSync(canonicalDir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const raw = fs.readFileSync(path.join(canonicalDir, file), 'utf8');
      const { data } = parse(raw);
      expect(data.description).toBeDefined();
      expect(typeof data.description).toBe('string');
      expect(data.description.length).toBeGreaterThan(0);
    }
  });

  test('commands/ has same command set as .claude/commands/', () => {
    const canonicalFiles = fs.readdirSync(canonicalDir).filter(f => f.endsWith('.md')).sort();
    const claudeFiles = fs.readdirSync(claudeDir).filter(f => f.endsWith('.md')).sort();
    expect(canonicalFiles).toEqual(claudeFiles);
  });

  test('canonical files only retain description (and optionally arguments) in frontmatter', () => {
    const files = fs.readdirSync(canonicalDir).filter(f => f.endsWith('.md'));
    const allowedKeys = new Set(['description', 'arguments']);
    for (const file of files) {
      const raw = fs.readFileSync(path.join(canonicalDir, file), 'utf8');
      const { data } = parse(raw);
      for (const key of Object.keys(data)) {
        expect(allowedKeys.has(key)).toBe(true);
      }
    }
  });
});
