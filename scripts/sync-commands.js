#!/usr/bin/env node

/**
 * @module sync-commands
 *
 * Utility for parsing and rebuilding YAML frontmatter in
 * `.claude/commands/*.md` files.
 *
 * Exports:
 *   parseFrontmatter(content) -> { frontmatter: object, body: string }
 *   buildFile(frontmatter, body) -> string
 */

const YAML = require('yaml');

/**
 * Parse YAML frontmatter from a markdown string.
 *
 * Frontmatter is the YAML block between two `---` markers at the very start
 * of the file. If no valid frontmatter block is found, returns an empty object
 * with the full content as the body.
 *
 * @param {string} content - The raw file content
 * @returns {{ frontmatter: Record<string, unknown>, body: string }}
 */
function parseFrontmatter(content) {
  // Frontmatter must start at the very beginning with ---
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return { frontmatter: {}, body: content };
  }

  // Find the closing --- marker (skip the opening one)
  const openLen = content.startsWith('---\r\n') ? 5 : 4; // '---\n' or '---\r\n'
  const closeIndex = content.indexOf('\n---\n', openLen - 1);
  const closeIndexCRLF = content.indexOf('\r\n---\r\n', openLen - 1);

  let yamlStr;
  let bodyStart;

  if (closeIndex === -1 && closeIndexCRLF === -1) {
    // Check for --- at end of file (no trailing newline after closing ---)
    const closeAtEnd = content.indexOf('\n---', openLen - 1);
    if (closeAtEnd !== -1 && closeAtEnd + 4 === content.length) {
      yamlStr = content.slice(openLen, closeAtEnd + 1);
      bodyStart = content.length;
    } else {
      // No closing --- found — no valid frontmatter
      return { frontmatter: {}, body: content };
    }
  } else if (closeIndex !== -1 && (closeIndexCRLF === -1 || closeIndex < closeIndexCRLF)) {
    // LF line endings
    yamlStr = content.slice(openLen, closeIndex + 1);
    bodyStart = closeIndex + 5; // skip '\n---\n'
  } else {
    // CRLF line endings
    yamlStr = content.slice(openLen, closeIndexCRLF + 2);
    bodyStart = closeIndexCRLF + 7; // skip '\r\n---\r\n'
  }

  // Parse the YAML string
  const trimmed = yamlStr.trim();
  if (trimmed === '') {
    return { frontmatter: {}, body: content.slice(bodyStart) };
  }

  /** @type {Record<string, unknown>} */
  let frontmatter;
  try {
    frontmatter = YAML.parse(trimmed);
  } catch (_err) {
    // If YAML parsing fails, treat as no frontmatter
    return { frontmatter: {}, body: content };
  }

  // YAML.parse can return null for empty docs or a scalar for non-object input
  if (frontmatter === null || typeof frontmatter !== 'object') {
    return { frontmatter: {}, body: content };
  }

  return { frontmatter, body: content.slice(bodyStart) };
}

/**
 * Build a file string from frontmatter and body.
 *
 * Produces output in the format:
 * ```
 * ---
 * key: value
 * ---
 * body content
 * ```
 *
 * @param {Record<string, unknown>} frontmatter - Key-value pairs for the YAML block
 * @param {string} body - The markdown body content
 * @returns {string} The reconstructed file content
 */
function buildFile(frontmatter, body) {
  const keys = Object.keys(frontmatter);

  let yamlBlock;
  if (keys.length === 0) {
    yamlBlock = '';
  } else {
    yamlBlock = YAML.stringify(frontmatter, {
      lineWidth: 0,       // Prevent line wrapping
      defaultKeyType: 'PLAIN',
      defaultStringType: 'PLAIN',
    }).trimEnd();
    yamlBlock += '\n';
  }

  return `---\n${yamlBlock}---\n${body}`;
}

// ---- Agent adapters -------------------------------------------------------------

/**
 * @typedef {Object} AgentAdapter
 * @property {(commandName: string) => string} dir - Target directory path
 * @property {string} extension - File extension (e.g. '.md', '.prompt.md')
 * @property {(fm: Record<string, unknown>, commandName: string) => Record<string, unknown>} transformFrontmatter
 * @property {boolean} [skip] - If true, agent is canonical source (no sync needed)
 */

/**
 * Strip all frontmatter — return empty object.
 *
 * @param {Record<string, unknown>} _fm
 * @param {string} _commandName
 * @returns {Record<string, unknown>}
 */
function stripAllFrontmatter(_fm, _commandName) {
  return {};
}

