const { describe, test, expect } = require('bun:test');
const { readFileSync } = require('fs');
const { join } = require('path');

const verifyMdPath = join(__dirname, '../../.claude/commands/verify.md');
const verifyMd = readFileSync(verifyMdPath, 'utf8');

describe('verify.md — Step 6: Worktree and Branch Cleanup', () => {
	test('verify.md contains worktree remove command', () => {
		expect(verifyMd.includes('worktree remove')).toBe(true);
	});

	test('verify.md contains safe branch delete command (branch -d)', () => {
		expect(verifyMd.includes('branch -d')).toBe(true);
	});

	test('verify.md HARD-GATE contains "Worktree removed"', () => {
		expect(verifyMd.includes('Worktree removed')).toBe(true);
	});
});
