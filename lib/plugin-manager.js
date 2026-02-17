/**
 * Plugin Manager
 *
 * Handles loading, validating, and managing agent plugin JSON files.
 * Provides discoverable plugin architecture for AI coding agents.
 */

const fs = require('node:fs');
const path = require('node:path');

class PluginManager {
  constructor() {
    this.plugins = new Map();
    this.loadPlugins();
  }

  /**
   * Load all plugin files from lib/agents/ directory
   */
  loadPlugins() {
    const pluginDir = path.join(__dirname, 'agents');

    // Create directory if it doesn't exist (for first-time setup)
    if (!fs.existsSync(pluginDir)) {
      fs.mkdirSync(pluginDir, { recursive: true });
      return;
    }

    const files = fs.readdirSync(pluginDir)
      .filter(f => f.endsWith('.plugin.json'));

    files.forEach(file => {
      try {
        const content = fs.readFileSync(path.join(pluginDir, file), 'utf-8');
        const plugin = JSON.parse(content);
        this.validatePlugin(plugin);

        // Check for duplicate IDs
        if (this.plugins.has(plugin.id)) {
          throw new Error(`Plugin with ID "${plugin.id}" already exists`);
        }

        this.plugins.set(plugin.id, plugin);
      } catch (error) {
        // Re-throw with file context
        throw new Error(`Failed to load plugin ${file}: ${error.message}`);
      }
    });
  }

  /**
   * Validate plugin schema
   * @param {Object} plugin - Plugin object to validate
   * @throws {Error} If validation fails
   */
  validatePlugin(plugin) {
    const required = ['id', 'name', 'version', 'directories'];

    // Check required fields exist
    required.forEach(field => {
      if (!plugin[field]) {
        throw new Error(`Plugin validation failed: missing required field "${field}"`);
      }
    });

    // Validate field types
    if (typeof plugin.id !== 'string') {
      throw new TypeError('Plugin validation failed: "id" must be a string');
    }
    if (typeof plugin.name !== 'string') {
      throw new TypeError('Plugin validation failed: "name" must be a string');
    }
    if (typeof plugin.version !== 'string') {
      throw new TypeError('Plugin validation failed: "version" must be a string');
    }
    if (typeof plugin.directories !== 'object' || Array.isArray(plugin.directories)) {
      throw new TypeError('Plugin validation failed: "directories" must be an object');
    }

    // Validate optional fields if present
    if (plugin.description && typeof plugin.description !== 'string') {
      throw new TypeError('Plugin validation failed: "description" must be a string');
    }
    if (plugin.homepage && typeof plugin.homepage !== 'string') {
      throw new TypeError('Plugin validation failed: "homepage" must be a string');
    }
  }

  /**
   * Get plugin by ID
   * @param {string} id - Plugin ID
   * @returns {Object|undefined} Plugin object or undefined if not found
   */
  getPlugin(id) {
    return this.plugins.get(id);
  }

  /**
   * Get all plugins as a Map
   * @returns {Map} Map of plugin ID to plugin object
   */
  getAllPlugins() {
    return this.plugins;
  }

  /**
   * Get list of all agent IDs
   * @returns {Array<string>} Array of plugin IDs
   */
  listAgents() {
    return Array.from(this.plugins.keys());
  }
}

/**
 * Standalone plugin schema validator (for testing and external use)
 * @param {Object} plugin - Plugin object to validate
 * @returns {{valid: boolean, errors: Array<string>}}
 */
function validatePluginSchema(plugin) {
  const errors = [];

  // Check if plugin is an object
  if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) {
    return { valid: false, errors: ['Plugin must be a non-null object'] };
  }

  // Check required fields
  const required = ['id', 'name', 'version', 'directories'];
  required.forEach(field => {
    if (!plugin[field]) {
      errors.push(`Missing required field "${field}"`);
    }
  });

  // Validate field types
  if (plugin.id !== undefined && typeof plugin.id !== 'string') {
    errors.push('"id" must be a string');
  }
  if (plugin.name !== undefined && typeof plugin.name !== 'string') {
    errors.push('"name" must be a string');
  }
  if (plugin.version !== undefined && typeof plugin.version !== 'string') {
    errors.push('"version" must be a string');
  }
  if (plugin.directories !== undefined) {
    if (typeof plugin.directories !== 'object' || Array.isArray(plugin.directories)) {
      errors.push('"directories" must be an object');
    } else if (Object.keys(plugin.directories).length === 0) {
      errors.push('"directories" must not be empty');
    }
  }

  // Validate optional fields if present
  if (plugin.description !== undefined && typeof plugin.description !== 'string') {
    errors.push('"description" must be a string');
  }
  if (plugin.homepage !== undefined && typeof plugin.homepage !== 'string') {
    errors.push('"homepage" must be a string');
  }

  return { valid: errors.length === 0, errors };
}

module.exports = PluginManager;
module.exports.validatePluginSchema = validatePluginSchema;
