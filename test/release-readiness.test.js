'use strict';

const { afterEach, describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  AUDIT_ARTIFACT,
  auditBdCallSites,
  buildReadinessReport,
  renderBdCallSiteAuditMarkdown,
} = require('../lib/release-readiness');

const tempRoots = [];

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-release-readiness-'));
  tempRoots.push(root);
  return root;
}

function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('release readiness bd call-site audit', () => {
  test('groups concrete bd, .beads, and dolt surfaces without counting generic Beads prose', () => {
    const root = makeRepo();
    writeFile(root, 'lib/commands/_issue.js', "exec('bd', ['show']);\n// Beads prose only\n");
    writeFile(root, 'lib/workflow/state-manager.js', "const path = '.beads/issues.jsonl';\n");
    writeFile(root, 'AGENTS.md', 'Run `bd prime` for context.\n');
    writeFile(root, '.codex/skills/status/SKILL.md', 'Use `bd show <id>`.\n');
    writeFile(root, 'lefthook.yml', 'run: bd dolt pull\n');

    const audit = auditBdCallSites(root, {
      scanRoots: ['lib', 'AGENTS.md', '.codex/skills', 'lefthook.yml'],
    });

    expect(audit.groups.command.count).toBe(1);
    expect(audit.groups.runtime.count).toBe(1);
    expect(audit.groups.docs.count).toBe(1);
    expect(audit.groups.skills.count).toBe(1);
    expect(audit.groups.hooks.count).toBe(1);

    const markdown = renderBdCallSiteAuditMarkdown(audit);
    expect(markdown).toContain('## command');
    expect(markdown).toContain('lib/commands/_issue.js');
    expect(markdown).not.toContain('Beads prose only');
  });

  test('includes active harness instruction files from the sync manifest', () => {
    const root = makeRepo();
    writeFile(root, '.forge/sync-manifest.json', JSON.stringify({
      files: ['.cursor/commands/dev.md'],
    }));
    writeFile(root, '.cursor/commands/dev.md', 'Use `bd ready` before selecting work.\n');

    const audit = auditBdCallSites(root, { scanRoots: [] });

    expect(audit.groups.docs.files).toEqual([
      expect.objectContaining({
        path: '.cursor/commands/dev.md',
        count: 1,
      }),
    ]);
  });

  test('blocks readiness when the checked-in kill-list artifact is missing or stale', () => {
    const root = makeRepo();
    writeFile(root, 'lib/commands/_issue.js', "exec('bd', ['show']);\n");

    const missing = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: ['lib'],
    });
    expect(missing.blockers.map(blocker => blocker.id)).toContain('d20-audit-artifact-current');

    writeFile(root, AUDIT_ARTIFACT, 'stale artifact\n');
    const stale = buildReadinessReport(root, {
      target: '0.1.0',
      scanRoots: ['lib'],
    });
    const blocker = stale.blockers.find(item => item.id === 'd20-audit-artifact-current');
    expect(blocker.detail).toContain('stale');
  });
});