/**
 * Keep only `description` from frontmatter.
 *
 * @param {Record<string, unknown>} fm
 * @param {string} _commandName
 * @returns {Record<string, unknown>}
 */
function keepDescription(fm, _commandName) {
  /** @type {Record<string, unknown>} */
  const result = {};
  if (fm.description !== undefined) {
    result.description = fm.description;
  }
  return result;
}

/**
 * Keep `description`, add `mode: code`.
 *
 * @param {Record<string, unknown>} fm
 * @param {string} _commandName
 * @returns {Record<string, unknown>}
 */
function keepDescriptionAddMode(fm, _commandName) {
  /** @type {Record<string, unknown>} */
  const result = {};
  if (fm.description !== undefined) {
    result.description = fm.description;
  }
  result.mode = 'code';
  return result;
}

/**
 * GitHub Copilot transform: add `name`, keep `description`, add `tools`.
 *
 * @param {Record<string, unknown>} fm
 * @param {string} commandName
 * @returns {Record<string, unknown>}
 */
function copilotTransform(fm, commandName) {
  /** @type {Record<string, unknown>} */
  const result = {};
  result.name = commandName;
  if (fm.description !== undefined) {
    result.description = fm.description;
  }
  result.tools = [];
  return result;
}

/**
 * Agent adapter configuration for command sync.
 *
 * Each entry maps an agent slug to its target directory, file extension,
 * and frontmatter transform function.
 *
 * @type {Record<string, AgentAdapter>}
 */
const AGENT_ADAPTERS = {
  'claude-code': {
    dir: () => '.claude/commands/',
    extension: '.md',
    transformFrontmatter: (fm) => ({ ...fm }),
    skip: true,
  },
  cursor: {
    dir: (commandName) => `.cursor/skills/${commandName}/`,
    extension: '.md',
    transformFrontmatter: stripAllFrontmatter,
  },
  cline: {
    dir: () => '.clinerules/workflows/',
    extension: '.md',
    transformFrontmatter: stripAllFrontmatter,
  },
  opencode: {
    dir: () => '.opencode/commands/',
    extension: '.md',
    transformFrontmatter: keepDescription,
  },
  'github-copilot': {
    dir: () => '.github/prompts/',
    extension: '.prompt.md',
    transformFrontmatter: copilotTransform,
  },
  'kilo-code': {
    dir: () => '.kilocode/workflows/',
    extension: '.md',
    transformFrontmatter: keepDescriptionAddMode,
  },
  'roo-code': {
    dir: () => '.roo/commands/',
    extension: '.md',
    transformFrontmatter: keepDescriptionAddMode,
  },
  codex: {
    dir: (commandName) => `.codex/skills/${commandName}/`,
    extension: '.md',
    transformFrontmatter: keepDescription,
  },
};

/**
 * Adapt a command file for a specific agent.
 *
 * Applies the agent's frontmatter transform and returns the target
 * filename, directory, and rebuilt file content.
 *
 * @param {string} agentName - Agent slug (e.g. 'cursor', 'claude-code')
 * @param {Record<string, unknown>} frontmatter - Parsed frontmatter object
 * @param {string} body - Markdown body content (after frontmatter)
 * @param {string} commandName - Command name (e.g. 'plan', 'dev', 'status')
 * @returns {{ content: string, filename: string, dir: string } | null}
 *   null if the agent is skipped (canonical source)
 * @throws {Error} If agentName is not a known agent
 */
function adaptForAgent(agentName, frontmatter, body, commandName) {
  const adapter = AGENT_ADAPTERS[agentName];
  if (!adapter) {
    throw new Error(`Unknown agent: "${agentName}". Known agents: ${Object.keys(AGENT_ADAPTERS).join(', ')}`);
  }

  if (adapter.skip) {
    return null;
  }

  const transformed = adapter.transformFrontmatter(frontmatter, commandName);
  const hasKeys = Object.keys(transformed).length > 0;

  // Build content: if frontmatter is empty, output body only (no --- markers)
  const content = hasKeys ? buildFile(transformed, body) : body;

  // Determine filename — Codex uses SKILL.md, others use <commandName>.<ext>
  let filename;
  if (agentName === 'codex') {
    filename = `SKILL${adapter.extension}`;
  } else {
    filename = `${commandName}${adapter.extension}`;
  }

  return {
    content,
    filename,
    dir: adapter.dir(commandName),
  };
}

module.exports = { parseFrontmatter, buildFile, AGENT_ADAPTERS, adaptForAgent };
