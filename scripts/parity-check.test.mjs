// Unit test for the parity-check asset filtering. The parity check compares the
// npm-vs-binary `setup --quick` trees; it MUST ignore package-manager install
// byproducts (node_modules/**, lockfiles) that are legitimately non-deterministic
// between runs/channels/OSes, while staying strict for real Forge assets. This
// test pins that exclusion so a genuine skills/rules/hook drift still fails but
// install junk never produces a false-positive parity failure.

import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashTree, EXCLUDED_DIRS, EXCLUDED_FILES } from './parity-check.mjs';

function mkTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-hashtree-'));
  // Real Forge-managed assets — these MUST be compared.
  fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'SKILL.md'), 'real asset\n');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'real asset\n');
  // Install byproducts — these MUST be excluded.
  fs.mkdirSync(path.join(dir, 'node_modules', 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'left-pad', 'index.js'), 'junk\n');
  fs.writeFileSync(path.join(dir, 'node_modules', '.package-lock.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"v":1}\n');
  return dir;
}

test('hashTree excludes node_modules and lockfiles but keeps real assets', () => {
  const dir = mkTree();
  try {
    const keys = Object.keys(hashTree(dir)).sort();
    expect(keys).toEqual(['AGENTS.md', 'skills/SKILL.md']);
    // No install artifact leaked into the comparison set.
    expect(keys.some(k => k.includes('node_modules'))).toBe(false);
    expect(keys.some(k => k.endsWith('package-lock.json'))).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a real asset byte change is still detected (parity stays strict)', () => {
  const dir = mkTree();
  try {
    const before = hashTree(dir);
    fs.writeFileSync(path.join(dir, 'skills', 'SKILL.md'), 'DRIFTED asset\n');
    const after = hashTree(dir);
    expect(after['skills/SKILL.md']).not.toBe(before['skills/SKILL.md']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exclusion sets document the intended artifacts', () => {
  expect(EXCLUDED_DIRS.has('node_modules')).toBe(true);
  expect(EXCLUDED_DIRS.has('.git')).toBe(true);
  expect(EXCLUDED_FILES.has('package-lock.json')).toBe(true);
  expect(EXCLUDED_FILES.has('.package-lock.json')).toBe(true);
});
