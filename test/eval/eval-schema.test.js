const { describe, test, expect, beforeAll, afterAll } = require('bun:test');
const path = require('path');
const fs = require('fs');
const { loadEvalSet, validateEvalSet } = require('../../scripts/lib/eval-schema');

// Helper to build a valid eval set for mutation testing
function validEvalSet() {
  return {
    command: '/status',
    description: 'Status command eval set',
    queries: [
      {
        name: 'basic-status',
        prompt: 'Show current status',
        setup: null,
        teardown: null,
        assertions: [
          { type: 'standard', check: 'output contains stage info' },
        ],
      },
    ],
  };
}

describe('eval-schema', () => {
  describe('validateEvalSet', () => {
    test('valid eval set loads without error', () => {
      const data = validEvalSet();
      const result = validateEvalSet(data);
      expect(result).toBeDefined();
      expect(result.command).toBe('/status');
      expect(result.description).toBe('Status command eval set');
      expect(result.queries).toHaveLength(1);
      expect(result.queries[0].name).toBe('basic-status');
    });

    test('missing command field throws with clear message', () => {
      const data = validEvalSet();
      delete data.command;
      expect(() => validateEvalSet(data)).toThrow('missing required field: command');
    });

    test('empty command field throws with clear message', () => {
      const data = validEvalSet();
      data.command = '';
      expect(() => validateEvalSet(data)).toThrow('missing required field: command');
    });

    test('missing description field throws with clear message', () => {
      const data = validEvalSet();
      delete data.description;
      expect(() => validateEvalSet(data)).toThrow('missing required field: description');
    });

    test('empty description field throws with clear message', () => {
      const data = validEvalSet();
      data.description = '';
      expect(() => validateEvalSet(data)).toThrow('missing required field: description');
    });

    test('missing queries field throws with clear message', () => {
      const data = validEvalSet();
      delete data.queries;
      expect(() => validateEvalSet(data)).toThrow('missing required field: queries');
    });

    test('empty queries array throws', () => {
      const data = validEvalSet();
      data.queries = [];
      expect(() => validateEvalSet(data)).toThrow('queries must be a non-empty array');
    });

    test('query with no assertions array throws', () => {
      const data = validEvalSet();
      delete data.queries[0].assertions;
      expect(() => validateEvalSet(data)).toThrow(
        'query "basic-status": missing required field: assertions'
      );
    });

    test('query with empty assertions array throws', () => {
      const data = validEvalSet();
      data.queries[0].assertions = [];
      expect(() => validateEvalSet(data)).toThrow(
        'query "basic-status": assertions must be a non-empty array'
      );
    });

    test('query missing name throws', () => {
      const data = validEvalSet();
      delete data.queries[0].name;
      expect(() => validateEvalSet(data)).toThrow(
        'query at index 0: missing required field: name'
      );
    });

    test('query missing prompt throws', () => {
      const data = validEvalSet();
      delete data.queries[0].prompt;
      expect(() => validateEvalSet(data)).toThrow(
        'query "basic-status": missing required field: prompt'
      );
    });

    test('assertion with unknown type throws with clear message', () => {
      const data = validEvalSet();
      data.queries[0].assertions[0] = { type: 'banana', check: 'something' };
      expect(() => validateEvalSet(data)).toThrow(
        'query "basic-status", assertion 0: unknown assertion type: "banana"'
      );
    });

    test('standard assertion missing check throws', () => {
      const data = validEvalSet();
      data.queries[0].assertions[0] = { type: 'standard' };
      expect(() => validateEvalSet(data)).toThrow(
        'query "basic-status", assertion 0 (standard): missing required field: check'
      );
    });

    test('hard-gate assertion missing precondition throws', () => {
      const data = validEvalSet();
      data.queries[0].assertions[0] = { type: 'hard-gate', check: 'something' };
      expect(() => validateEvalSet(data)).toThrow(
        'query "basic-status", assertion 0 (hard-gate): missing required field: precondition'
      );
    });

    test('hard-gate assertion missing check throws', () => {
      const data = validEvalSet();
      data.queries[0].assertions[0] = { type: 'hard-gate', precondition: 'something' };
      expect(() => validateEvalSet(data)).toThrow(
        'query "basic-status", assertion 0 (hard-gate): missing required field: check'
      );
    });

    test('contract assertion missing producer throws', () => {
      const data = validEvalSet();
      data.queries[0].assertions[0] = {
        type: 'contract',
        consumer: 'consumer',
        check: 'something',
      };
      expect(() => validateEvalSet(data)).toThrow(
        'query "basic-status", assertion 0 (contract): missing required field: producer'
      );
    });

    test('contract assertion missing consumer throws', () => {
      const data = validEvalSet();
      data.queries[0].assertions[0] = {
        type: 'contract',
        producer: 'producer',
        check: 'something',
      };
      expect(() => validateEvalSet(data)).toThrow(
        'query "basic-status", assertion 0 (contract): missing required field: consumer'
      );
    });

    test('contract assertion missing check throws', () => {
      const data = validEvalSet();
      data.queries[0].assertions[0] = {
        type: 'contract',
        producer: 'producer',
        consumer: 'consumer',
      };
      expect(() => validateEvalSet(data)).toThrow(
        'query "basic-status", assertion 0 (contract): missing required field: check'
      );
    });

    test('duplicate query name within eval set throws', () => {
      const data = validEvalSet();
      data.queries.push({
        name: 'basic-status',
        prompt: 'Another prompt',
        setup: null,
        teardown: null,
        assertions: [{ type: 'standard', check: 'something' }],
      });
      expect(() => validateEvalSet(data)).toThrow(
        'duplicate query name: "basic-status"'
      );
    });

    test('valid eval set with all three assertion types passes', () => {
      const data = {
        command: '/dev',
        description: 'Dev command eval set',
        queries: [
          {
            name: 'standard-query',
            prompt: 'Run standard check',
            setup: 'echo setup',
            teardown: 'echo teardown',
            assertions: [
              { type: 'standard', check: 'output is correct' },
            ],
          },
          {
            name: 'hard-gate-query',
            prompt: 'Run hard-gate check',
            setup: null,
            teardown: null,
            assertions: [
              {
                type: 'hard-gate',
                precondition: 'branch exists',
                check: 'tests pass',
              },
            ],
          },
          {
            name: 'contract-query',
            prompt: 'Run contract check',
            setup: null,
            teardown: null,
            assertions: [
              {
                type: 'contract',
                producer: '/plan',
                consumer: '/dev',
                check: 'task list is consumed',
              },
            ],
          },
        ],
      };
      const result = validateEvalSet(data);
      expect(result.queries).toHaveLength(3);
      expect(result.queries[0].assertions[0].type).toBe('standard');
      expect(result.queries[1].assertions[0].type).toBe('hard-gate');
      expect(result.queries[2].assertions[0].type).toBe('contract');
    });

    test('setup and teardown fields are optional (default to null)', () => {
      const data = {
        command: '/status',
        description: 'Minimal eval set',
        queries: [
          {
            name: 'no-setup-teardown',
            prompt: 'Test without setup/teardown',
            assertions: [{ type: 'standard', check: 'works' }],
          },
        ],
      };
      const result = validateEvalSet(data);
      expect(result.queries[0].setup).toBeNull();
      expect(result.queries[0].teardown).toBeNull();
    });
  });

  describe('loadEvalSet', () => {
    const tmpDir = path.join(__dirname, '__fixtures__');

    beforeAll(() => {
      fs.mkdirSync(tmpDir, { recursive: true });
    });

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('loads valid .eval.json file from disk', () => {
      const filePath = path.join(tmpDir, 'valid.eval.json');
      fs.writeFileSync(
        filePath,
        JSON.stringify(validEvalSet(), null, 2),
        'utf-8'
      );
      const result = loadEvalSet(filePath);
      expect(result.command).toBe('/status');
      expect(result.queries).toHaveLength(1);
    });

    test('throws on non-existent file', () => {
      expect(() => loadEvalSet('/no/such/file.eval.json')).toThrow(
        'eval set file not found'
      );
    });

    test('throws on invalid JSON', () => {
      const filePath = path.join(tmpDir, 'bad.eval.json');
      fs.writeFileSync(filePath, '{not valid json!!!', 'utf-8');
      expect(() => loadEvalSet(filePath)).toThrow('invalid JSON');
    });

    test('throws validation error for invalid content', () => {
      const filePath = path.join(tmpDir, 'invalid.eval.json');
      fs.writeFileSync(filePath, JSON.stringify({ queries: [] }), 'utf-8');
      expect(() => loadEvalSet(filePath)).toThrow('missing required field: command');
    });
  });
});
