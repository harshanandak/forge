'use strict';

const { describe, test, expect } = require('bun:test');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const {
  buildUpgradeDryRunReport,
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

  test('an explicit beads opt-in (config) does NOT flag a migration', () => {
    const root = makeRoot({ beadsJsonl: true, configBackend: 'beads' });
    const report = buildUpgradeDryRunReport(root);

    expect(report.beadsMigration.jsonlPresent).toBe(true);
    expect(report.beadsMigration.configBackend).toBe('beads');
    expect(report.beadsMigration.needsMigration).toBe(false);

    const output = renderUpgradeDryRunReport(report);
    expect(output).not.toContain('forge migrate --from beads');
  });

  test('a repo with no beads store shows no migration section', () => {
    const root = makeRoot({ beadsJsonl: false });
    const report = buildUpgradeDryRunReport(root);

    expect(report.beadsMigration.jsonlPresent).toBe(false);
    expect(report.beadsMigration.needsMigration).toBe(false);

    const output = renderUpgradeDryRunReport(report);
    expect(output).not.toContain('forge migrate --from beads');
  });
});
