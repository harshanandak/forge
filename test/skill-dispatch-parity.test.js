'use strict';

const { describe, test, expect } = require('bun:test');
const path = require('node:path');

const { generateAgentsMdContent } = require('../lib/agents-config');
const { renderCursorRuleMap, CURSOR_RULE_FILES } = require('../lib/rules-sync');
const { loadDispatchText } = require('../lib/using-forge');
const { SESSION_START_SUPPORT, BOOTSTRAP_DELIVERY } = require('../lib/hook-renderer');
const { HARNESS_IDS } = require('../lib/harness-capability-matrix');

const repoRoot = path.resolve(__dirname, '..');

// The canonical dispatch-pointer markers that MUST appear on every always-on delivery surface.
// Both are present in the skill body, the Cursor rule, and the generated AGENTS.md — so a drift
// in any one generator (dropping the pointer) fails here.
const POINTER_MARKERS = ['forge skill for', '1%'];

// Delivery is described by SURFACE TYPE, never by harness name — this table drives the parity
// assertions without any harness-name branching in product code.
const DELIVERY_SURFACES = [
  {
    id: 'agents-file',
    render: () => generateAgentsMdContent({ name: 'x', testCommand: 'bun test', buildCommand: 'bun run build' }),
  },
  {
    id: 'rule',
    render: () => renderCursorRuleMap(repoRoot)[CURSOR_RULE_FILES['using-forge']],
  },
  {
    id: 'skill-hook',
    // The Claude SessionStart hook injects exactly this text (lib/commands/hooks.js), so asserting
    // the skill body carries the pointer covers the hook surface without spawning the hook.
    render: () => loadDispatchText(repoRoot),
  },
];

describe('skill-dispatch parity across delivery surfaces (mechanism, not identity)', () => {
  test.each(DELIVERY_SURFACES.map(s => [s.id, s]))('%s surface carries the dispatch pointer', (_id, surface) => {
    const rendered = surface.render();
    expect(typeof rendered).toBe('string');
    expect(rendered.length).toBeGreaterThan(0);
    for (const marker of POINTER_MARKERS) {
      expect(rendered).toContain(marker);
    }
  });

  test('the using-forge Cursor rule is always-apply (auto-injected every session)', () => {
    const rule = renderCursorRuleMap(repoRoot)[CURSOR_RULE_FILES['using-forge']];
    expect(rule).toContain('alwaysApply: true');
  });

  test('the AGENTS.md generator names the dispatch skill by path (Codex/Claude/Hermes carrier)', () => {
    const md = generateAgentsMdContent({ name: 'x', testCommand: 'bun test', buildCommand: 'bun run build' });
    // Names the dispatch skill BY NAME + the CLI — NOT a repo-relative skills/ path, which does
    // not exist in a set-up consumer project (only the generated mirrors do).
    expect(md).toContain('using-forge');
    expect(md).not.toContain('skills/using-forge/SKILL.md');
    expect(md).toContain('Skill Dispatch');
  });
});

describe('every harness has a bootstrap delivery surface (no orphaned harness, no faked parity)', () => {
  test('BOOTSTRAP_DELIVERY covers every known harness', () => {
    for (const harness of HARNESS_IDS) {
      expect(BOOTSTRAP_DELIVERY[harness]).toBeTruthy();
    }
  });

  test('each SessionStart-hook rendered:false harness still has a real surface or the honest-fallback marker', () => {
    const HONEST_FALLBACK = 'cli-fallback';
    const REAL_SURFACES = ['always-apply-rule', 'agents-md', 'session-start-hook'];
    for (const harness of HARNESS_IDS) {
      const support = SESSION_START_SUPPORT[harness];
      if (support && support.rendered) continue; // Claude renders the native hook.
      const delivery = BOOTSTRAP_DELIVERY[harness];
      // Non-null delivery that is either a real always-on surface OR the explicit honest fallback.
      expect([...REAL_SURFACES, HONEST_FALLBACK]).toContain(delivery);
      // And the honest reason string must not imply "no surface".
      expect(support.reason).not.toBe('no-session-start-surface');
    }
  });

  test('only Hermes uses the honest CLI fallback; Cursor and Codex have real always-on surfaces', () => {
    expect(BOOTSTRAP_DELIVERY.hermes).toBe('cli-fallback');
    expect(BOOTSTRAP_DELIVERY.cursor).toBe('always-apply-rule');
    expect(BOOTSTRAP_DELIVERY.codex).toBe('agents-md');
  });
});
