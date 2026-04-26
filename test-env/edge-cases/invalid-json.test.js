// Test: Invalid JSON and Schema Validation Edge Cases
// Validates validatePluginSchema() handling of malformed and invalid plugin configs

import { describe, test, expect } from 'bun:test';
const { validatePluginSchema } = require('../../lib/plugin-manager');

describe('invalid-json-edge-cases', () => {
  describe('Malformed Plugin Objects', () => {
    test('should reject null plugin', () => {
      const result = validatePluginSchema(null);

      expect(result.valid).toBe(false);
      expect(result.errors.length > 0).toBeTruthy();
      expect(result.errors.some(e => e.includes('non-null object'))).toBeTruthy();
    });

    test('should reject array as plugin', () => {
      const result = validatePluginSchema([]);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('non-null object'))).toBeTruthy();
    });

    test('should reject primitive types', () => {
      const result = validatePluginSchema('not an object');

      expect(result.valid).toBe(false);
      expect(result.errors.length > 0).toBeTruthy();
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

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('id'))).toBeTruthy();
    });

    test('should detect missing "name"', () => {
      const plugin = {
        id: 'test-plugin',
        version: '1.0.0',
        directories: { agents: 'lib/agents' }
      };

      const result = validatePluginSchema(plugin);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('name'))).toBeTruthy();
    });

    test('should detect missing "version"', () => {
      const plugin = {
        id: 'test-plugin',
        name: 'Test Plugin',
        directories: { agents: 'lib/agents' }
      };

      const result = validatePluginSchema(plugin);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('version'))).toBeTruthy();
    });

    test('should detect missing "directories"', () => {
      const plugin = {
        id: 'test-plugin',
        name: 'Test Plugin',
        version: '1.0.0'
      };

      const result = validatePluginSchema(plugin);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('directories'))).toBeTruthy();
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

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('id') && e.includes('string'))).toBeTruthy();
    });

    test('should detect non-string "name"', () => {
      const plugin = {
        id: 'test-plugin',
        name: { invalid: 'object' },
        version: '1.0.0',
        directories: { agents: 'lib/agents' }
      };

      const result = validatePluginSchema(plugin);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('name') && e.includes('string'))).toBeTruthy();
    });

    test('should detect non-string "version"', () => {
      const plugin = {
        id: 'test-plugin',
        name: 'Test Plugin',
        version: 1.0,
        directories: { agents: 'lib/agents' }
      };

      const result = validatePluginSchema(plugin);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('version') && e.includes('string'))).toBeTruthy();
    });

    test('should detect non-object "directories"', () => {
      const plugin = {
        id: 'test-plugin',
        name: 'Test Plugin',
        version: '1.0.0',
        directories: 'lib/agents'
      };

      const result = validatePluginSchema(plugin);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('directories') && e.includes('object'))).toBeTruthy();
    });

    test('should detect array "directories"', () => {
      const plugin = {
        id: 'test-plugin',
        name: 'Test Plugin',
        version: '1.0.0',
        directories: ['lib/agents']
      };

      const result = validatePluginSchema(plugin);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('directories') && e.includes('object'))).toBeTruthy();
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

      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
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

      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    test('should detect empty "directories" object', () => {
      const plugin = {
        id: 'test-plugin',
        name: 'Test Plugin',
        version: '1.0.0',
        directories: {}
      };

      const result = validatePluginSchema(plugin);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('directories') && e.includes('empty'))).toBeTruthy();
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

      expect(result.valid).toBe(false);
      expect(result.errors.length >= 2).toBeTruthy();
      expect(result.errors.some(e => e.includes('description'))).toBeTruthy();
      expect(result.errors.some(e => e.includes('homepage'))).toBeTruthy();
    });
  });
});
