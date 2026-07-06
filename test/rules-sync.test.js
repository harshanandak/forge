const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CURSOR_RULE_FILES,
  CANONICAL_RULE_NAMES,
  listCanonicalRules,
  renderCursorRule,
  renderCursorRuleMap,
  renderRulesForHarness,
  checkRulesRenderDeterminism,
} = require('../lib/rules-sync');

const repoRoot = path.resolve(__dirname, '..');

// ─── rule drift detection (one canonical source → Cursor native rule surface) ──
//
// Canonical policy rules live in `rules/` as THIN POINTERS. Only Cursor has a
// first-class native rule surface, so only `.cursor/rules/*.mdc` is rendered.
// Instead of committing mirrors (which would fight the gitignored setup-dir
// design and bloat the repo), the gate regenerates into a temp dir and asserts
// the render is deterministic + well-formed. Claude/Codex/Hermes get the same
// policy through their AGENTS.md instruction projection — NOT always-on rule
// files, which would triple-deliver the policy as token bloat.

describe('rules sync drift detection', () => {
  test('Cursor rule render is deterministic and well-formed', () => {
    const result = checkRulesRenderDeterminism({ sourceRoot: repoRoot });
    if (!result.ok) {
      throw new Error(`Rule render issues:\n${JSON.stringify(result.issues, null, 2)}`);
    }
    expect(result.issues).toHaveLength(0);
  });

  test('canonical source defines the four policy rules', () => {
    expect(CANONICAL_RULE_NAMES).toEqual(['workflow', 'tdd', 'security', 'documentation']);
    const rules = listCanonicalRules(repoRoot);
    expect(rules.map((r) => r.name).sort()).toEqual(
      ['documentation', 'security', 'tdd', 'workflow'],
    );
  });

  test('regenerate-into-temp is byte-identical across runs (drift-free)', () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rules-a-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rules-b-'));
    try {
      renderRulesForHarness({ sourceRoot: repoRoot, targetRoot: a, overwrite: true });
      renderRulesForHarness({ sourceRoot: repoRoot, targetRoot: b, overwrite: true });
      for (const file of Object.values(CURSOR_RULE_FILES)) {
        const fa = path.join(a, '.cursor/rules', file);
        const fb = path.join(b, '.cursor/rules', file);
        expect(fs.existsSync(fa)).toBe(true);
        expect(fs.readFileSync(fa, 'utf-8')).toBe(fs.readFileSync(fb, 'utf-8'));
      }
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  test('only Cursor has a native rule renderer (Claude/Codex/Hermes use AGENTS.md)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rules-'));
    try {
      for (const harness of ['claude', 'codex', 'hermes']) {
        expect(() =>
          renderRulesForHarness({ sourceRoot: repoRoot, targetRoot: tmp, harness }),
        ).toThrow(/native rule surface/);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('canonical rules are THIN POINTERS, not full policy bodies', () => {
    for (const rule of listCanonicalRules(repoRoot)) {
      const lines = rule.body.split('\n').length;
      // A thin pointer is short; a re-bloated 90-line policy body would fail here.
      expect(lines).toBeLessThan(40);
      // Each rule must point at the authoritative source rather than duplicate it.
      expect(/AGENTS\.md|skill/i.test(rule.body)).toBe(true);
    }
  });

  test('Claude does NOT get always-on policy rule files (no token bloat)', () => {
    for (const name of ['workflow', 'tdd', 'security', 'documentation']) {
      expect(fs.existsSync(path.join(repoRoot, '.claude/rules', `${name}.md`))).toBe(false);
    }
  });

  test('generated Cursor rules are not committed (setup-populated only)', () => {
    for (const file of Object.values(CURSOR_RULE_FILES)) {
      expect(fs.existsSync(path.join(repoRoot, '.cursor/rules', file))).toBe(false);
    }
  });

  test('workflow rule carries the tokens Cursor requires', () => {
    const [workflow] = listCanonicalRules(repoRoot, { only: ['workflow'] });
    const cursor = renderCursorRule(workflow);
    for (const token of ['/status', '/plan', '/dev', '/validate', '/ship', '/review', '/verify']) {
      expect(cursor.includes(token)).toBe(true);
    }
    expect(cursor.includes('alwaysApply: true')).toBe(true);
    expect(cursor.includes('/premerge')).toBe(false);
    expect(/pre-merge gate/i.test(cursor)).toBe(true);
  });

  test('renderCursorRuleMap covers every canonical rule exactly once', () => {
    const map = renderCursorRuleMap(repoRoot);
    expect(Object.keys(map).sort()).toEqual(Object.values(CURSOR_RULE_FILES).sort());
  });

  // ── C4: upgrade path must refresh stale Forge-managed .mdc, never touch user files ──
  test('C4: a stale Forge-managed .mdc is refreshed even with overwrite=false', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rules-upgrade-'));
    try {
      const outDir = path.join(tmp, '.cursor/rules');
      fs.mkdirSync(outDir, { recursive: true });
      const workflowFile = path.join(outDir, CURSOR_RULE_FILES.workflow);
      // Simulate an OLD generated file: carries the Forge "generated" marker but
      // stale body (e.g. the "Beads is the tracker" / wrong-/verify drift).
      const stale =
        '---\ndescription: "old"\n---\n\n' +
        '<!-- Generated by Forge from the canonical rules/ source. Do not edit -->\n\n' +
        '# STALE workflow — mentions Beads tracker and old stage names\n';
      fs.writeFileSync(workflowFile, stale);

      const result = renderRulesForHarness({ sourceRoot: repoRoot, targetRoot: tmp, overwrite: false });

      const refreshed = fs.readFileSync(workflowFile, 'utf-8');
      expect(refreshed).not.toBe(stale); // was refreshed, not skipped
      expect(refreshed).toBe(renderCursorRule(listCanonicalRules(repoRoot, { only: ['workflow'] })[0]));
      expect(result.written).toContain(CURSOR_RULE_FILES.workflow);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('C4: a user-authored .mdc (no Forge marker) is NOT clobbered with overwrite=false', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rules-user-'));
    try {
      const outDir = path.join(tmp, '.cursor/rules');
      fs.mkdirSync(outDir, { recursive: true });
      const workflowFile = path.join(outDir, CURSOR_RULE_FILES.workflow);
      const userContent = '---\ndescription: "my custom rule"\n---\n\n# Hand-authored, keep me\n';
      fs.writeFileSync(workflowFile, userContent);

      const result = renderRulesForHarness({ sourceRoot: repoRoot, targetRoot: tmp, overwrite: false });

      expect(fs.readFileSync(workflowFile, 'utf-8')).toBe(userContent); // untouched
      expect(result.skipped).toContain(CURSOR_RULE_FILES.workflow);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
