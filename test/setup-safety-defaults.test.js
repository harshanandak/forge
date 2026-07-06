const { describe, test, expect, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const setup = require('../lib/commands/setup');

// Native SAFETY surfaces are auto-wired by `forge setup` (mirrors the MCP renderer):
//   Claude -> .claude/settings.json permissions (safe defaults)
//   Cursor -> .cursorignore (AI read/index boundary)
// Defaults are ON but opt-out-able via FORGE_SKIP_SAFETY_DEFAULTS.

describe('forge setup renders native safety defaults', () => {
  const created = [];
  function tmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-safety-setup-'));
    created.push(d);
    return d;
  }
  afterEach(() => {
    delete process.env.FORGE_SKIP_SAFETY_DEFAULTS;
    while (created.length) fs.rmSync(created.pop(), { recursive: true, force: true });
  });

  test('fresh Claude: writes a valid .claude/settings.json permissions block', () => {
    const root = tmp();
    setup._setState({ projectRoot: root });
    setup.setupClaudePermissions();

    const p = path.join(root, '.claude', 'settings.json');
    expect(fs.existsSync(p)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
    expect(cfg.permissions.allow.some(r => /git status/.test(r))).toBe(true);
    expect(cfg.permissions.deny.some(r => /rm -rf/.test(r))).toBe(true);
    expect(cfg.permissions.deny.some(r => /\.env/.test(r))).toBe(true);
    // Non-surprising: we do NOT silently auto-approve everything.
    expect(cfg.permissions.defaultMode).toBeUndefined();
  });

  test('fresh Cursor: writes .cursorignore with safe defaults', () => {
    const root = tmp();
    setup._setState({ projectRoot: root });
    setup.setupCursorIgnore();

    const body = fs.readFileSync(path.join(root, '.cursorignore'), 'utf-8');
    expect(body).toMatch(/\.env/);
    expect(body).toMatch(/node_modules/);
  });

  test('existing settings.json: preserves user keys and entries', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude', 'settings.json'),
      JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(mytool:*)'] } }, null, 2),
    );
    setup._setState({ projectRoot: root });
    setup.setupClaudePermissions();

    const cfg = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf-8'));
    expect(cfg.model).toBe('opus'); // preserved
    expect(cfg.permissions.allow).toContain('Bash(mytool:*)'); // preserved
    expect(cfg.permissions.deny.some(r => /rm -rf/.test(r))).toBe(true); // added
  });

  test('existing .cursorignore: preserves user lines, appends missing defaults', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, '.cursorignore'), '# mine\nmy-secret-dir/\n');
    setup._setState({ projectRoot: root });
    setup.setupCursorIgnore();

    const body = fs.readFileSync(path.join(root, '.cursorignore'), 'utf-8');
    expect(body).toContain('my-secret-dir/'); // preserved
    expect(body).toMatch(/node_modules/); // appended
  });

  test('opt-out: FORGE_SKIP_SAFETY_DEFAULTS leaves both surfaces untouched', () => {
    const root = tmp();
    process.env.FORGE_SKIP_SAFETY_DEFAULTS = '1';
    setup._setState({ projectRoot: root });
    setup.setupClaudePermissions();
    setup.setupCursorIgnore();

    expect(fs.existsSync(path.join(root, '.claude', 'settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.cursorignore'))).toBe(false);
  });

  test('malformed settings.json is backed up, not clobbered (data-loss guard)', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    const original = '{\n  // jsonc\n  "model": "opus",\n}\n';
    const p = path.join(root, '.claude', 'settings.json');
    fs.writeFileSync(p, original);

    setup._setState({ projectRoot: root });
    setup.setupClaudePermissions();

    expect(fs.readFileSync(p, 'utf-8')).toBe(original); // untouched
    expect(fs.existsSync(`${p}.bak`)).toBe(true);
  });
});
