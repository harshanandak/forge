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
  // Claude Code (with cowork sub-check handled separately)
  ['CLAUDECODE', 'claude'],
  ['CLAUDE_CODE', 'claude'],
  // Cursor
  ['CURSOR_TRACE_ID', 'cursor'],
  ['CURSOR_AGENT', 'cursor'],
  // Gemini
  ['GEMINI_CLI', 'gemini'],
  // Codex
  ['CODEX_SANDBOX', 'codex'],
  ['CODEX_CI', 'codex'],
  ['CODEX_THREAD_ID', 'codex'],
  // Antigravity
  ['ANTIGRAVITY_AGENT', 'antigravity'],
  // Augment
  ['AUGMENT_AGENT', 'augment'],
  // OpenCode
  ['OPENCODE_CLIENT', 'opencode'],
  // GitHub Copilot
  ['COPILOT_MODEL', 'github-copilot'],
  ['COPILOT_ALLOW_ALL', 'github-copilot'],
  ['COPILOT_GITHUB_TOKEN', 'github-copilot'],
  // Replit
  ['REPL_ID', 'replit'],
];

/**
 * Layer 4 mapping: config file/dir paths → agent name.
 * Paths are relative to project root.
 * @type {Array<[string, string]>}
 */
const CONFIG_SIGNATURES = [
  [path.join('.claude', 'settings.json'), 'claude'],
  ['.cursorrules', 'cursor'],
  [path.join('.cursor', 'rules'), 'cursor'],
  ['.windsurfrules', 'windsurf'],
  [path.join('.windsurf', 'rules'), 'windsurf'],
  ['.clinerules', 'cline'],
  ['.cline', 'cline'],
  [path.join('.roo', 'rules'), 'roo-code'],
  ['.roo', 'roo-code'],
  ['.kilocode', 'kilocode'],
  [path.join('.github', 'copilot-instructions.md'), 'github-copilot'],
  ['codex.md', 'codex'],
  ['.codex', 'codex'],
  ['GEMINI.md', 'gemini'],
  ['.gemini', 'gemini'],
  [path.join('.continue', 'config.json'), 'continue'],
  ['.aider.conf.yml', 'aider'],
  ['.amazonq', 'amazon-q'],
];

/**
 * Detect the actively running AI agent from environment signals.
 *
 * Uses a 3-layer priority scheme:
 *   1. AI_AGENT env var (universal, highest priority)
 *   2. Agent-specific env vars (high confidence)
 *   3. VSCode path parsing (medium confidence)
 *
 * @param {Record<string, string>} [env=process.env] - Environment variables
 * @returns {{ name: string, source: 'env'|'path', confidence: 'high'|'medium' } | null}
 */
function detectActiveAgent(env = process.env) {
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

  // Layer 3: VSCode path parsing
  const pathResult = _detectFromVSCodePaths(env);
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

  if (combined.includes('cursor')) {
    return { agent: 'cursor', editor: 'cursor' };
  }
  if (combined.includes('windsurf')) {
    return { agent: 'windsurf', editor: 'windsurf' };
  }

  // Generic VSCode — not a specific agent
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
  const active = detectActiveAgent(env);
  const configuredAgents = detectConfiguredAgents(projectRoot);

  // Determine editor from VSCode paths
  const vscodePaths = _detectFromVSCodePaths(env);
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
