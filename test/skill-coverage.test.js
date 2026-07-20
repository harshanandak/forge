'use strict';

const { describe, test, expect } = require('bun:test');
const path = require('node:path');

// ─── command-coverage gate (§3.3 of docs/work/2026-07-20-next-phase-plan.md) ──────
//
// Every REGISTERED user-facing command must own a skill (a string mapping to an existing
// skills/<name>) or carry an explicit { exempt: "<reason>" } in skills/coverage.json. A registered
// command with NO entry FAILS the gate — so a new command physically cannot merge without deciding
// its skill home. This file is BOTH the unit spec for evaluateCoverage and the CI GATE: the final
// describe recomputes the real repo's coverage from the command registry + committed coverage.json
// and fails on any gap (mirrors the W3 skill-eval gate that runs in the same test.yml job).

const {
  evaluateCoverage,
  buildCoverageReport,
  enumerateCommandNames,
  loadCoverageMap,
  resolveSkillsDir,
} = require('../lib/skill-eval');

const repoRoot = path.resolve(__dirname, '..');
const skillNames = new Set(['ship', 'memory', 'status']);

// ── evaluateCoverage (pure) ─────────────────────────────────────────────────────
describe('evaluateCoverage', () => {
  test('(a) a registered command missing from coverage.json FAILS (unmapped)', () => {
    const res = evaluateCoverage({
      commands: ['ship', 'ghost'],
      coverage: { commands: { ship: 'ship' } },
      skillNames,
    });
    expect(res.passed).toBe(false);
    expect(res.failures.some(f => f.command === 'ghost' && f.kind === 'unmapped')).toBe(true);
  });

  test('(b) a command mapped to a real skill PASSES', () => {
    const res = evaluateCoverage({
      commands: ['ship'],
      coverage: { commands: { ship: 'ship' } },
      skillNames,
    });
    expect(res.passed).toBe(true);
    expect(res.mapped).toBe(1);
    expect(res.exempt).toBe(0);
  });

  test('(c) an exempt entry with a non-empty reason PASSES', () => {
    const res = evaluateCoverage({
      commands: ['worktree'],
      coverage: { commands: { worktree: { exempt: 'worktree skill pending' } } },
      skillNames,
    });
    expect(res.passed).toBe(true);
    expect(res.exempt).toBe(1);
  });

  test('a mapping to a skill that does not exist FAILS (unknown_skill)', () => {
    const res = evaluateCoverage({
      commands: ['ship'],
      coverage: { commands: { ship: 'nope' } },
      skillNames,
    });
    expect(res.passed).toBe(false);
    expect(res.failures[0].kind).toBe('unknown_skill');
  });

  test('a malformed entry (empty exempt reason / wrong shape) FAILS', () => {
    for (const bad of [{ exempt: '' }, { exempt: '   ' }, {}, 123, null, true]) {
      const res = evaluateCoverage({ commands: ['x'], coverage: { commands: { x: bad } }, skillNames });
      expect(res.passed).toBe(false);
      expect(res.failures[0].kind).toBe('malformed_entry');
    }
  });

  test('a missing coverage.json (null) FAILS the whole gate', () => {
    const res = evaluateCoverage({ commands: ['ship'], coverage: null, skillNames });
    expect(res.passed).toBe(false);
    expect(res.failures[0].kind).toBe('coverage_map_missing');
  });

  test('an empty command enumeration can never hollow-pass', () => {
    const res = evaluateCoverage({ commands: [], coverage: { commands: {} }, skillNames });
    expect(res.passed).toBe(false);
    expect(res.failures[0].kind).toBe('no_commands_enumerated');
  });

  test('a coverage.json entry for a removed command WARNS (non-blocking)', () => {
    const res = evaluateCoverage({
      commands: ['ship'],
      coverage: { commands: { ship: 'ship', ancient: { exempt: 'gone' } } },
      skillNames,
    });
    expect(res.passed).toBe(true);
    expect(res.warnings.some(w => w.command === 'ancient' && w.kind === 'stale_entry')).toBe(true);
  });
});

// ── the CI GATE: the real repo's coverage is complete ─────────────────────────────
describe('the canonical command surface is fully covered', () => {
  test('(d) the committed coverage.json covers EVERY registered command (gate PASSES today)', () => {
    const report = buildCoverageReport(repoRoot);
    expect(report).not.toBeNull();
    if (!report.passed) {
      console.error('coverage failures:', JSON.stringify(report.failures, null, 2));
    }
    expect(report.passed).toBe(true);
    expect(report.total).toBeGreaterThan(0);
    // Every command is accounted for as EITHER mapped or exempt (no unclassified commands).
    expect(report.mapped + report.exempt).toBe(report.total);
  });

  test('coverage.json has no stale entries (no mapping for a removed command)', () => {
    const report = buildCoverageReport(repoRoot);
    expect(report.warnings).toEqual([]);
  });

  test('every registered command appears in coverage.json', () => {
    const commands = enumerateCommandNames();
    const coverage = loadCoverageMap(resolveSkillsDir(repoRoot));
    expect(commands.length).toBeGreaterThan(0);
    for (const cmd of commands) {
      expect(Object.prototype.hasOwnProperty.call(coverage.commands, cmd)).toBe(true);
    }
  });
});
