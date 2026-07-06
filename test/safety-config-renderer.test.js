const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CLAUDE_PERMISSION_DEFAULTS,
  CURSORIGNORE_DEFAULTS,
  mergeClaudePermissions,
  mergeCursorIgnore,
  renderClaudePermissions,
  renderCursorIgnore,
  SafetyConfigParseError,
} = require('../lib/safety-config-renderer');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-safety-'));
}

describe('safety renderer — Claude permissions defaults', () => {
  test('defaults are safe: allow dev workflow, deny destructive + secret reads', () => {
    const { allow, deny, ask } = CLAUDE_PERMISSION_DEFAULTS;
    // allows the routine forge/dev workflow
    expect(allow.some(r => /^Bash\(git status/.test(r))).toBe(true);
    expect(allow.some(r => /^Bash\(git commit/.test(r))).toBe(true);
    // denies obviously-dangerous operations
    expect(deny.some(r => /rm -rf/.test(r))).toBe(true);
    expect(deny.some(r => /git push --force|push -f/.test(r))).toBe(true);
    // read boundary: secrets are never readable by the agent
    expect(deny.some(r => /^Read\(.*\.env/.test(r))).toBe(true);
    // careful operations fall to ask
    expect(ask.some(r => /git reset|git rebase/.test(r))).toBe(true);
  });

  test('fresh: writes a valid .claude/settings.json permissions block', () => {
    const root = tmp();
    try {
      const res = renderClaudePermissions({ targetRoot: root });
      expect(res.existed).toBe(false);
      expect(res.skipped).toBe(false);
      const p = path.join(root, '.claude', 'settings.json');
      const cfg = JSON.parse(fs.readFileSync(p, 'utf-8')); // valid JSON
      expect(Array.isArray(cfg.permissions.allow)).toBe(true);
      expect(cfg.permissions.allow.length).toBeGreaterThan(0);
      expect(cfg.permissions.deny.some(r => /rm -rf/.test(r))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('merge PRESERVES existing settings keys and user allow/deny entries (union, no dupes)', () => {
    const existing = JSON.stringify({
      model: 'opus',
      permissions: {
        allow: ['Bash(mytool:*)', 'Bash(git status:*)'],
        deny: ['Bash(secretcmd:*)'],
      },
    }, null, 2);
    const merged = JSON.parse(mergeClaudePermissions(existing));
    // unrelated user key preserved
    expect(merged.model).toBe('opus');
    // user's custom entries preserved
    expect(merged.permissions.allow).toContain('Bash(mytool:*)');
    expect(merged.permissions.deny).toContain('Bash(secretcmd:*)');
    // forge defaults added
    expect(merged.permissions.deny.some(r => /rm -rf/.test(r))).toBe(true);
    // no duplicate of the shared entry
    const gitStatus = merged.permissions.allow.filter(r => r === 'Bash(git status:*)');
    expect(gitStatus.length).toBe(1);
  });

  test('idempotent: merging twice yields identical output', () => {
    const once = mergeClaudePermissions('');
    const twice = mergeClaudePermissions(once);
    expect(twice).toBe(once);
  });

  test('unparseable settings.json is BACKED UP and left untouched (data-loss guard)', () => {
    const root = tmp();
    try {
      const dir = path.join(root, '.claude');
      fs.mkdirSync(dir, { recursive: true });
      const original = '{\n  // jsonc comment\n  "model": "opus",\n}\n';
      const p = path.join(dir, 'settings.json');
      fs.writeFileSync(p, original);
      const res = renderClaudePermissions({ targetRoot: root });
      expect(res.skipped).toBe(true);
      expect(fs.readFileSync(p, 'utf-8')).toBe(original); // untouched
      expect(res.backup && fs.existsSync(res.backup)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('mergeClaudePermissions throws SafetyConfigParseError on populated unparseable input', () => {
    expect(() => mergeClaudePermissions('{ not json,,, }')).toThrow(SafetyConfigParseError);
  });
});

describe('safety renderer — .cursorignore defaults', () => {
  test('defaults ignore secrets, env, node_modules, and build artifacts', () => {
    const text = CURSORIGNORE_DEFAULTS.join('\n');
    expect(text).toMatch(/\.env/);
    expect(text).toMatch(/node_modules/);
    expect(/dist|build|out|coverage/.test(text)).toBe(true);
    expect(/\*\.pem|\*\.key|secrets/.test(text)).toBe(true);
  });

  test('fresh: writes .cursorignore with safe defaults', () => {
    const root = tmp();
    try {
      const res = renderCursorIgnore({ targetRoot: root });
      expect(res.existed).toBe(false);
      const body = fs.readFileSync(path.join(root, '.cursorignore'), 'utf-8');
      expect(body).toMatch(/\.env/);
      expect(body).toMatch(/node_modules/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('merge PRESERVES user lines and only appends missing defaults', () => {
    const existing = '# my rules\nmy-private-dir/\n.env\n';
    const merged = mergeCursorIgnore(existing);
    // user content preserved verbatim
    expect(merged).toContain('# my rules');
    expect(merged).toContain('my-private-dir/');
    // pre-existing default not duplicated
    expect(merged.split('\n').filter(l => l.trim() === '.env').length).toBe(1);
    // a missing default was appended
    expect(merged).toMatch(/node_modules/);
  });

  test('idempotent: merging twice yields identical output', () => {
    const once = mergeCursorIgnore('');
    const twice = mergeCursorIgnore(once);
    expect(twice).toBe(once);
  });
});
