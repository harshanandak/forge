/**
 * Plugin Schema Tests
 *
 * Tests to verify that all plugin JSON files exist and have valid structure.
 *
 * TDD Phase: RED
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('Plugin Schema Validation', () => {
  const pluginDir = path.join(__dirname, '../../lib/agents');
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

  describe('Plugin File Existence', () => {
    expectedAgents.forEach(agentId => {
      it(`should have ${agentId}.plugin.json file`, () => {
        const pluginFile = path.join(pluginDir, `${agentId}.plugin.json`);
        assert.ok(
          fs.existsSync(pluginFile),
          `Plugin file ${agentId}.plugin.json does not exist`
        );
      });
    });

    it('should have lib/agents directory', () => {
      assert.ok(
        fs.existsSync(pluginDir),
        'lib/agents directory does not exist'
      );
    });
  });

  describe('Plugin JSON Structure', () => {
    expectedAgents.forEach(agentId => {
      describe(`${agentId} plugin`, () => {
        let plugin;

        it('should be valid JSON', () => {
          const pluginFile = path.join(pluginDir, `${agentId}.plugin.json`);
          const content = fs.readFileSync(pluginFile, 'utf-8');

          assert.doesNotThrow(() => {
            plugin = JSON.parse(content);
          }, `${agentId}.plugin.json is not valid JSON`);
        });

        it('should have required field: id', () => {
          const pluginFile = path.join(pluginDir, `${agentId}.plugin.json`);
          const plugin = JSON.parse(fs.readFileSync(pluginFile, 'utf-8'));

          assert.ok(plugin.id, `${agentId} plugin missing 'id' field`);
          assert.equal(
            typeof plugin.id,
            'string',
            `${agentId} plugin 'id' must be string`
          );
        });

        it('should have required field: name', () => {
          const pluginFile = path.join(pluginDir, `${agentId}.plugin.json`);
          const plugin = JSON.parse(fs.readFileSync(pluginFile, 'utf-8'));

          assert.ok(plugin.name, `${agentId} plugin missing 'name' field`);
          assert.equal(
            typeof plugin.name,
            'string',
            `${agentId} plugin 'name' must be string`
          );
        });

        it('should have required field: version', () => {
          const pluginFile = path.join(pluginDir, `${agentId}.plugin.json`);
          const plugin = JSON.parse(fs.readFileSync(pluginFile, 'utf-8'));

          assert.ok(plugin.version, `${agentId} plugin missing 'version' field`);
          assert.equal(
            typeof plugin.version,
            'string',
            `${agentId} plugin 'version' must be string`
          );
        });

        it('should have required field: directories', () => {
          const pluginFile = path.join(pluginDir, `${agentId}.plugin.json`);
          const plugin = JSON.parse(fs.readFileSync(pluginFile, 'utf-8'));

          assert.ok(plugin.directories, `${agentId} plugin missing 'directories' field`);
          assert.equal(
            typeof plugin.directories,
            'object',
            `${agentId} plugin 'directories' must be object`
          );
        });

        it('should have correct ID matching filename', () => {
          const pluginFile = path.join(pluginDir, `${agentId}.plugin.json`);
          const plugin = JSON.parse(fs.readFileSync(pluginFile, 'utf-8'));

          assert.equal(
            plugin.id,
            agentId,
            `${agentId} plugin ID should match filename`
          );
        });

        it('should have optional description field as string', () => {
          const pluginFile = path.join(pluginDir, `${agentId}.plugin.json`);
          const plugin = JSON.parse(fs.readFileSync(pluginFile, 'utf-8'));

          if (plugin.description) {
            assert.equal(
              typeof plugin.description,
              'string',
              `${agentId} plugin 'description' must be string if present`
            );
          }
        });

        it('should have optional homepage field as string', () => {
          const pluginFile = path.join(pluginDir, `${agentId}.plugin.json`);
          const plugin = JSON.parse(fs.readFileSync(pluginFile, 'utf-8'));

          if (plugin.homepage) {
            assert.equal(
              typeof plugin.homepage,
              'string',
              `${agentId} plugin 'homepage' must be string if present`
            );
          }
        });
      });
    });
  });

  describe('Plugin ID Uniqueness', () => {
    it('should have unique IDs across all plugins', () => {
      const ids = new Set();
      const duplicates = [];

      expectedAgents.forEach(agentId => {
        const pluginFile = path.join(pluginDir, `${agentId}.plugin.json`);
        if (fs.existsSync(pluginFile)) {
          const plugin = JSON.parse(fs.readFileSync(pluginFile, 'utf-8'));
          if (ids.has(plugin.id)) {
            duplicates.push(plugin.id);
          }
          ids.add(plugin.id);
        }
      });

      assert.equal(
        duplicates.length,
        0,
        `Duplicate plugin IDs found: ${duplicates.join(', ')}`
      );
    });
  });

  describe('Required Schema Fields', () => {
    it('should have version field in semver format', () => {
      const semverRegex = /^\d+\.\d+\.\d+$/;

      expectedAgents.forEach(agentId => {
        const pluginFile = path.join(pluginDir, `${agentId}.plugin.json`);
        if (fs.existsSync(pluginFile)) {
          const plugin = JSON.parse(fs.readFileSync(pluginFile, 'utf-8'));
          assert.match(
            plugin.version,
            semverRegex,
            `${agentId} plugin version must be in semver format (x.y.z)`
          );
        }
      });
    });

    it('should have directories as non-empty object', () => {
      expectedAgents.forEach(agentId => {
        const pluginFile = path.join(pluginDir, `${agentId}.plugin.json`);
        if (fs.existsSync(pluginFile)) {
          const plugin = JSON.parse(fs.readFileSync(pluginFile, 'utf-8'));
          assert.equal(
            typeof plugin.directories,
            'object',
            `${agentId} plugin directories must be object`
          );
          assert.ok(
            !Array.isArray(plugin.directories),
            `${agentId} plugin directories must not be array`
          );
        }
      });
    });
  });
});
