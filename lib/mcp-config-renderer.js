'use strict';

/**
 * Per-harness MCP config renderer.
 *
 * Renders a GENERIC MCP server descriptor into each harness's native MCP config,
 * using read → merge → write (idempotent, preserves user/other servers). This
 * replaces the old skip-if-exists behavior in setup, which silently refused to
 * add a server whenever a config file already existed.
 *
 * Frozen descriptor interface (consumers build this shape; this module never
 * references any specific server):
 *
 *   {
 *     name: string,                       // server key
 *     transport: 'stdio' | 'http',        // launch transport
 *     command: string,                    // executable (stdio) / launcher
 *     args: string[],                     // command arguments
 *     envRefs: Record<string, string>,    // env var REFERENCES ('${VAR}') — never secrets
 *   }
 *
 * `envRefs` values MUST be `${VAR}` reference strings; literal secrets are rejected.
 * Each harness expands them per its own semantics:
 *
 *   - Claude : `.mcp.json`            (JSON `mcpServers` map)
 *   - Cursor : `.cursor/mcp.json`     (JSON `mcpServers` map)
 *   - Codex  : `.codex/config.toml`   (TOML `[mcp_servers.<name>]` tables)
 *
 * Dependency-free (no TOML lib) so it runs under `bun test` and the release gates.
 *
 * @module mcp-config-renderer
 */

const fs = require('node:fs');
const path = require('node:path');

const HARNESS_MCP_FILES = {
  claude: '.mcp.json',
  cursor: '.cursor/mcp.json',
  codex: '.codex/config.toml',
};

const ENV_REF_PATTERN = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/** Thrown when an existing config file cannot be parsed — signals "do not overwrite". */
class McpConfigParseError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'McpConfigParseError';
    this.cause = cause;
  }
}

/**
 * Validate + normalize a generic MCP server descriptor.
 * @param {object} d
 * @returns {{ name, transport, command, args, url, envRefs }}
 */
function validateDescriptor(d) {
  if (!d || typeof d !== 'object') {
    throw new Error('MCP descriptor must be an object');
  }
  if (!d.name || typeof d.name !== 'string') {
    throw new Error('MCP descriptor.name is required');
  }
  const transport = d.transport || 'stdio';
  if (transport !== 'stdio' && transport !== 'http') {
    throw new Error(`MCP descriptor.transport must be 'stdio' or 'http' (got ${transport})`);
  }
  const command = typeof d.command === 'string' ? d.command : '';
  const args = Array.isArray(d.args) ? d.args.map(String) : [];
  const url = typeof d.url === 'string' ? d.url : '';
  // stdio launches a process (command/args); http connects to a url. Enforce the
  // field each transport needs so the frozen descriptor can represent both.
  if (transport === 'http' && !url) {
    throw new Error("MCP descriptor.url is required for transport 'http'");
  }
  if (transport === 'stdio' && !command) {
    throw new Error("MCP descriptor.command is required for transport 'stdio'");
  }
  const envRefs = d.envRefs && typeof d.envRefs === 'object' ? d.envRefs : {};
  for (const [key, value] of Object.entries(envRefs)) {
    if (typeof value !== 'string' || !ENV_REF_PATTERN.test(value)) {
      throw new Error(
        `MCP descriptor.envRefs.${key} must be a '\${VAR}' reference string, not a literal value`,
      );
    }
  }
  return { name: d.name, transport, command, args, url, envRefs };
}

/** Build the JSON server entry (Claude + Cursor share the `mcpServers` schema). */
function toJsonServerEntry(descriptor) {
  const d = validateDescriptor(descriptor);
  const entry = {};
  if (d.transport === 'http') {
    entry.type = 'http';
    entry.url = d.url;
  } else {
    if (d.command) entry.command = d.command;
    if (d.args.length) entry.args = d.args;
  }
  if (Object.keys(d.envRefs).length) entry.env = { ...d.envRefs };
  return entry;
}

/**
 * Merge descriptors into an existing JSON MCP config string (read → merge → write).
 * Preserves every server not named in `descriptors`.
 * @param {string} existingText
 * @param {object[]} descriptors
 * @returns {string}
 */
