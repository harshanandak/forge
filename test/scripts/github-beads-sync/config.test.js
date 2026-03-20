import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Module under test
import { loadConfig, DEFAULT_CONFIG } from '../../../scripts/github-beads-sync/config.mjs';

const TMP_DIR = join(import.meta.dirname, '__tmp_config_test__');

describe('github-beads-sync config', () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  // --- DEFAULT_CONFIG ---

  describe('DEFAULT_CONFIG', () => {
    test('has correct labelToType mapping', () => {
      expect(DEFAULT_CONFIG.labelToType).toEqual({
        bug: 'bug',
        enhancement: 'feature',
        documentation: 'task',
        question: 'task',
      });
    });

    test('has correct labelToPriority mapping', () => {
      expect(DEFAULT_CONFIG.labelToPriority).toEqual({
        P0: 0, critical: 0,
        P1: 1, high: 1,
        P2: 2, medium: 2,
        P3: 3, low: 3,
        P4: 4, backlog: 4,
      });
    });

    test('has correct scalar defaults', () => {
      expect(DEFAULT_CONFIG.defaultType).toBe('task');
      expect(DEFAULT_CONFIG.defaultPriority).toBe(2);
      expect(DEFAULT_CONFIG.mapAssignee).toBe(true);
      expect(DEFAULT_CONFIG.publicRepoGate).toBe('none');
      expect(DEFAULT_CONFIG.gateLabelName).toBe('beads-track');
      expect(DEFAULT_CONFIG.gateAssociations).toEqual([
        'MEMBER', 'COLLABORATOR', 'OWNER',
      ]);
    });

    test('is frozen (immutable)', () => {
      expect(() => { DEFAULT_CONFIG.defaultType = 'bug'; }).toThrow();
    });
  });

  // --- loadConfig() ---

  describe('loadConfig()', () => {
    test('returns defaults when called with no arguments', () => {
      const cfg = loadConfig();
      expect(cfg).toEqual(DEFAULT_CONFIG);
    });

    test('returns defaults when file does not exist', () => {
      const cfg = loadConfig(join(TMP_DIR, 'nonexistent.json'));
      expect(cfg).toEqual(DEFAULT_CONFIG);
    });

    test('deep-merges user overrides with defaults', () => {
      const overridePath = join(TMP_DIR, 'override.json');
      writeFileSync(overridePath, JSON.stringify({
        defaultType: 'bug',
        labelToType: { 'custom-label': 'feature' },
      }));

      const cfg = loadConfig(overridePath);

      // User override wins
      expect(cfg.defaultType).toBe('bug');
      // Nested merge: user key added, defaults preserved
      expect(cfg.labelToType['custom-label']).toBe('feature');
      expect(cfg.labelToType.bug).toBe('bug');
      // Other defaults untouched
      expect(cfg.defaultPriority).toBe(2);
      expect(cfg.mapAssignee).toBe(true);
    });

    test('user overrides replace default nested values', () => {
      const overridePath = join(TMP_DIR, 'override2.json');
      writeFileSync(overridePath, JSON.stringify({
        labelToPriority: { P0: 0, critical: 0, urgent: 0 },
      }));

      const cfg = loadConfig(overridePath);

      // Deep merge: user keys + default keys both present
      expect(cfg.labelToPriority.urgent).toBe(0);
      expect(cfg.labelToPriority.P1).toBe(1); // default preserved
    });

    test('throws with helpful message on invalid JSON', () => {
      const badPath = join(TMP_DIR, 'bad.json');
      writeFileSync(badPath, '{ not valid json }');

      expect(() => loadConfig(badPath)).toThrow(/invalid.*json/i);
      expect(() => loadConfig(badPath)).toThrow(new RegExp(badPath.replace(/\\/g, '\\\\')));
    });

    test('returns a new object each call (no shared references)', () => {
      const a = loadConfig();
      const b = loadConfig();
      expect(a).toEqual(b);
      expect(a).not.toBe(b);
      expect(a.labelToType).not.toBe(b.labelToType);
    });
  });
});
