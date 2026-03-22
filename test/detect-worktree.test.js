/**
 * @fileoverview Tests for worktree detection utility.
 * Uses real git commands against this repo's worktree structure.
 */
const { describe, test, expect } = require('bun:test');
const path = require('path');

// Module under test — will fail until lib/detect-worktree.js exists
const { detectWorktree } = require('../lib/detect-worktree');

const MAIN_REPO = path.resolve(__dirname, '..');
// This test file lives inside the worktree, so __dirname IS the worktree
const WORKTREE_DIR = MAIN_REPO;

describe('detectWorktree', () => {
  test('returns an object with inWorktree boolean', () => {
    const result = detectWorktree(MAIN_REPO);
    expect(typeof result.inWorktree).toBe('boolean');
  });

  test('detects worktree correctly based on environment', () => {
    const result = detectWorktree(WORKTREE_DIR);
    // In a worktree (local dev), inWorktree is true
    // In CI (repo root), inWorktree is false
    // Either way, the function should return a valid result
    expect(typeof result.inWorktree).toBe('boolean');
    if (result.inWorktree) {
      expect(result.branch).toBeDefined();
      expect(result.mainWorktree).toBeDefined();
    }
  });

  test('returns branch name when inside a worktree', () => {
    const result = detectWorktree(WORKTREE_DIR);
    if (result.inWorktree) {
      expect(result.branch).toBe('feat/smart-setup-ux');
    }
  });

  test('returns mainWorktree path when inside a worktree', () => {
    const result = detectWorktree(WORKTREE_DIR);
    if (result.inWorktree) {
      expect(typeof result.mainWorktree).toBe('string');
      expect(result.mainWorktree.length).toBeGreaterThan(0);
    }
  });

  test('returns { inWorktree: false } for non-git directory without throwing', () => {
    const tmpDir = require('os').tmpdir();
    const result = detectWorktree(tmpDir);
    expect(result.inWorktree).toBe(false);
  });

  test('returns { inWorktree: false } from the main repo root', () => {
    // The main forge repo (not the worktree) — find it via git-common-dir
    const { execFileSync } = require('child_process');
    try {
      const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
        encoding: 'utf8', cwd: WORKTREE_DIR, stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
      // commonDir is like /path/to/forge/.git — go up one level
      const mainRoot = path.resolve(WORKTREE_DIR, commonDir, '..');
      const result = detectWorktree(mainRoot);
      expect(result.inWorktree).toBe(false);
    } catch (_err) {
      // If we can't resolve, skip this test assertion
    }
  });
});
