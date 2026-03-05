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

	test('verify.md uses safe branch delete (-d not -D)', () => {
		expect(verifyMd.includes('branch -d')).toBe(true);
		expect(verifyMd.includes('branch -D')).toBe(false);
	});

	test('verify.md HARD-GATE contains "Worktree removed (or confirmed already gone)"', () => {
		expect(verifyMd.includes('Worktree removed (or confirmed already gone)')).toBe(true);
	});

	test('verify.md contains skip language for missing worktree or branch', () => {
		expect(verifyMd.includes('skip')).toBe(true);
	});
});