function mergeJsonMcp(existingText, descriptors) {
  let obj = {};
  if (existingText && existingText.trim()) {
    try {
      obj = JSON.parse(existingText);
    } catch (err) {
      // DATA-LOSS GUARD: never silently discard a populated-but-unparseable config
      // (e.g. Cursor JSONC with comments/trailing commas). Signal the caller so it
      // can back up and skip instead of overwriting the user's servers.
      throw new McpConfigParseError('existing MCP config is not valid JSON', err);
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) obj = {};
  if (!obj.mcpServers || typeof obj.mcpServers !== 'object') obj.mcpServers = {};
  for (const descriptor of descriptors) {
    const d = validateDescriptor(descriptor);
    obj.mcpServers[d.name] = toJsonServerEntry(d);
  }
  return JSON.stringify(obj, null, 2) + '\n';
}

function tomlString(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function tomlArray(values) {
  return '[' + values.map(tomlString).join(', ') + ']';
}

/** Render a single Codex `[mcp_servers.<name>]` TOML block (+ optional env table). */
function renderCodexServerBlock(descriptor) {
  const d = validateDescriptor(descriptor);
  const lines = [`[mcp_servers.${d.name}]`];
  if (d.transport === 'http') {
    lines.push(`url = ${tomlString(d.url)}`);
    lines.push('transport = "http"');
  } else {
    if (d.command) lines.push(`command = ${tomlString(d.command)}`);
    lines.push(`args = ${tomlArray(d.args)}`);
  }
  let block = lines.join('\n') + '\n';
  const envKeys = Object.keys(d.envRefs);
  if (envKeys.length) {
    block += `\n[mcp_servers.${d.name}.env]\n`;
    for (const key of envKeys) {
      block += `${key} = ${tomlString(d.envRefs[key])}\n`;
    }
  }
  return block;
}

/** Remove a TOML section (header line through the line before the next `[section]`). */
function stripTomlSection(text, header) {
  const lines = String(text).split('\n');
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const isHeader = line.trimStart().startsWith('[');
    if (isHeader) {
      if (line.trim() === header) {
        skipping = true;
        continue;
      }
      skipping = false;
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

/**
 * Merge descriptors into an existing Codex `config.toml` string (read → merge →
 * write). Only the targeted `[mcp_servers.<name>]` (+ `.env`) sections are
 * replaced; all other config is preserved. Idempotent.
 * @param {string} existingText
 * @param {object[]} descriptors
 * @returns {string}
 */
function mergeCodexToml(existingText, descriptors) {
  let text = existingText || '';
  for (const descriptor of descriptors) {
    const d = validateDescriptor(descriptor);
    text = stripTomlSection(text, `[mcp_servers.${d.name}]`);
    text = stripTomlSection(text, `[mcp_servers.${d.name}.env]`);
  }
  const preamble = text.replace(/\s+$/, '');
  let result = preamble ? preamble + '\n\n' : '';
  result += descriptors.map(renderCodexServerBlock).join('\n');
  return result.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
}

/**
 * Copy `filePath` to a stable `<file>.bak` (then numbered `.bak.1`, `.2`, …) so a
 * repeated back-up never clobbers an earlier snapshot. Mirrors the AGENTS.md
 * markerless-backup behavior in lib/commands/setup.js.
 * @param {string} filePath
 * @returns {string} the backup path written
 */
function backupFile(filePath) {
  let backupPath = `${filePath}.bak`;
  if (fs.existsSync(backupPath)) {
    let suffix = 1;
    while (fs.existsSync(`${filePath}.bak.${suffix}`)) suffix += 1;
    backupPath = `${filePath}.bak.${suffix}`;
  }
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

/**
 * Render (merge) MCP descriptors into one harness's native config on disk.
 * Read → merge → write. If the existing file cannot be parsed, it is BACKED UP and
 * left untouched (never overwritten) to avoid destroying user-defined servers.
 *
 * @param {object} params
 * @param {'claude'|'cursor'|'codex'} params.harness
 * @param {string} params.targetRoot - Project root.
 * @param {object[]} params.descriptors - Generic MCP server descriptors.
 * @returns {{ file: string, existed: boolean, skipped: boolean, backup?: string }}
 */
function renderMcpConfig({ harness, targetRoot, descriptors }) {
  const rel = HARNESS_MCP_FILES[harness];
  if (!rel) throw new Error(`Unknown MCP harness: ${harness}`);
  const filePath = path.join(targetRoot, rel);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const existed = fs.existsSync(filePath);
  const existing = existed ? fs.readFileSync(filePath, 'utf-8') : '';

  let merged;
  try {
    merged = harness === 'codex'
      ? mergeCodexToml(existing, descriptors)
      : mergeJsonMcp(existing, descriptors);
  } catch (err) {
    if (err instanceof McpConfigParseError && existed) {
      const backup = backupFile(filePath);
      console.warn(
        `  ⚠ ${rel} is not valid JSON (comments/trailing commas?) — left untouched to ` +
        `avoid data loss. Backed up to ${path.basename(backup)}; add the MCP server manually.`,
      );
      return { file: filePath, existed, skipped: true, backup };
    }
    throw err;
  }

  fs.writeFileSync(filePath, merged, 'utf-8');
  return { file: filePath, existed, skipped: false };
}

module.exports = {
  HARNESS_MCP_FILES,
  McpConfigParseError,
  validateDescriptor,
  toJsonServerEntry,
  mergeJsonMcp,
  renderCodexServerBlock,
  mergeCodexToml,
  stripTomlSection,
  backupFile,
  renderMcpConfig,
};
