// Test: Invalid JSON and Schema Validation Edge Cases
// Validates validatePluginSchema() handling of malformed and invalid plugin configs

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { validatePluginSchema } = require('../../lib/plugin-manager');

describe('invalid-json-edge-cases', () => {
  describe('Malformed Plugin Objects', () => {
    test('should reject null plugin', () => {
      const result = validatePluginSchema(null);

      assert.strictEqual(result.valid, false, 'Null plugin should be invalid');
      assert.ok(result.errors.length > 0, 'Should have errors');
      assert.ok(
        result.errors.some(e => e.includes('non-null object')),
        'Should error about non-null object'
      );
    });

    test('should reject array as plugin', () => {
      const result = validatePluginSchema([]);

      assert.strictEqual(result.valid, false, 'Array should be invalid');
      assert.ok(
        result.errors.some(e => e.includes('non-null object')),
        'Should error about object type'
      );
    });

    test('should reject primitive types', () => {
      const result = validatePluginSchema('not an object');

      assert.strictEqual(result.valid, false, 'String should be invalid');
      assert.ok(result.errors.length > 0, 'Should have errors');
    });
  });

  describe('Missing Required Fields', () => {
    test('should detect missing "id"', () => {
      const plugin = {
        name: 'Test Plugin',
        version: '1.0.0',
        directories: { agents: 'lib/agents' }
      };

      const result = validatePluginSchema(plugin);

      assert.strictEqual(result.valid, false, 'Should fail without id');
      assert.ok(
        result.errors.some(e => e.includes('id')),
        'Should mention missing id'
      );
    });

    test('should detect missing "name"', () => {
      const plugin = {
        id: 'test-plugin',
        version: '1.0.0',
        directories: { agents: 'lib/agents' }
      };

      const result = validatePluginSchema(plugin);

      assert.strictEqual(result.valid, false, 'Should fail without name');
      assert.ok(
        result.errors.some(e => e.includes('name')),
        'Should mention missing name'
      );
    });

    test('should detect missing "version"', () => {
      const plugin = {
        id: 'test-plugin',
        name: 'Test Plugin',
        directories: { agents: 'lib/agents' }
      };

      const result = validatePluginSchema(plugin);

      assert.strictEqual(result.valid, false, 'Should fail without version');
      assert.ok(
        result.errors.some(e => e.includes('version')),
        'Should mention missing version'
      );
    });

    test('should detect missing "directories"', () => {
      const plugin = {
        id: 'test-plugin',
        name: 'Test Plugin',
        version: '1.0.0'
      };

      const result = validatePluginSchema(plugin);

      assert.strictEqual(result.valid, false, 'Should fail without directories');
      assert.ok(
        result.errors.some(e => e.includes('directories')),
        'Should mention missing directories'
      );
    });
  });

  describe('Invalid Field Types', () => {
    test('should detect non-string "id"', () => {
      const plugin = {
        id: 123,
        name: 'Test Plugin',
        version: '1.0.0',
        directories: { agents: 'lib/agents' }
      };

      const result = validatePluginSchema(plugin);

      assert.strictEqual(result.valid, false, 'Should fail with numeric id');
      assert.ok(
        result.errors.some(e => e.includes('id') && e.includes('string')),
        'Should mention id must be string'
      );
    });

    test('should detect non-string "name"', () => {
      const plugin = {
        id: 'test-plugin',
        name: { invalid: 'object' },
        version: '1.0.0',
        directories: { agents: 'lib/agents' }
      };

      const result = validatePluginSchema(plugin);

      assert.strictEqual(result.valid, false, 'Should fail with object name');
      assert.ok(
        result.errors.some(e => e.includes('name') && e.includes('string')),
        'Should mention name must be string'
      );
    });

    test('should detect non-string "version"', () => {
      const plugin = {
        id: 'test-plugin',
        name: 'Test Plugin',
        version: 1.0,
        directories: { agents: 'lib/agents' }
      };

      const result = validatePluginSchema(plugin);

      assert.strictEqual(result.valid, false, 'Should fail with numeric version');
      assert.ok(
        result.errors.some(e => e.includes('version') && e.includes('string')),
        'Should mention version must be string'
      );
    });

    test('should detect non-object "directories"', () => {
      const plugin = {
        id: 'test-plugin',
        name: 'Test Plugin',
        version: '1.0.0',
        directories: 'lib/agents'
      };

      const result = validatePluginSchema(plugin);

      assert.strictEqual(result.valid, false, 'Should fail with string directories');
      assert.ok(
        result.errors.some(e => e.includes('directories') && e.includes('object')),
        'Should mention directories must be object'
      );
    });

    test('should detect array "directories"', () => {
      const plugin = {
        id: 'test-plugin',
        name: 'Test Plugin',
        version: '1.0.0',
        directories: ['lib/agents']
      };

      const result = validatePluginSchema(plugin);

      assert.strictEqual(result.valid, false, 'Should fail with array directories');
      assert.ok(
        result.errors.some(e => e.includes('directories') && e.includes('object')),
        'Should mention directories must be object'
      );
    });
  });

  describe('Schema Validation Edge Cases', () => {
    test('should accept valid plugin with all required fields', () => {
      const plugin = {
        id: 'test-plugin',
        name: 'Test Plugin',
        version: '1.0.0',
        directories: { agents: 'lib/agents' }
      };

      const result = validatePluginSchema(plugin);

      assert.strictEqual(result.valid, true, 'Valid plugin should pass');
      assert.strictEqual(result.errors.length, 0, 'Should have no errors');
    });

    test('should accept valid plugin with optional fields', () => {
      const plugin = {
        id: 'test-plugin',
        name: 'Test Plugin',
        version: '1.0.0',
        directories: { agents: 'lib/agents' },
        description: 'A test plugin',
        homepage: 'https://example.com'
      };

      const result = validatePluginSchema(plugin);

      assert.strictEqual(result.valid, true, 'Valid plugin with optional fields should pass');
      assert.strictEqual(result.errors.length, 0, 'Should have no errors');
    });

    test('should detect empty "directories" object', () => {
      const plugin = {
        id: 'test-plugin',
        name: 'Test Plugin',
        version: '1.0.0',
        directories: {}
      };

      const result = validatePluginSchema(plugin);

      assert.strictEqual(result.valid, false, 'Should fail with empty directories');
      assert.ok(
        result.errors.some(e => e.includes('directories') && e.includes('empty')),
        'Should mention directories must not be empty'
      );
    });

    test('should detect invalid optional field types', () => {
      const plugin = {
        id: 'test-plugin',
        name: 'Test Plugin',
        version: '1.0.0',
        directories: { agents: 'lib/agents' },
        description: 123,
        homepage: { url: 'https://example.com' }
      };

      const result = validatePluginSchema(plugin);

      assert.strictEqual(result.valid, false, 'Should fail with invalid optional fields');
      assert.ok(result.errors.length >= 2, 'Should have at least 2 errors');
      assert.ok(
        result.errors.some(e => e.includes('description')),
        'Should mention description error'
      );
      assert.ok(
        result.errors.some(e => e.includes('homepage')),
        'Should mention homepage error'
      );
    });
  });
});
