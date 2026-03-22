/**
 * Agent Auto-Detection Module
 *
 * 4-layer detection strategy:
 *   Layer 1: AI_AGENT env var (universal standard)
 *   Layer 2: Agent-specific env vars (high confidence)
 *   Layer 3: VSCode path parsing (medium confidence)
 *   Layer 4: Config file signatures (medium-low confidence)
 *
 * @module detect-agent
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Layer 2 mapping: env var → agent name.
 * Order matters — first match wins within this layer.
 * Each entry: [envVarName, agentName]
 * @type {Array<[string, string]>}
 */
const AGENT_ENV_VARS = [
  // Forge-supported agents only (7 agents)
  // Claude Code (with cowork sub-check handled separately)
  ['CLAUDECODE', 'claude'],
  ['CLAUDE_CODE', 'claude'],
  // Cursor
  ['CURSOR_TRACE_ID', 'cursor'],
  ['CURSOR_AGENT', 'cursor'],
  // Codex (OpenAI)
  ['CODEX_SANDBOX', 'codex'],
  ['CODEX_CI', 'codex'],
  ['CODEX_THREAD_ID', 'codex'],
  // OpenCode
  ['OPENCODE_CLIENT', 'opencode'],
  // GitHub Copilot
  ['COPILOT_MODEL', 'github-copilot'],
  ['COPILOT_ALLOW_ALL', 'github-copilot'],
  ['COPILOT_GITHUB_TOKEN', 'github-copilot'],
  // Cline, Roo Code, Kilocode — no env vars (VSCode extensions, config-file-only)
];

/**
 * Layer 4 mapping: config file/dir paths → agent name.
 * Paths are relative to project root.
 * @type {Array<[string, string]>}
 */
const CONFIG_SIGNATURES = [
  // Forge-supported agents only (7 agents)
  [path.join('.claude', 'settings.json'), 'claude'],
  ['.cursorrules', 'cursor'],
  [path.join('.cursor', 'rules'), 'cursor'],
  ['.clinerules', 'cline'],
  ['.cline', 'cline'],
  [path.join('.roo', 'rules'), 'roo-code'],
  ['.roo', 'roo-code'],
  ['.kilocode', 'kilocode'],
  ['codex.md', 'codex'],
  ['.codex', 'codex'],
  [path.join('.opencode', 'commands'), 'opencode'],
  ['.opencode', 'opencode'],
  [path.join('.github', 'copilot-instructions.md'), 'github-copilot'],
];

/**
 * Detect the actively running AI agent from environment signals.
 *
 * Covers layers 1-3 of the 4-layer detection strategy:
 *   1. AI_AGENT env var (universal, highest priority)
 *   2. Agent-specific env vars (high confidence)
 *   3. VSCode path parsing (medium confidence)
 * Layer 4 (config file signatures) is in detectConfiguredAgents().
 *
 * @param {Record<string, string>} [env=process.env] - Environment variables
 * @param {{ agent: string|null, editor: string|null }|null} [precomputedVSCodePaths] - Pre-computed VSCode path result to avoid duplicate calls
 * @returns {{ name: string, source: 'env'|'path', confidence: 'high'|'medium' } | null}
 */
function detectActiveAgent(env = process.env, precomputedVSCodePaths) {
  // Layer 1: AI_AGENT universal env var
  if (env.AI_AGENT) {
    return { name: env.AI_AGENT, source: 'env', confidence: 'high' };
  }

  // Layer 2: Agent-specific env vars
  // Special sub-check: Claude Code cowork mode
  if ((env.CLAUDECODE || env.CLAUDE_CODE) && env.CLAUDE_CODE_IS_COWORK) {
    return { name: 'cowork', source: 'env', confidence: 'high' };
  }

  for (const [varName, agentName] of AGENT_ENV_VARS) {
    if (env[varName]) {
      return { name: agentName, source: 'env', confidence: 'high' };
    }
  }

  // Layer 3: VSCode path parsing (reuse pre-computed result if available)
  const pathResult = precomputedVSCodePaths !== undefined ? precomputedVSCodePaths : _detectFromVSCodePaths(env);
  if (pathResult && pathResult.agent) {
    return { name: pathResult.agent, source: 'path', confidence: 'medium' };
  }

  return null;
}

/**
 * Parse VSCode-related env vars for editor/agent identification.
 *
 * @param {Record<string, string>} env - Environment variables
 * @returns {{ agent: string|null, editor: string|null } | null}
 * @private
 */
function _detectFromVSCodePaths(env) {
  const pathsToCheck = [
    env.VSCODE_CODE_CACHE_PATH,
    env.VSCODE_NLS_CONFIG,
  ].filter(Boolean);

  if (pathsToCheck.length === 0) return null;

  const combined = pathsToCheck.join(' ').toLowerCase();

  // Only detect Forge-supported agents via VSCode paths
  if (combined.includes('cursor')) {
    return { agent: 'cursor', editor: 'cursor' };
  }

  // Generic VSCode (or unsupported VSCode forks) — not a specific agent
  if (combined.includes('code')) {
    return { agent: null, editor: 'vscode' };
  }

  return null;
}

/**
 * Detect all agents with config files present in the project root (Layer 4).
 *
 * @param {string} projectRoot - Absolute path to project root
 * @returns {string[]} Array of unique agent names detected from config files
 */
function detectConfiguredAgents(projectRoot) {
  const detected = new Set();

  for (const [relativePath, agentName] of CONFIG_SIGNATURES) {
    const fullPath = path.join(projectRoot, relativePath);
    try {
      if (fs.existsSync(fullPath)) {
        detected.add(agentName);
      }
    } catch (_err) {
      // Permission error or other fs issue — skip silently
    }
  }

  return [...detected];
}

/**
 * Full environment detection combining all 4 layers.
 *
 * @param {string} projectRoot - Absolute path to project root
 * @param {Record<string, string>} [env=process.env] - Environment variables
 * @returns {{
 *   activeAgent: string|null,
 *   activeAgentSource: 'env'|'path'|null,
 *   confidence: 'high'|'medium'|null,
 *   configuredAgents: string[],
 *   editor: string|null
 * }}
 */
function detectEnvironment(projectRoot, env = process.env) {
  // Call _detectFromVSCodePaths once and share the result with detectActiveAgent's logic
  const vscodePaths = _detectFromVSCodePaths(env);

  const active = detectActiveAgent(env, vscodePaths);
  const configuredAgents = detectConfiguredAgents(projectRoot);
  const editor = vscodePaths ? vscodePaths.editor : null;

  return {
    activeAgent: active ? active.name : null,
    activeAgentSource: active ? active.source : null,
    confidence: active ? active.confidence : null,
    configuredAgents,
    editor,
  };
}

module.exports = {
  detectActiveAgent,
  detectConfiguredAgents,
  detectEnvironment,
};
