/**
 * Plugin Manager Tests
 *
 * Tests for the PluginManager class that handles loading and validating
 * agent plugin JSON files.
 *
 * TDD Phase: RED
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const PluginManager = require('../../lib/plugin-manager');

describe('PluginManager', () => {
  let pluginManager;

  before(() => {
    // Clean up any leftover test files first
    const pluginDir = path.join(__dirname, '../../lib/agents');
    const testFiles = ['invalid-test.plugin.json', 'duplicate-test.plugin.json'];
    testFiles.forEach(file => {
      const filePath = path.join(pluginDir, file);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    });

    pluginManager = new PluginManager();
  });

  describe('Plugin Loading', () => {
    it('should load all plugin files from lib/agents/', () => {
      const plugins = pluginManager.getAllPlugins();
      assert.ok(plugins.size > 0, 'Should load at least one plugin');
    });

    it('should load exactly 11 agent plugins', () => {
      const plugins = pluginManager.getAllPlugins();
      assert.equal(plugins.size, 11, 'Should load all 11 agent plugins');
    });

    it('should return plugin by ID', () => {
      const claude = pluginManager.getPlugin('claude');
      assert.ok(claude, 'Should return claude plugin');
      assert.equal(claude.id, 'claude');
      assert.equal(claude.name, 'Claude Code');
    });

    it('should return undefined for non-existent plugin', () => {
      const nonExistent = pluginManager.getPlugin('non-existent-agent');
      assert.equal(nonExistent, undefined);
    });

    it('should return all plugins via getAllPlugins()', () => {
      const plugins = pluginManager.getAllPlugins();
      assert.ok(plugins instanceof Map, 'Should return a Map');
      assert.equal(plugins.size, 11);
    });

    it('should return array of agent IDs via listAgents()', () => {
      const agentIds = pluginManager.listAgents();
      assert.ok(Array.isArray(agentIds), 'Should return an array');
      assert.equal(agentIds.length, 11);
      assert.ok(agentIds.includes('claude'));
      assert.ok(agentIds.includes('cursor'));
      assert.ok(agentIds.includes('windsurf'));
    });
  });

  describe('Plugin Validation', () => {
    it('should validate plugin schema with all required fields', () => {
      const validPlugin = {
        id: 'test-agent',
        name: 'Test Agent',
        version: '1.0.0',
        description: 'Test agent for validation',
        directories: {
          commands: '.test/commands'
        }
      };

      assert.doesNotThrow(() => {
        pluginManager.validatePlugin(validPlugin);
      });
    });

    it('should throw error for missing required field: id', () => {
      const invalidPlugin = {
        name: 'Test Agent',
        version: '1.0.0',
        directories: {}
      };

      assert.throws(() => {
        pluginManager.validatePlugin(invalidPlugin);
      }, /Plugin validation failed.*id/i);
    });

    it('should throw error for missing required field: name', () => {
      const invalidPlugin = {
        id: 'test-agent',
        version: '1.0.0',
        directories: {}
      };

      assert.throws(() => {
        pluginManager.validatePlugin(invalidPlugin);
      }, /Plugin validation failed.*name/i);
    });

    it('should throw error for missing required field: version', () => {
      const invalidPlugin = {
        id: 'test-agent',
        name: 'Test Agent',
        directories: {}
      };

      assert.throws(() => {
        pluginManager.validatePlugin(invalidPlugin);
      }, /Plugin validation failed.*version/i);
    });

    it('should throw error for missing required field: directories', () => {
      const invalidPlugin = {
        id: 'test-agent',
        name: 'Test Agent',
        version: '1.0.0'
      };

      assert.throws(() => {
        pluginManager.validatePlugin(invalidPlugin);
      }, /Plugin validation failed.*directories/i);
    });

    it('should throw error for invalid directories type', () => {
      const invalidPlugin = {
        id: 'test-agent',
        name: 'Test Agent',
        version: '1.0.0',
        directories: 'not-an-object'
      };

      assert.throws(() => {
        pluginManager.validatePlugin(invalidPlugin);
      }, /Plugin validation failed.*directories/i);
    });

    it('should reject plugin with invalid JSON structure', () => {
      const pluginDir = path.join(__dirname, '../../lib/agents');
      const testFile = path.join(pluginDir, 'invalid-test.plugin.json');

      // Cleanup any leftover file first
      if (fs.existsSync(testFile)) {
        fs.unlinkSync(testFile);
      }

      // Create invalid JSON file
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(testFile, '{ invalid json }');

      assert.throws(() => {
        new PluginManager();
      }, /Expected property name|Unexpected token/i);

      // Cleanup
      fs.unlinkSync(testFile);
    });

    it('should throw error for duplicate plugin IDs', () => {
      const pluginDir = path.join(__dirname, '../../lib/agents');
      const testFile = path.join(pluginDir, 'duplicate-test.plugin.json');

      // Cleanup any leftover file first
      if (fs.existsSync(testFile)) {
        fs.unlinkSync(testFile);
      }

      // Create a plugin file with an ID that already exists (claude)
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(testFile, JSON.stringify({
        id: 'claude', // Duplicate ID
        name: 'Duplicate Test',
        version: '1.0.0',
        directories: {}
      }));

      assert.throws(() => {
        new PluginManager();
      }, /already exists/i);

      // Cleanup
      fs.unlinkSync(testFile);
    });
  });

  describe('Plugin Structure', () => {
    it('should have all expected agent plugin files', () => {
      const expectedAgents = [
        'claude',
        'cursor',
        'windsurf',
        'kilocode',
        'antigravity',
        'copilot',
        'continue',
        'opencode',
        'cline',
        'roo',
        'aider'
      ];

      const plugins = pluginManager.getAllPlugins();
      expectedAgents.forEach(agentId => {
        assert.ok(plugins.has(agentId), `Missing plugin for agent: ${agentId}`);
      });
    });

    it('should have valid structure for each plugin', () => {
      const plugins = pluginManager.getAllPlugins();

      plugins.forEach((plugin, id) => {
        assert.ok(plugin.id, `Plugin ${id} missing 'id' field`);
        assert.ok(plugin.name, `Plugin ${id} missing 'name' field`);
        assert.ok(plugin.version, `Plugin ${id} missing 'version' field`);
        assert.ok(plugin.directories, `Plugin ${id} missing 'directories' field`);
        assert.equal(typeof plugin.directories, 'object', `Plugin ${id} 'directories' must be object`);
      });
    });

    it('should have unique IDs for all plugins', () => {
      const plugins = pluginManager.getAllPlugins();
      const ids = Array.from(plugins.keys());
      const uniqueIds = new Set(ids);

      assert.equal(ids.length, uniqueIds.size, 'All plugin IDs must be unique');
    });
  });

  describe('Backwards Compatibility', () => {
    it('should be able to convert plugins to AGENTS object format', () => {
      const plugins = pluginManager.getAllPlugins();
      const agentsObject = {};

      plugins.forEach((plugin, id) => {
        agentsObject[id] = {
          name: plugin.name,
          description: plugin.description || '',
          dirs: Object.values(plugin.directories.rules || plugin.directories.commands || []),
        };
      });

      assert.ok(agentsObject.claude, 'Should convert claude plugin');
      assert.ok(agentsObject.cursor, 'Should convert cursor plugin');
      assert.equal(typeof agentsObject.claude.name, 'string');
    });
  });
});
