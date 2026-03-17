const { describe, test, expect } = require('bun:test');
const path = require('path');
const { loadEvalSet } = require('../../scripts/lib/eval-schema');

const EVAL_DIR = path.resolve(__dirname, '../../eval/commands');

describe('eval-sets', () => {
  describe('status.eval.json', () => {
    const filePath = path.join(EVAL_DIR, 'status.eval.json');

    test('loads without schema validation errors', () => {
      const evalSet = loadEvalSet(filePath);
      expect(evalSet).toBeDefined();
      expect(evalSet.command).toBe('/status');
    });

    test('has at least 3 queries', () => {
      const evalSet = loadEvalSet(filePath);
      expect(evalSet.queries.length).toBeGreaterThanOrEqual(3);
    });

    test('all query names are unique', () => {
      const evalSet = loadEvalSet(filePath);
      const names = evalSet.queries.map((q) => q.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });
  });

  describe('validate.eval.json', () => {
    const filePath = path.join(EVAL_DIR, 'validate.eval.json');

    test('loads without schema validation errors', () => {
      const evalSet = loadEvalSet(filePath);
      expect(evalSet).toBeDefined();
      expect(evalSet.command).toBe('/validate');
    });

    test('has at least 4 queries', () => {
      const evalSet = loadEvalSet(filePath);
      expect(evalSet.queries.length).toBeGreaterThanOrEqual(4);
    });

    test('has at least one hard-gate assertion', () => {
      const evalSet = loadEvalSet(filePath);
      const hasHardGate = evalSet.queries.some((q) =>
        q.assertions.some((a) => a.type === 'hard-gate')
      );
      expect(hasHardGate).toBe(true);
    });

    test('has at least one contract assertion', () => {
      const evalSet = loadEvalSet(filePath);
      const hasContract = evalSet.queries.some((q) =>
        q.assertions.some((a) => a.type === 'contract')
      );
      expect(hasContract).toBe(true);
    });

    test('all query names are unique', () => {
      const evalSet = loadEvalSet(filePath);
      const names = evalSet.queries.map((q) => q.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });
  });
});
