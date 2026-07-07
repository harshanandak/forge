const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const setup = require('../lib/commands/setup');

// When the memory backend resolves to `graphiti` (same precedence the memory
// router uses: deps > FORGE_MEMORY_BACKEND > .forge/config.yaml) AND the config
// passes the same strict validity check `forge doctor` uses, `forge setup` wires
// the graphiti-memory MCP server into BOTH .mcp.json (Claude) and
// .cursor/mcp.json (Cursor). Local backend (the default) stays byte-identical
// to the Context7-only render; an invalid graphiti config skips with a notice
// and never crashes setup.

describe('setup wires the Graphiti memory MCP server (opt-in)', () => {
  const created = [];
  let savedEnv;

  function tmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-graphiti-mcp-'));
    created.push(d);
    return d;
  }

  function writeConfig(root, yaml) {
    fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
    fs.writeFileSync(path.join(root, '.forge', 'config.yaml'), yaml);
  }

  function readJson(root, rel) {
    return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf-8'));
  }

  beforeEach(() => {
    // Isolate from any ambient backend override — config.yaml drives these tests.
    savedEnv = process.env.FORGE_MEMORY_BACKEND;
    delete process.env.FORGE_MEMORY_BACKEND;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.FORGE_MEMORY_BACKEND;
    else process.env.FORGE_MEMORY_BACKEND = savedEnv;
    while (created.length) fs.rmSync(created.pop(), { recursive: true, force: true });
  });

  test('backend=graphiti + valid config: descriptor rendered for Claude AND Cursor', () => {
    const root = tmp();
    writeConfig(root, [
      'memory:',
      '  backend: graphiti',
      '  graphiti:',
      '    mcpServerPath: ./graphiti/mcp_server',
    ].join('\n'));

    setup._setState({ projectRoot: root });
    setup.setupClaudeMcpConfig();
    setup.setupCursorMcpConfig();

    for (const rel of ['.mcp.json', path.join('.cursor', 'mcp.json')]) {
      const cfg = readJson(root, rel);
      expect(cfg.mcpServers.context7).toBeDefined();
      const graphiti = cfg.mcpServers['graphiti-memory'];
      expect(graphiti).toBeDefined();
      expect(graphiti.command).toBe('uv');
      expect(graphiti.args).toContain('./graphiti/mcp_server');
      // envRefs stay ${VAR} references — never literal secrets.
      expect(graphiti.env.OPENAI_API_KEY).toBe('${OPENAI_API_KEY}');
    }
  });

  test('local backend (default, no config): byte-identical to the Context7-only render', () => {
    const root = tmp();
    setup._setState({ projectRoot: root });
    setup.setupClaudeMcpConfig();

    const withDefault = fs.readFileSync(path.join(root, '.mcp.json'), 'utf-8');
    const cfg = JSON.parse(withDefault);
    expect(Object.keys(cfg.mcpServers)).toEqual(['context7']);

    // Re-render from scratch with only Context7 through the renderer: identical bytes.
    const { renderMcpConfig } = require('../lib/mcp-config-renderer');
    const ref = tmp();
    renderMcpConfig({
      harness: 'claude',
      targetRoot: ref,
      descriptors: [{
        name: 'context7',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp@latest'],
        envRefs: {},
      }],
    });
    expect(withDefault).toBe(fs.readFileSync(path.join(ref, '.mcp.json'), 'utf-8'));
  });

  test('backend=graphiti but INVALID (no mcpServerPath): notice, no crash, no descriptor', () => {
    const root = tmp();
    writeConfig(root, 'memory:\n  backend: graphiti\n');

    const logs = [];
    const origLog = console.log;
    console.log = (...a) => logs.push(a.join(' '));
    try {
      setup._setState({ projectRoot: root });
      setup.setupClaudeMcpConfig(); // must not throw
    } finally {
      console.log = origLog;
    }

    const cfg = readJson(root, '.mcp.json');
    expect(cfg.mcpServers.context7).toBeDefined();
    expect(cfg.mcpServers['graphiti-memory']).toBeUndefined();
    expect(logs.some((l) => /graphiti/i.test(l) && /doctor/i.test(l))).toBe(true);
  });

  test('existing user servers are preserved when the graphiti descriptor merges in', () => {
    const root = tmp();
    writeConfig(root, [
      'memory:',
      '  backend: graphiti',
      '  graphiti:',
      '    mcpServerPath: ./graphiti/mcp_server',
    ].join('\n'));
    fs.writeFileSync(
      path.join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { myserver: { command: 'node', args: ['x.js'] } } }, null, 2),
    );

    setup._setState({ projectRoot: root });
    setup.setupClaudeMcpConfig();

    const cfg = readJson(root, '.mcp.json');
    expect(cfg.mcpServers.myserver).toBeDefined(); // preserved
    expect(cfg.mcpServers.context7).toBeDefined(); // added
    expect(cfg.mcpServers['graphiti-memory']).toBeDefined(); // added
  });
});
