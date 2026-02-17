/**
 * Vercel Skills Registry Client
 *
 * Client library for interacting with the Vercel skills.sh registry API
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Get registry URL from config or environment
 *
 * @returns {string} Registry API URL
 */
function getRegistryUrl() {
  // 1. Check config file first
  try {
    const configPath = join(process.cwd(), '.skills', '.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    if (config.registryUrl) {
      return config.registryUrl;
    }
  } catch (_err) { // NOSONAR - config file absence is normal; errors mean use defaults
  }

  // 2. Check environment variable
  if (process.env.SKILLS_REGISTRY_API) {
    return process.env.SKILLS_REGISTRY_API;
  }

  // 3. Use default
  return 'https://skills.sh/api';
}

/**
 * Get API key from config or environment
 *
 * @returns {string|null} API key or null if not configured
 */
function getApiKey() {
  // Try environment variable first
  if (process.env.SKILLS_API_KEY) {
    return process.env.SKILLS_API_KEY;
  }

  // Try config file
  try {
    const configPath = join(process.cwd(), '.skills', '.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    return config.apiKey || null;
  } catch (_err) {
    return null;
  }
}

/**
 * Validate skill package structure
 *
 * @param {Object} pkg - Skill package to validate
 * @throws {Error} If package is invalid
 */
function validateSkillPackage(pkg) {
  if (!pkg || typeof pkg !== 'object') {
    throw new Error('Invalid skill package: must be an object');
  }

  if (!pkg.content || typeof pkg.content !== 'string') {
    throw new Error('Invalid skill package: content must be a string');
  }

  if (!pkg.metadata || typeof pkg.metadata !== 'object') {
    throw new Error('Invalid skill package: metadata must be an object');
  }

  // Validate required metadata fields
  const required = ['title', 'description', 'category'];
  for (const field of required) {
    if (!pkg.metadata[field]) {
      throw new Error(`Invalid skill package: metadata.${field} is required`);
    }
  }

  // Validate SKILL.md has YAML frontmatter
  if (!pkg.content.startsWith('---\n')) {
    throw new Error('Invalid skill package: content must start with YAML frontmatter');
  }

  return true;
}

/**
 * Validate search results
 *
 * @param {Array} results - Search results to validate
 * @throws {Error} If results are invalid
 */
function validateSearchResults(results) {
  if (!Array.isArray(results)) {
    throw new Error('Invalid search results: must be an array');
  }

  for (const skill of results) {
    if (!skill.name || typeof skill.name !== 'string') {
      throw new Error('Invalid search result: name is required');
    }

    if (!skill.description || typeof skill.description !== 'string') {
      throw new Error('Invalid search result: description is required');
    }
  }

  return true;
}

/**
 * Make authenticated API request
 *
 * @param {string} endpoint - API endpoint path
 * @param {Object} options - Fetch options
 * @returns {Promise<Object>} Response data
 */
async function apiRequest(endpoint, options = {}) {
  const apiKey = getApiKey();
  const registryUrl = getRegistryUrl();
  const url = `${registryUrl}${endpoint}`;

  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  };

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  try {
    const response = await fetch(url, {
      ...options,
      headers,
      signal: AbortSignal.timeout(30000) // 30 second timeout
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Registry API error (${response.status}): ${error}`);
    }

    const data = await response.json();

    // Validate response is valid JSON
    if (data === null || data === undefined) {
      throw new Error('Registry API returned empty response');
    }

    return data;
  } catch (error) {
    // Network errors
    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      throw new Error('Network error: Unable to connect to registry. Check your internet connection.');
    }

    // Timeout errors
    if (error.name === 'AbortError' || error.message.includes('timeout')) {
      throw new Error('Request timeout: Registry API took too long to respond');
    }

    // Re-throw other errors
    throw error;
  }
}

/**
 * Search for skills in the registry
 *
 * @param {string} query - Search query
 * @param {Object} filters - Search filters (category, author, etc.)
 * @returns {Promise<Array>} Array of matching skills
 */
export async function searchSkills(query, filters = {}) {
  const params = new URLSearchParams({
    q: query,
    ...filters
  });

  const results = await apiRequest(`/skills?${params}`);

  // Validate results structure
  validateSearchResults(results);

  return results;
}

/**
 * Get skill details from registry
 *
 * @param {string} name - Skill name
 * @returns {Promise<Object>} Skill metadata and content
 */
export async function getSkill(name) {
  return apiRequest(`/skills/${encodeURIComponent(name)}`);
}

/**
 * Download skill package from registry
 *
 * @param {string} name - Skill name
 * @returns {Promise<Object>} Skill package { content, metadata }
 */
export async function downloadSkill(name) {
  const pkg = await apiRequest(`/skills/${encodeURIComponent(name)}/download`);

  // Validate package structure before returning
  validateSkillPackage(pkg);

  return pkg;
}

/**
 * Publish skill to registry
 *
 * @param {Object} skillPackage - Skill package to publish
 * @returns {Promise<Object>} Publication result
 */
export async function publishSkill(skillPackage) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('API key required. Set SKILLS_API_KEY or run: skills config set api-key <key>');
  }

  return apiRequest('/skills', {
    method: 'POST',
    body: JSON.stringify(skillPackage)
  });
}

/**
 * Check if skill exists in registry
 *
 * @param {string} name - Skill name
 * @returns {Promise<boolean>} True if skill exists
 */
export async function skillExists(name) {
  try {
    await getSkill(name);
    return true;
  } catch (err) {
    if (err.message.includes('404')) {
      return false;
    }
    throw err;
  }
}

/**
 * Get user's published skills
 *
 * @returns {Promise<Array>} Array of user's skills
 */
export async function getUserSkills() {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('API key required');
  }

  return apiRequest('/user/skills');
}

/**
 * Check API connectivity
 *
 * @returns {Promise<boolean>} True if API is accessible
 */
export async function checkConnection() {
  try {
    await apiRequest('/health');
    return true;
  } catch (_err) {
    return false;
  }
}
