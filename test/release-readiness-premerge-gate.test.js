'use strict';

// Certifies the premerge-embedded-gate blocker actually scans the surfaces where
// pre-merge could be re-modeled as a standalone stage/command. Pre-D20 the gate
// looked at only 3 files and read GREEN while residue lived in the AGENTS.md
// generator (agents-config.js) and the stage taxonomies (plugin-catalog.js,
// recommend.js, capability-matrix). It must also tolerate the LEGACY read-path
// name maps that stay for round-tripping historical `currentStage='premerge'`.

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { premergeEmbeddedGateBlocker } = require('../lib/release-readiness');

let root;

function write(rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'premerge-gate-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('premerge embedded-gate certification', () => {
  test('a clean repo (no premerge stage/command residue) has no blocker', () => {
    expect(premergeEmbeddedGateBlocker(root)).toBeNull();
  });

  test('residue in the AGENTS.md generator (agents-config.js) is caught', () => {
    write('lib/agents-config.js', 'const t = `\n### /premerge\nMerge and cleanup\n`;\n');
    const blocker = premergeEmbeddedGateBlocker(root);
    expect(blocker).not.toBeNull();
    expect(blocker.evidence.map(e => e.path)).toContain('lib/agents-config.js');
  });

  test('residue in the plugin-catalog stage taxonomy is caught', () => {
    write('lib/plugin-catalog.js', "const STAGES = { PREMERGE: 'premerge' };\n");
    const blocker = premergeEmbeddedGateBlocker(root);
    expect(blocker).not.toBeNull();
    expect(blocker.evidence.map(e => e.path)).toContain('lib/plugin-catalog.js');
  });

  test('residue in recommend.js and the capability matrix is caught', () => {
    write('lib/commands/recommend.js', "const STAGE_NAMES = { premerge: 'Premerge' };\n");
    write('lib/harness-capability-matrix.js', "const S = { premerge: ['premerge.docs'] };\n");
    const paths = premergeEmbeddedGateBlocker(root).evidence.map(e => e.path);
    expect(paths).toContain('lib/commands/recommend.js');
    expect(paths).toContain('lib/harness-capability-matrix.js');
  });

  test('a re-introduced /premerge command in status.js is caught', () => {
    write('lib/commands/status.js', "const next = '/premerge';\n");
    const blocker = premergeEmbeddedGateBlocker(root);
    expect(blocker).not.toBeNull();
    expect(blocker.evidence.map(e => e.path)).toContain('lib/commands/status.js');
  });

  test('the LEGACY status.js name map (premerge: ...) is tolerated — not a stage/command', () => {
    // AUTHORITATIVE_STAGE_NAMES.premerge is load-bearing for legacy round-trip and
    // must NOT trip the gate: it is a name map key (no slash-command), not a stage.
    write('lib/commands/status.js', "const AUTHORITATIVE_STAGE_NAMES = { premerge: 'Premerge' };\n");
    expect(premergeEmbeddedGateBlocker(root)).toBeNull();
  });
});
