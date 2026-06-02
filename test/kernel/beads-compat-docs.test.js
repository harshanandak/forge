const { describe, expect, test } = require('bun:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const WORK_DIR = join(__dirname, '..', '..', 'docs', 'work', '2026-06-01-0.0.20-beads-import-export');

function readWorkDoc(fileName) {
  return readFileSync(join(WORK_DIR, fileName), 'utf8');
}

describe('Beads import/export adapter work docs', () => {
  test('documents the PR C adapter boundary and rollback path', () => {
    const design = readWorkDoc('design.md');
    const tasks = readWorkDoc('tasks.md');
    const decisions = readWorkDoc('decisions.md');

    expect(design).toContain('Issue: forge-2agy.2.3');
    expect(design).toContain('Beads remains import/export compatibility only');
    expect(design).toContain('fidelity report');
    expect(design).toContain('dry-run');
    expect(design).toContain('rollback');
    expect(tasks).toContain('RED');
    expect(tasks).toContain('GREEN');
    expect(decisions).toContain('close reason');
  });
});
