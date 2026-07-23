'use strict';

const { describe, test, expect } = require('bun:test');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const {
  buildUpgradeDryRunReport,
  buildBeadsMigrationSummary,
  renderUpgradeDryRunReport,
} = require('../lib/upgrade-safety');

// Upgrade-safety (kernel issue a5399f3d): `forge upgrade --dry-run` must surface
// the 0.0.10 -> current breaking boundary rather than silently pass. When a repo
// still carries a Beads issue store (.beads/*.jsonl) and has NOT opted back into
// beads, the preview must warn that the kernel default hides those issues and
// offer the guided migration path.

function makeRoot({ beadsJsonl, configBackend } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'forge-upgrade-beads-'));
  if (beadsJsonl) {
    mkdirSync(path.join(root, '.beads'), { recursive: true });
    writeFileSync(path.join(root, '.beads', 'issues.jsonl'), '{"id":"bd-1"}\n');
  }
  if (configBackend) {
    mkdirSync(path.join(root, '.forge'), { recursive: true });
    writeFileSync(path.join(root, '.forge', 'config.yaml'), `issueBackend: ${configBackend}\n`);
  }
  return root;
}

describe('upgrade preview — beads -> kernel breaking boundary', () => {
  test('a beads-backed 0.0.10 repo flags the migration in the report + rendered output', () => {
    const root = makeRoot({ beadsJsonl: true });
    const report = buildUpgradeDryRunReport(root);

    expect(report.beadsMigration).toBeDefined();
    expect(report.beadsMigration.jsonlPresent).toBe(true);
    expect(report.beadsMigration.needsMigration).toBe(true);

    const output = renderUpgradeDryRunReport(report);
    expect(output).toContain('0.0.10');
    expect(output).toContain('forge migrate --from beads');
    expect(output).toContain('forge setup');
  });

  test('a leftover `issueBackend: beads` config no longer suppresses the advisory', () => {
    // The beads backend is gone, so the config value is a stale opt-in to something
    // that no longer exists — the user still has an unmigrated store and still needs
    // the pointer. The value is reported (so the advisory can explain it) but never
    // silences the migration.
    const root = makeRoot({ beadsJsonl: true, configBackend: 'beads' });
    const report = buildUpgradeDryRunReport(root);

    expect(report.beadsMigration.jsonlPresent).toBe(true);
    expect(report.beadsMigration.configBackend).toBe('beads');
    expect(report.beadsMigration.needsMigration).toBe(true);

    const output = renderUpgradeDryRunReport(report);
    expect(output).toContain('forge migrate --from beads');
  });

  test('a repo with no beads store shows no migration section', () => {
    const root = makeRoot({ beadsJsonl: false });
    const report = buildUpgradeDryRunReport(root);

    expect(report.beadsMigration.jsonlPresent).toBe(false);
    expect(report.beadsMigration.needsMigration).toBe(false);

    const output = renderUpgradeDryRunReport(report);
    expect(output).not.toContain('forge migrate --from beads');
  });

  // The advisory is a GUIDE, not an integrity failure — a pending migration must
  // never flip `ok` (scripts key on it). Pin it: two otherwise-identical repos,
  // one with a beads store, produce the SAME `ok`.
  test('a pending beads migration does NOT flip report.ok', () => {
    const withBeads = makeRoot({ beadsJsonl: true });
    const without = makeRoot({ beadsJsonl: false });

    const beadsReport = buildUpgradeDryRunReport(withBeads);
    const cleanReport = buildUpgradeDryRunReport(without);

    expect(beadsReport.beadsMigration.needsMigration).toBe(true);
    expect(cleanReport.beadsMigration.needsMigration).toBe(false);
    // The migration advisory is orthogonal to readiness `ok`.
    expect(beadsReport.ok).toBe(cleanReport.ok);
  });

  // With the backend removed there is no opt-out left to respect: a stale
  // FORGE_ISSUE_BACKEND=beads resolves to the kernel, so the advisory still fires.
  test('a stale FORGE_ISSUE_BACKEND=beads env no longer suppresses the advisory', () => {
    const root = makeRoot({ beadsJsonl: true });

    const staleEnv = buildBeadsMigrationSummary(root, { FORGE_ISSUE_BACKEND: 'beads' });
    expect(staleEnv.jsonlPresent).toBe(true);
    expect(staleEnv.needsMigration).toBe(true);

    // Same repo, default env -> the advisory fires identically.
    const defaultEnv = buildBeadsMigrationSummary(root, {});
    expect(defaultEnv.needsMigration).toBe(true);
  });
});
