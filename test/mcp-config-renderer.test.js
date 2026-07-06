const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  validateDescriptor,
  toJsonServerEntry,
  mergeJsonMcp,
  mergeCodexToml,
  renderMcpConfig,
} = require('../lib/mcp-config-renderer');

// The frozen generic descriptor shape the memory feature will supply.
const descriptor = {
  name: 'demo-memory',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@example/demo-mcp@latest'],
  envRefs: { DEMO_API_KEY: '${DEMO_API_KEY}' },
};

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mcp-'));
}

describe('mcp config renderer — generic descriptor contract', () => {
  test('rejects literal secrets in envRefs (references only)', () => {
    expect(() =>
      validateDescriptor({ ...descriptor, envRefs: { DEMO_API_KEY: 'sk-live-abc123' } }),
    ).toThrow(/reference string/);
  });

  test('accepts the locked descriptor shape', () => {
    const d = validateDescriptor(descriptor);
    expect(d.name).toBe('demo-memory');
    expect(d.transport).toBe('stdio');
    expect(d.args).toEqual(['-y', '@example/demo-mcp@latest']);
    expect(d.envRefs.DEMO_API_KEY).toBe('${DEMO_API_KEY}');
  });

  test('Claude .mcp.json: merge preserves pre-existing servers, writes env refs', () => {
    const root = tmp();
    try {
      // Pre-existing user config with an unrelated server.
      fs.writeFileSync(
        path.join(root, '.mcp.json'),
        JSON.stringify({ mcpServers: { context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp@latest'] } } }, null, 2),
      );
      renderMcpConfig({ harness: 'claude', targetRoot: root, descriptors: [descriptor] });
      const cfg = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf-8'));
      expect(cfg.mcpServers.context7).toBeDefined(); // preserved
      expect(cfg.mcpServers['demo-memory'].command).toBe('npx');
      expect(cfg.mcpServers['demo-memory'].env.DEMO_API_KEY).toBe('${DEMO_API_KEY}');
      // env ref, not a literal secret
      expect(fs.readFileSync(path.join(root, '.mcp.json'), 'utf-8')).not.toContain('sk-');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('Cursor .cursor/mcp.json: created under .cursor and merges', () => {
    const root = tmp();
    try {
      const { file } = renderMcpConfig({ harness: 'cursor', targetRoot: root, descriptors: [descriptor] });
      expect(file.endsWith(path.join('.cursor', 'mcp.json'))).toBe(true);
      const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(cfg.mcpServers['demo-memory'].args).toEqual(['-y', '@example/demo-mcp@latest']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('Codex config.toml: merge preserves other config + appends server table', () => {
    const root = tmp();
    try {
      fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
      fs.writeFileSync(
        path.join(root, '.codex/config.toml'),
        'model = "gpt-5"\n\n[mcp_servers.existing]\ncommand = "foo"\nargs = []\n',
      );
      renderMcpConfig({ harness: 'codex', targetRoot: root, descriptors: [descriptor] });
      const toml = fs.readFileSync(path.join(root, '.codex/config.toml'), 'utf-8');
      expect(toml).toContain('model = "gpt-5"'); // preserved
      expect(toml).toContain('[mcp_servers.existing]'); // preserved
      expect(toml).toContain('[mcp_servers.demo-memory]');
      expect(toml).toContain('[mcp_servers.demo-memory.env]');
      expect(toml).toContain('DEMO_API_KEY = "${DEMO_API_KEY}"');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('all three renderers are idempotent (render twice = same bytes)', () => {
    for (const harness of ['claude', 'cursor', 'codex']) {
      const root = tmp();
      try {
        renderMcpConfig({ harness, targetRoot: root, descriptors: [descriptor] });
        const file = renderMcpConfig({ harness, targetRoot: root, descriptors: [descriptor] }).file;
        const once = fs.readFileSync(file, 'utf-8');
        renderMcpConfig({ harness, targetRoot: root, descriptors: [descriptor] });
        expect(fs.readFileSync(file, 'utf-8')).toBe(once);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('merge helpers upsert by name (no duplicate entries)', () => {
    const json = mergeJsonMcp(mergeJsonMcp('', [descriptor]), [descriptor]);
    expect(Object.keys(JSON.parse(json).mcpServers)).toEqual(['demo-memory']);
    const toml = mergeCodexToml(mergeCodexToml('', [descriptor]), [descriptor]);
    expect((toml.match(/\[mcp_servers\.demo-memory\]/g) || []).length).toBe(1);
  });

  // ── C2: never clobber an unparseable-but-populated config (data loss) ────────
  test('C2: malformed JSONC with custom servers is NOT wiped — backed up + skipped', () => {
    const root = tmp();
    try {
      // JSONC that Cursor tolerates but JSON.parse rejects (trailing comma + comment)
      const original =
        '{\n  // my servers\n  "mcpServers": {\n    "my-server": { "command": "node", "args": ["x.js"] },\n  }\n}\n';
      const p = path.join(root, '.mcp.json');
      fs.writeFileSync(p, original);

      const result = renderMcpConfig({ harness: 'claude', targetRoot: root, descriptors: [descriptor] });

      // Original file must be untouched (custom server preserved, context7 NOT force-added)
      expect(fs.readFileSync(p, 'utf-8')).toBe(original);
      expect(result.skipped).toBe(true);
      // A backup copy exists
      expect(fs.existsSync(path.join(root, '.mcp.json.bak'))).toBe(true);
      expect(fs.readFileSync(path.join(root, '.mcp.json.bak'), 'utf-8')).toBe(original);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('C2: mergeJsonMcp throws (does not silently discard) on unparseable non-empty input', () => {
    expect(() => mergeJsonMcp('{ "mcpServers": { "a": {} }, }', [descriptor])).toThrow();
    // empty/whitespace still starts fresh (no throw)
    expect(() => mergeJsonMcp('   ', [descriptor])).not.toThrow();
  });

  // ── P1: http transport must carry a url ──────────────────────────────────────
  test('P1: http descriptor renders {type:http, url} in JSON and url in Codex TOML', () => {
    const http = { name: 'remote', transport: 'http', url: 'https://mcp.example.com/sse', envRefs: {} };
    const entry = toJsonServerEntry(http);
    expect(entry.type).toBe('http');
    expect(entry.url).toBe('https://mcp.example.com/sse');
    expect(entry.command).toBeUndefined();

    const root = tmp();
    try {
      renderMcpConfig({ harness: 'codex', targetRoot: root, descriptors: [http] });
      const toml = fs.readFileSync(path.join(root, '.codex/config.toml'), 'utf-8');
      expect(toml).toContain('url = "https://mcp.example.com/sse"');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('P1: http descriptor without url is rejected', () => {
    expect(() => validateDescriptor({ name: 'x', transport: 'http', envRefs: {} })).toThrow(/url/i);
  });
});
