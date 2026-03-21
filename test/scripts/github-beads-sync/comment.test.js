import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test';
import {
  buildComment,
  parseComment,
  SYNC_TAG_PREFIX,
} from '../../../scripts/github-beads-sync/comment.mjs';

describe('comment module', () => {
  // ── SYNC_TAG_PREFIX ──────────────────────────────────────────────
  describe('SYNC_TAG_PREFIX', () => {
    test('equals the expected HTML comment prefix', () => {
      expect(SYNC_TAG_PREFIX).toBe('<!-- beads-sync:');
    });
  });

  // ── buildComment ─────────────────────────────────────────────────
  describe('buildComment', () => {
    let dateSpy;

    beforeEach(() => {
      dateSpy = jest
        .spyOn(globalThis, 'Date')
        .mockImplementation(() => ({
          toISOString: () => '2026-03-21T10:00:00.000Z',
        }));
    });

    afterEach(() => {
      dateSpy.mockRestore();
    });

    test('produces expected markdown with full metadata', () => {
      const result = buildComment('forge-abc', 42, {
        type: 'feature',
        priority: 'P2',
        externalRef: 'gh-42',
      });

      expect(result).toContain('<!-- beads-sync:42 -->');
      expect(result).toContain('**Beads:** `forge-abc`');
      expect(result).toContain('- Type: feature');
      expect(result).toContain('- Priority: P2');
      expect(result).toContain('- External ref: gh-42');
      expect(result).toContain('- Synced: 2026-03-21T10:00:00.000Z');
      expect(result).toContain('<details>');
      expect(result).toContain('<summary>Sync details</summary>');
      expect(result).toContain('</details>');
    });

    test('omits missing metadata fields', () => {
      const result = buildComment('forge-xyz', 7, {});

      expect(result).toContain('<!-- beads-sync:7 -->');
      expect(result).toContain('**Beads:** `forge-xyz`');
      expect(result).not.toContain('- Type:');
      expect(result).not.toContain('- Priority:');
      expect(result).not.toContain('- External ref:');
      // Synced timestamp always present
      expect(result).toContain('- Synced: 2026-03-21T10:00:00.000Z');
    });

    test('works with undefined metadata', () => {
      const result = buildComment('forge-001', 1);

      expect(result).toContain('<!-- beads-sync:1 -->');
      expect(result).toContain('**Beads:** `forge-001`');
      expect(result).toContain('- Synced:');
    });
  });

  // ── parseComment ─────────────────────────────────────────────────
  describe('parseComment', () => {
    test('extracts beadsId and issueNumber from valid comment', () => {
      const body = [
        '<!-- beads-sync:42 -->',
        '**Beads:** `forge-abc`',
        '<details>',
        '<summary>Sync details</summary>',
        '',
        '- Type: feature',
        '- Synced: 2026-03-21T10:00:00.000Z',
        '</details>',
      ].join('\n');

      const result = parseComment(body);
      expect(result).toEqual({ beadsId: 'forge-abc', issueNumber: 42 });
    });

    test('returns null for non-sync comments', () => {
      expect(parseComment('Just a regular comment')).toBeNull();
      expect(parseComment('<!-- some-other-tag -->')).toBeNull();
      expect(parseComment('')).toBeNull();
    });

    test('returns null for null/undefined input', () => {
      expect(parseComment(null)).toBeNull();
      expect(parseComment(undefined)).toBeNull();
    });

    test('handles extra whitespace around tag', () => {
      const body = '  <!-- beads-sync:99 -->  \n  **Beads:** `forge-ws1`  ';
      const result = parseComment(body);
      expect(result).toEqual({ beadsId: 'forge-ws1', issueNumber: 99 });
    });

    test('handles CRLF line endings', () => {
      const body =
        '<!-- beads-sync:5 -->\r\n**Beads:** `forge-crlf`\r\n<details>\r\n</details>';
      const result = parseComment(body);
      expect(result).toEqual({ beadsId: 'forge-crlf', issueNumber: 5 });
    });

    test('returns null when sync tag present but beads ID missing', () => {
      const body = '<!-- beads-sync:10 -->\nNo beads line here';
      expect(parseComment(body)).toBeNull();
    });

    test('returns null when beads ID present but sync tag missing', () => {
      const body = '**Beads:** `forge-orphan`';
      expect(parseComment(body)).toBeNull();
    });

    test('parses non-forge prefixed beads IDs (e.g., myapp-xxx)', () => {
      const body = '<!-- beads-sync:7 -->\n**Beads:** `myapp-abc123`';
      const result = parseComment(body);
      expect(result).toEqual({ beadsId: 'myapp-abc123', issueNumber: 7 });
    });

    test('parses beads- prefixed IDs', () => {
      const body = '<!-- beads-sync:15 -->\n**Beads:** `beads-def456`';
      const result = parseComment(body);
      expect(result).toEqual({ beadsId: 'beads-def456', issueNumber: 15 });
    });
  });
});
