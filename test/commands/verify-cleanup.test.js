const { describe, test, expect } = require('bun:test');
const { readFileSync } = require('fs');
const { join } = require('path');

const verifyMdPath = join(__dirname, '../../.claude/commands/verify.md');
const verifyMd = readFileSync(verifyMdPath, 'utf8');

describe('verify.md — Step 6: Worktree and Branch Cleanup', () => {
	test('verify.md contains headRefName for branch resolution', () => {
		expect(verifyMd.includes('headRefName')).toBe(true);
	});

	test('verify.md contains worktree remove command', () => {
		expect(verifyMd.includes('worktree remove')).toBe(true);
	});

	test('verify.md uses substr($0, 10) for space-safe path extraction', () => {
		expect(verifyMd.includes('substr($0, 10)')).toBe(true);
		// Ensures paths with spaces are not truncated (awk $2 would split on whitespace)
		expect(verifyMd.includes('path=$2')).toBe(false);
	});

	test('verify.md uses safe branch delete (-d not -D)', () => {
		expect(verifyMd.includes('branch -d')).toBe(true);
		expect(verifyMd.includes('branch -D')).toBe(false);
	});

	test('verify.md HARD-GATE contains "Worktree removed (or confirmed already gone)"', () => {
		expect(verifyMd.includes('Worktree removed (or confirmed already gone)')).toBe(true);
	});

	test('verify.md contains specific skip messages for missing worktree and branch', () => {
		expect(verifyMd.includes('Worktree: not found (already removed or never created) — skipping')).toBe(true);
		expect(verifyMd.includes('Branch: already deleted — skipping')).toBe(true);
	});
});
