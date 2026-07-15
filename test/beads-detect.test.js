'use strict';

const { describe, test, expect } = require('bun:test');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const { detectBeadsJsonlSource } = require('../lib/beads-detect');

// Single-source Beads detector (kernel issue a5399f3d). Lives in a neutral module
// so BOTH the issue-path nudge and the upgrade advisory share one definition, and
// so it does NOT revive the `migrateCommand.detectBeadsJsonlSource` name pinned
// gone by the a7e1443c auto-migrate tombstone.

function makeRoot() {
  return mkdtempSync(path.join(tmpdir(), 'forge-beads-detect-'));
}

describe('detectBeadsJsonlSource', () => {
  test('detects a top-level .beads/*.jsonl store', () => {
    const root = makeRoot();
    mkdirSync(path.join(root, '.beads'), { recursive: true });
    writeFileSync(path.join(root, '.beads', 'issues.jsonl'), '{"id":"bd-1"}\n');
    expect(detectBeadsJsonlSource(root)).toBe(path.join(root, '.beads'));
  });

  test('detects a split store with jsonl ONLY under .beads/backup/', () => {
    const root = makeRoot();
    mkdirSync(path.join(root, '.beads', 'backup'), { recursive: true });
    // No jsonl directly under .beads/ — only under backup/ (a layout the migrator reads).
    writeFileSync(path.join(root, '.beads', 'backup', 'events.jsonl'), '{"id":"ev-1"}\n');
    expect(detectBeadsJsonlSource(root)).toBe(path.join(root, '.beads', 'backup'));
  });

  test('returns null when there is no .beads store', () => {
    const root = makeRoot();
    expect(detectBeadsJsonlSource(root)).toBeNull();
  });

  test('returns null for a .beads dir with no jsonl anywhere', () => {
    const root = makeRoot();
    mkdirSync(path.join(root, '.beads', 'backup'), { recursive: true });
    writeFileSync(path.join(root, '.beads', 'readme.txt'), 'not jsonl\n');
    expect(detectBeadsJsonlSource(root)).toBeNull();
  });
});
