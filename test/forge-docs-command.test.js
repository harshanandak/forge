const { describe, test, expect } = require('bun:test');
const path = require('path');
const fs = require('fs');

const { listTopics, getTopicContent, TOPICS } = require('../lib/docs-command');

// Use the actual package docs dir as source
const packageDir = path.resolve(__dirname, '..');

describe('forge docs command', () => {
  describe('listTopics', () => {
    test('returns an array of available topic names', () => {
      const topics = listTopics();
      expect(Array.isArray(topics)).toBe(true);
      expect(topics.length).toBeGreaterThan(0);
    });

    test('includes expected topics', () => {
      const topics = listTopics();
      expect(topics).toContain('toolchain');
      expect(topics).toContain('validation');
      expect(topics).toContain('setup');
      expect(topics).toContain('examples');
      expect(topics).toContain('roadmap');
    });
  });

  describe('getTopicContent', () => {
    test('returns file content for valid topic', () => {
      const result = getTopicContent('toolchain', packageDir);
      expect(result.error).toBeUndefined();
      expect(typeof result.content).toBe('string');
      expect(result.content.length).toBeGreaterThan(0);
    });

    test('returns setup content from guides directory', () => {
      const result = getTopicContent('setup', packageDir);
      expect(result.error).toBeUndefined();
      expect(result.content).toContain('bootstrapper');
    });

    test('returns error for invalid topic', () => {
      const result = getTopicContent('nonexistent', packageDir);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Unknown topic');
      expect(result.content).toBeUndefined();
    });

    test('rejects path traversal attempt', () => {
      const result = getTopicContent('../../etc/passwd', packageDir);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Unknown topic');
      expect(result.content).toBeUndefined();
    });

    test('rejects path traversal with backslashes', () => {
      const result = getTopicContent('..\\..\\etc\\passwd', packageDir);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Unknown topic');
      expect(result.content).toBeUndefined();
    });

    test('rejects topic with slashes', () => {
      const result = getTopicContent('../secrets', packageDir);
      expect(result.error).toBeDefined();
      expect(result.content).toBeUndefined();
    });

    test('returns error with list of available topics', () => {
      const result = getTopicContent('bogus', packageDir);
      expect(result.error).toContain('Available topics');
    });

    test('handles missing file gracefully', () => {
      // Use a temp dir with no docs as package dir
      const os = require('os');
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-cmd-test-'));
      fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });

      const result = getTopicContent('toolchain', tmpDir);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('not found');

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('TOPICS allowlist', () => {
    test('maps topic names to filenames', () => {
      expect(typeof TOPICS).toBe('object');
      expect(TOPICS.toolchain).toBe('TOOLCHAIN.md');
      expect(TOPICS.validation).toBe('VALIDATION.md');
    });
  });
});
