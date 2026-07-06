'use strict';

/**
 * @module memory/graphiti-mcp
 *
 * DATA-ONLY descriptor for the `graphiti-memory` MCP server. This module does
 * NOT write any file — it defines the harness-agnostic server descriptor shape
 * so a per-harness MCP renderer (a fast-follow PR) can materialize it into the
 * right place for each agent (Claude `.mcp.json`, Cursor `.cursor/mcp.json`,
 * Codex `config.toml`, ...). Forge never speaks to Graphiti at runtime; agents
 * do, over MCP.
 *
 * LOCKED interface (consumed by the parity agent's MCP renderer):
 *   { name, transport: 'stdio'|'http', command, args, envRefs }
 * `envRefs` values are ALWAYS `${VAR}` reference strings — never literal keys or
 * secrets — because each harness expands them differently and nothing sensitive
 * may be baked into committed config.
 *
 * Design: docs/work/2026-07-06-graphiti-memory/research.md §1.7 / §2.2. The entry
 * shape matches the Graphiti MCP server README (stdio transport, `uv run`).
 */

/** Documented recommended defaults for a fresh opt-in (FalkorDB + OpenAI-compatible). */
const DEFAULTS = Object.freeze({
  transport: 'stdio', // 'stdio' | 'http'
  command: 'uv',
  mcpServerPath: './graphiti/mcp_server',
  graphDb: 'falkordb', // 'falkordb' | 'falkordb-lite' | 'neo4j'
  dbUri: 'redis://localhost:6379', // documented default for the FalkorDB path
  neo4jUri: 'bolt://localhost:7687',
  llmProvider: 'openai',
  model: 'gpt-5.5',
  apiKeyEnv: 'OPENAI_API_KEY',
  groupId: 'forge',
});

const SERVER_NAME = 'graphiti-memory';

/** Build a `${VAR}` reference string. */
function ref(name) {
  return `\${${name}}`;
}

/**
 * Build the harness-agnostic Graphiti MCP server descriptor.
 *
 * @param {object} [config] - Partial override of DEFAULTS (graphDb, apiKeyEnv,
 *   mcpServerPath, transport, ...). Concrete secret/URI VALUES are never placed
 *   here — only which env vars the server needs, as `${VAR}` references.
 * @returns {{ name: string, transport: string, command: string, args: string[], envRefs: Object<string,string> }}
 */
function buildGraphitiServerDescriptor(config = {}) {
  const c = { ...DEFAULTS, ...config };

  const args = [
    'run',
    '--isolated',
    '--directory',
    c.mcpServerPath,
    '--project',
    '.',
    'main.py',
    '--transport',
    c.transport,
  ];

  const envRefs = {};
  if (c.graphDb === 'neo4j') {
    envRefs.NEO4J_URI = ref('NEO4J_URI');
    envRefs.NEO4J_USER = ref('NEO4J_USER');
    envRefs.NEO4J_PASSWORD = ref('NEO4J_PASSWORD');
  } else {
    envRefs.FALKORDB_URI = ref('FALKORDB_URI');
  }
  // LLM key referenced by env-var NAME only — never inlined.
  envRefs[c.apiKeyEnv] = ref(c.apiKeyEnv);
  envRefs.MODEL_NAME = ref('MODEL_NAME');
  envRefs.GROUP_ID = ref('GRAPHITI_GROUP_ID');

  return {
    name: SERVER_NAME,
    transport: c.transport,
    command: c.command,
    args,
    envRefs,
  };
}

module.exports = {
  DEFAULTS,
  SERVER_NAME,
  buildGraphitiServerDescriptor,
};
