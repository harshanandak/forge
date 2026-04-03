/**
 * Plugin Manager
 *
 * Handles loading, validating, and managing agent plugin JSON files.
 * Provides discoverable plugin architecture for AI coding agents.
 */

const fs = require('node:fs');
const path = require('node:path');

const SUPPORT_STATUSES = Object.freeze([
  'first-class',
  'supported',
  'compatibility',
  'deprecated',
  'unsupported',
]);

const NATIVE_SURFACES = Object.freeze([
  'cli-first',
  'editor-native',
  'desktop-app',
  'web-app',
  'terminal-native',
  'hybrid',
]);

const DEFAULT_SUPPORT_STATUS = 'supported';

const SURFACE_BY_AGENT_ID = Object.freeze({
  claude: 'cli-first',
  codex: 'cli-first',
  opencode: 'cli-first',
  cline: 'editor-native',
  cursor: 'editor-native',
  copilot: 'editor-native',
  kilocode: 'editor-native',
  roo: 'editor-native',
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateCapabilityFlags(capabilities, errors) {
  const booleanFields = ['commands', 'rules', 'skills', 'mcp', 'contextMode'];

  booleanFields.forEach((field) => {
    if (capabilities[field] !== undefined && typeof capabilities[field] !== 'boolean') {
      errors.push(`"capabilities.${field}" must be a boolean`);
    }
  });

  if (capabilities.hooks !== undefined) {
    if (typeof capabilities.hooks === 'boolean') {
      return;
    }

    if (!isPlainObject(capabilities.hooks)) {
      errors.push('"capabilities.hooks" must be a boolean or an object');
      return;
    }

    if (
      capabilities.hooks.blocking !== undefined &&
      typeof capabilities.hooks.blocking !== 'boolean'
    ) {
      errors.push('"capabilities.hooks.blocking" must be a boolean');
    }
  }
}

function validateSupportMetadata(support, errors) {
  if (support === undefined) {
    return;
  }

  if (!isPlainObject(support)) {
    errors.push('"support" must be an object');
    return;
  }

  if (support.status !== undefined) {
    if (
      typeof support.status !== 'string' ||
      !SUPPORT_STATUSES.includes(support.status)
    ) {
      errors.push(
        `"support.status" must be one of: ${SUPPORT_STATUSES.join(', ')}`
      );
    }
  }

  if (support.surface !== undefined) {
    if (
      typeof support.surface !== 'string' ||
      !NATIVE_SURFACES.includes(support.surface)
    ) {
      errors.push(
        `"support.surface" must be one of: ${NATIVE_SURFACES.join(', ')}`
      );
    }
  }

  if (support.install !== undefined) {
    if (!isPlainObject(support.install)) {
      errors.push('"support.install" must be an object');
    } else {
      if (
        support.install.required !== undefined &&
        typeof support.install.required !== 'boolean'
      ) {
        errors.push('"support.install.required" must be a boolean');
      }

      if (
        support.install.repairRequired !== undefined &&
        typeof support.install.repairRequired !== 'boolean'
      ) {
        errors.push('"support.install.repairRequired" must be a boolean');
      }
    }
  }
}

function collectPluginValidationErrors(plugin) {
  const errors = [];

  if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) {
    return ['Plugin must be a non-null object'];
  }

  const required = ['id', 'name', 'version', 'directories'];

  required.forEach((field) => {
    if (!plugin[field]) {
      errors.push(`Missing required field "${field}"`);
    }
  });

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
    if (!isPlainObject(plugin.directories)) {
      errors.push('"directories" must be an object');
    } else if (Object.keys(plugin.directories).length === 0) {
      errors.push('"directories" must not be empty');
    }
  }

  if (plugin.description !== undefined && typeof plugin.description !== 'string') {
    errors.push('"description" must be a string');
  }
  if (plugin.homepage !== undefined && typeof plugin.homepage !== 'string') {
    errors.push('"homepage" must be a string');
  }

  if (plugin.capabilities !== undefined) {
    if (!isPlainObject(plugin.capabilities)) {
      errors.push('"capabilities" must be an object');
    } else {
      validateCapabilityFlags(plugin.capabilities, errors);
    }
  }

  validateSupportMetadata(plugin.support, errors);

  return errors;
}

function inferNativeSurface(plugin) {
  if (plugin.support && typeof plugin.support.surface === 'string') {
    return plugin.support.surface;
  }

  if (plugin.id && SURFACE_BY_AGENT_ID[plugin.id]) {
    return SURFACE_BY_AGENT_ID[plugin.id];
  }

  if (plugin.directories && (plugin.directories.instructions || plugin.directories.prompts)) {
    return 'editor-native';
  }

  return 'cli-first';
}

function normalizePluginMetadata(plugin) {
  const validationErrors = collectPluginValidationErrors(plugin);
  if (validationErrors.length > 0) {
    throw new Error(`Invalid plugin schema: ${validationErrors.join('; ')}`);
  }

  const capabilities = isPlainObject(plugin.capabilities) ? plugin.capabilities : {};
  const support = isPlainObject(plugin.support) ? plugin.support : {};
  const hooks = capabilities.hooks;
  const blockingHooks = isPlainObject(hooks) ? hooks.blocking : hooks;

  return {
    ...plugin,
    normalizedCapabilities: {
      nativeSurface: inferNativeSurface(plugin),
      supportStatus: support.status || DEFAULT_SUPPORT_STATUS,
      commands: Boolean(capabilities.commands),
      rules: Boolean(capabilities.rules),
      skills: Boolean(capabilities.skills),
      mcp: Boolean(capabilities.mcp),
      contextMode: Boolean(capabilities.contextMode),
      hooks: {
        blocking: Boolean(blockingHooks),
      },
      install: {
        required: Boolean(support.install?.required),
        repairRequired: Boolean(support.install?.repairRequired),
      },
    },
  };
}

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
        const normalizedPlugin = normalizePluginMetadata(plugin);

        // Check for duplicate IDs
        if (this.plugins.has(normalizedPlugin.id)) {
          throw new Error(`Plugin with ID "${normalizedPlugin.id}" already exists`);
        }

        this.plugins.set(normalizedPlugin.id, normalizedPlugin);
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
    const errors = collectPluginValidationErrors(plugin);

    if (errors.length > 0) {
      throw new Error(`Plugin validation failed: ${errors[0]}`);
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
  const errors = collectPluginValidationErrors(plugin);
  return { valid: errors.length === 0, errors };
}

module.exports = PluginManager;
module.exports.PluginManager = PluginManager;
module.exports.validatePluginSchema = validatePluginSchema;
module.exports.normalizePluginMetadata = normalizePluginMetadata;
