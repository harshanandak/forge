/**
 * skills config - Manage configuration (API keys, registry URL, etc.)
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';

/**
 * Get configuration file path
 *
 * @returns {string} Config file path
 */
function getConfigPath() {
  return join(process.cwd(), '.skills', '.config.json');
}

/**
 * Load configuration
 *
 * @returns {Object} Configuration object
 */
function loadConfig() {
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    return {
      apiKey: null,
      registryUrl: process.env.SKILLS_REGISTRY_API || 'https://skills.sh/api'
    };
  }

  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.warn(chalk.yellow('Warning: Failed to parse config file, using defaults'));
    return {
      apiKey: null,
      registryUrl: 'https://skills.sh/api'
    };
  }
}

/**
 * Save configuration
 *
 * @param {Object} config - Configuration to save
 */
function saveConfig(config) {
  const configPath = getConfigPath();
  const skillsDir = join(process.cwd(), '.skills');

  // Create .skills directory if needed
  if (!existsSync(skillsDir)) {
    console.error(chalk.red('✗ Skills not initialized'));
    console.error(chalk.yellow('Run "skills init" first'));
    throw new Error('Skills not initialized');
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * Config command - Manage configuration
 *
 * @param {string} action - Action (get, set, list)
 * @param {string} key - Config key
 * @param {string} value - Config value (for set)
 * @param {Object} options - Command options
 */
export async function configCommand(action, key, value, _options = {}) {
  try {
    const config = loadConfig();

    switch (action) {
      case 'get':
        if (!key) {
          console.error(chalk.red('✗ Key required'));
          console.error(chalk.yellow('Usage: skills config get <key>'));
          throw new Error('Key required');
        }
        configGet(config, key);
        break;

      case 'set':
        if (!key || !value) {
          console.error(chalk.red('✗ Key and value required'));
          console.error(chalk.yellow('Usage: skills config set <key> <value>'));
          throw new Error('Key and value required');
        }
        configSet(config, key, value);
        break;

      case 'list':
        configList(config);
        break;

      case 'unset':
        if (!key) {
          console.error(chalk.red('✗ Key required'));
          console.error(chalk.yellow('Usage: skills config unset <key>'));
          throw new Error('Key required');
        }
        configUnset(config, key);
        break;

      default:
        console.error(chalk.red('✗ Invalid action:'), action);
        console.error();
        console.error('Available actions:');
        console.error('  get <key>           - Get configuration value');
        console.error('  set <key> <value>   - Set configuration value');
        console.error('  list                - List all configuration');
        console.error('  unset <key>         - Remove configuration value');
        console.error();
        throw new Error(`Invalid action: ${action}`);
    }
  } catch (error) {
    if (error.message.includes('required') || error.message.includes('Invalid action')) {
      // Already logged
      throw error;
    }

    console.error(chalk.red('✗ Error:'), error.message);
    throw error;
  }
}

/**
 * Get configuration value
 */
function configGet(config, key) {
  const normalizedKey = normalizeKey(key);
  const value = config[normalizedKey];

  if (value === undefined || value === null) {
    console.log(chalk.yellow(`Configuration "${key}" not set`));
    return;
  }

  // Mask API keys for security
  if (normalizedKey === 'apiKey' || key.toLowerCase().includes('key')) {
    // codeql[js/clear-text-logging] - Key is masked with maskApiKey() before logging
    console.log(maskApiKey(value));
  } else {
    console.log(value);
  }
}

/**
 * Set configuration value
 */
function configSet(config, key, value) {
  const normalizedKey = normalizeKey(key);

  config[normalizedKey] = value;
  saveConfig(config);

  // codeql[js/clear-text-logging] - Key is masked with maskApiKey() before logging
  console.log(chalk.green('✓'), `Set ${key} =`, normalizedKey === 'apiKey' ? maskApiKey(value) : value);
  console.log(chalk.gray(`  Config saved to .skills/.config.json`));
}

/**
 * List all configuration
 */
function configList(config) {
  console.log(chalk.bold('\nConfiguration:'));
  console.log();

  const keys = Object.keys(config);

  if (keys.length === 0) {
    console.log(chalk.yellow('No configuration set'));
    console.log();
    return;
  }

  for (const key of keys) {
    const value = config[key];

    if (value === null || value === undefined) {
      console.log(chalk.gray(`${key}: (not set)`));
    } else if (key === 'apiKey' || key.toLowerCase().includes('key')) {
      // codeql[js/clear-text-logging] - Key is masked with maskApiKey() before logging
      console.log(`${key}: ${maskApiKey(value)}`);
    } else {
      console.log(`${key}: ${value}`);
    }
  }

  console.log();
  console.log(chalk.gray('Environment variables:'));
  if (process.env.SKILLS_API_KEY) {
    // codeql[js/clear-text-logging] - Key is masked with maskApiKey() before logging
    console.log(chalk.gray(`  SKILLS_API_KEY: ${maskApiKey(process.env.SKILLS_API_KEY)}`));
  }
  if (process.env.SKILLS_REGISTRY_API) {
    console.log(chalk.gray(`  SKILLS_REGISTRY_API: ${process.env.SKILLS_REGISTRY_API}`));
  }
  console.log();
}

/**
 * Unset configuration value
 */
function configUnset(config, key) {
  const normalizedKey = normalizeKey(key);

  if (config[normalizedKey] === undefined) {
    console.log(chalk.yellow(`Configuration "${key}" not set`));
    return;
  }

  delete config[normalizedKey];
  saveConfig(config);

  console.log(chalk.green('✓'), `Unset ${key}`);
}

/**
 * Normalize configuration key
 *
 * @param {string} key - Key to normalize
 * @returns {string} Normalized key
 */
function normalizeKey(key) {
  // Convert kebab-case and snake_case to camelCase
  const normalized = key
    .replace(/[-_]([a-z])/g, (_, letter) => letter.toUpperCase());

  // Common aliases
  const aliases = {
    'api-key': 'apiKey',
    'apikey': 'apiKey',
    'registry-url': 'registryUrl',
    'registryurl': 'registryUrl'
  };

  return aliases[key.toLowerCase()] || normalized;
}

/**
 * Mask API key for display
 *
 * @param {string} apiKey - API key to mask
 * @returns {string} Masked API key
 */
function maskApiKey(apiKey) {
  if (!apiKey || apiKey.length <= 8) {
    return '****';
  }

  const visibleStart = apiKey.slice(0, 4);
  const visibleEnd = apiKey.slice(-4);
  const masked = '*'.repeat(Math.min(apiKey.length - 8, 20));

  return `${visibleStart}${masked}${visibleEnd}`;
}
