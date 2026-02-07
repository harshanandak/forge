/**
 * Vercel Skills Registry Client
 *
 * Client library for interacting with the Vercel skills.sh registry API
 */

import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Registry API base URL
 * TODO: Update with actual Vercel registry endpoint when available
 */
const REGISTRY_API = process.env.SKILLS_REGISTRY_API || 'https://skills.sh/api';

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
  } catch (err) {
    return null;
  }
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
  const url = `${REGISTRY_API}${endpoint}`;

  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  };

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const response = await fetch(url, {
    ...options,
    headers
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Registry API error (${response.status}): ${error}`);
  }

  return response.json();
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

  return apiRequest(`/skills?${params}`);
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
  return apiRequest(`/skills/${encodeURIComponent(name)}/download`);
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
  } catch (err) {
    return false;
  }
}
