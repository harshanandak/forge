const { describe, test, expect, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const setup = require('../lib/commands/setup');

// The Cursor MCP config is now AUTO-WIRED by setup (mirrors Claude), delivering the
// matrix's (mcp, cursor) = native '.cursor/mcp.json' claim. Cursor reads a
// project-local .cursor/mcp.json, so this is a real native delivery.

describe('Cursor MCP is auto-wired (native .cursor/mcp.json)', () => {
  const created = [];
  function tmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cursor-mcp-'));
    created.push(d);
    return d;
  }
  afterEach(() => {
    while (created.length) fs.rmSync(created.pop(), { recursive: true, force: true });
  });

  test('fresh project: writes .cursor/mcp.json with Context7', () => {
    const root = tmp();
    setup._setState({ projectRoot: root });
    setup.setupCursorMcpConfig();

    const p = path.join(root, '.cursor', 'mcp.json');
    expect(fs.existsSync(p)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
    expect(cfg.mcpServers.context7).toBeDefined();
    expect(cfg.mcpServers.context7.command).toBe('npx');
  });

  test('existing config: merges Context7 and PRESERVES the user\'s servers', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { myserver: { command: 'node', args: ['x.js'] } } }, null, 2),
    );

    setup._setState({ projectRoot: root });
    setup.setupCursorMcpConfig();

    const cfg = JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'mcp.json'), 'utf-8'));
    expect(cfg.mcpServers.myserver).toBeDefined(); // preserved
    expect(cfg.mcpServers.context7).toBeDefined(); // added
  });

  test('malformed config is NOT clobbered (data-loss guard carries through)', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '.cursor'), { recursive: true });
    const original = '{\n  // jsonc\n  "mcpServers": { "a": { "command": "x" } },\n}\n';
    fs.writeFileSync(path.join(root, '.cursor', 'mcp.json'), original);

    setup._setState({ projectRoot: root });
    setup.setupCursorMcpConfig();

    expect(fs.readFileSync(path.join(root, '.cursor', 'mcp.json'), 'utf-8')).toBe(original);
    expect(fs.existsSync(path.join(root, '.cursor', 'mcp.json.bak'))).toBe(true);
  });
});
