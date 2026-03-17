const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { saveEvalResult, loadEvalHistory } = require('../../scripts/lib/eval-storage');

describe('eval-storage', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-storage-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('saveEvalResult', () => {
    test('creates file with YYYY-MM-DD-HH-MM-<command>.json naming', () => {
      const result = {
        command: '/status',
        timestamp: '2026-03-16T14:30:00Z',
        overall_score: 0.85,
        results: [],
        duration_ms: 45000,
      };

      const filePath = saveEvalResult(result, tmpDir);
      const fileName = path.basename(filePath);

      // Should match pattern: 2026-03-16-14-30-status.json
      expect(fileName).toBe('2026-03-16-14-30-status.json');
      expect(fs.existsSync(filePath)).toBe(true);
    });

    test('result file contains full eval data', () => {
      const result = {
        command: '/status',
        timestamp: '2026-03-16T14:30:00Z',
        overall_score: 0.85,
        results: [
          {
            query: 'happy_path',
            score: 1.0,
            assertions: [{ type: 'standard', check: 'shows beads', pass: true, reasoning: 'ok' }],
          },
        ],
        duration_ms: 45000,
      };

      const filePath = saveEvalResult(result, tmpDir);
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      expect(saved.command).toBe('/status');
      expect(saved.timestamp).toBe('2026-03-16T14:30:00Z');
      expect(saved.overall_score).toBe(0.85);
      expect(saved.results).toHaveLength(1);
      expect(saved.results[0].query).toBe('happy_path');
      expect(saved.results[0].assertions[0].pass).toBe(true);
      expect(saved.duration_ms).toBe(45000);
    });

    test('strips leading slash and replaces slashes with dashes in command name', () => {
      const result = {
        command: '/plan',
        timestamp: '2026-01-05T09:15:00Z',
        overall_score: 0.5,
        results: [],
      };

      const filePath = saveEvalResult(result, tmpDir);
      const fileName = path.basename(filePath);

      expect(fileName).toBe('2026-01-05-09-15-plan.json');
    });

    test('creates directory automatically if missing', () => {
      const nestedDir = path.join(tmpDir, 'nested', 'eval-logs');
      const result = {
        command: '/dev',
        timestamp: '2026-06-01T12:00:00Z',
        overall_score: 0.9,
        results: [],
      };

      expect(fs.existsSync(nestedDir)).toBe(false);

      const filePath = saveEvalResult(result, nestedDir);

      expect(fs.existsSync(nestedDir)).toBe(true);
      expect(fs.existsSync(filePath)).toBe(true);
    });

    test('returns the file path that was written', () => {
      const result = {
        command: 'validate',
        timestamp: '2026-02-20T08:45:00Z',
        overall_score: 0.7,
        results: [],
      };

      const filePath = saveEvalResult(result, tmpDir);

      expect(typeof filePath).toBe('string');
      expect(filePath.startsWith(tmpDir)).toBe(true);
      expect(filePath.endsWith('.json')).toBe(true);
    });
  });

  describe('loadEvalHistory', () => {
    test('returns array of prior results sorted by timestamp newest first', () => {
      const older = {
        command: '/status',
        timestamp: '2026-03-14T10:00:00Z',
        overall_score: 0.6,
        results: [],
      };
      const newer = {
        command: '/status',
        timestamp: '2026-03-16T14:30:00Z',
        overall_score: 0.85,
        results: [],
      };

      saveEvalResult(older, tmpDir);
      saveEvalResult(newer, tmpDir);

      const history = loadEvalHistory('/status', tmpDir);

      expect(history).toHaveLength(2);
      expect(history[0].timestamp).toBe('2026-03-16T14:30:00Z');
      expect(history[1].timestamp).toBe('2026-03-14T10:00:00Z');
    });

    test('returns empty array when no prior results exist', () => {
      const history = loadEvalHistory('/status', tmpDir);

      expect(history).toEqual([]);
    });

    test('returns empty array when directory does not exist', () => {
      const nonExistent = path.join(tmpDir, 'does-not-exist');

      const history = loadEvalHistory('/status', nonExistent);

      expect(history).toEqual([]);
    });

    test('filters to only files matching the given command', () => {
      const statusResult = {
        command: '/status',
        timestamp: '2026-03-16T14:30:00Z',
        overall_score: 0.85,
        results: [],
      };
      const planResult = {
        command: '/plan',
        timestamp: '2026-03-16T15:00:00Z',
        overall_score: 0.7,
        results: [],
      };

      saveEvalResult(statusResult, tmpDir);
      saveEvalResult(planResult, tmpDir);

      const statusHistory = loadEvalHistory('/status', tmpDir);
      const planHistory = loadEvalHistory('plan', tmpDir);

      expect(statusHistory).toHaveLength(1);
      expect(statusHistory[0].command).toBe('/status');
      expect(planHistory).toHaveLength(1);
      expect(planHistory[0].command).toBe('/plan');
    });

    test('handles command name with or without leading slash', () => {
      const result = {
        command: '/dev',
        timestamp: '2026-03-16T12:00:00Z',
        overall_score: 0.9,
        results: [],
      };

      saveEvalResult(result, tmpDir);

      const withSlash = loadEvalHistory('/dev', tmpDir);
      const withoutSlash = loadEvalHistory('dev', tmpDir);

      expect(withSlash).toHaveLength(1);
      expect(withoutSlash).toHaveLength(1);
    });
  });
});
