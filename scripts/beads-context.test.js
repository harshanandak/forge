/* eslint-disable no-undef -- Bun global is provided by the Bun runtime */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { describe, test, expect, beforeAll, afterAll } = require('bun:test');
const { resolveBashCommand } = require('../test/helpers/bash.js');

const SCRIPT_PATH = path.join(__dirname, 'beads-context.sh');
const WORKTREE_ROOT = path.resolve(__dirname, '..');

// Check if bd CLI is available AND Dolt database is reachable (not just binary exists).
// Prevents tests from hanging when Dolt is dead. BD_TIMEOUT env var overrides default.
function isBdAvailable() {
	try {
		execFileSync('bd', ['--version'], { stdio: 'ignore' });
		// Also verify Dolt database is reachable (not just binary exists)
		const timeout = parseInt(process.env.BD_TIMEOUT || '3000', 10);
		execFileSync('bd', ['list', '--limit=1'], { stdio: 'ignore', timeout });
		return true;
	} catch {
		return false;
	}
}

/**
 * Helper: run the beads-context.sh script with given args.
 * Returns { exitCode, stdout, stderr }.
 */
async function run(...args) {
	const proc = Bun.spawn([resolveBashCommand(), SCRIPT_PATH, ...args], {
		cwd: WORKTREE_ROOT,
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env },
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { exitCode, stdout, stderr };
}

/**
 * Helper: run a bd command.
 */
async function bd(...args) {
	const proc = Bun.spawn(['bd', ...args], {
		cwd: WORKTREE_ROOT,
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env },
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { exitCode, stdout, stderr };
}

describe.skipIf(!isBdAvailable())('scripts/beads-context.sh', () => {
	let testIssueId;

	// Create a temporary test issue for isolation
	beforeAll(async () => {
		const result = await bd(
			'create',
			'--title=beads-context-test-issue',
			'--type=task',
		);
		// Extract issue ID from output (bd create outputs the ID)
		const match = result.stdout.match(/([a-zA-Z]+-[a-zA-Z0-9]+)/);
		if (match) {
			testIssueId = match[1];
		} else {
			// Try bd q for just the ID
			const qResult = await bd(
				'q',
				'beads-context-test-issue-q',
				'--type=task',
			);
			testIssueId = qResult.stdout.trim();
		}
		expect(testIssueId).toBeTruthy();
	});

	// Clean up test issue after all tests
	afterAll(async () => {
		if (testIssueId) {
			await bd('delete', testIssueId, '--force');
		}
	});

	describe('Script existence and structure', () => {
		test('should exist', () => {
			expect(fs.existsSync(SCRIPT_PATH)).toBeTruthy();
		});

		test('should be executable or exist on Windows', () => {
			if (process.platform === 'win32') {
				expect(fs.existsSync(SCRIPT_PATH)).toBeTruthy();
			} else {
				const stats = fs.statSync(SCRIPT_PATH);
				const isExecutable = (stats.mode & 0o111) !== 0;
				expect(isExecutable).toBeTruthy();
			}
		});

		test('should have proper shebang for cross-platform compatibility', () => {
			const content = fs.readFileSync(SCRIPT_PATH, 'utf-8');
			const firstLine = content.split('\n')[0].replace(/\r$/, '');
			expect(firstLine).toBe('#!/usr/bin/env bash');
		});
	});

	describe('Missing arguments — usage errors', () => {
		test('should exit non-zero with usage when no subcommand given', async () => {
			const result = await run();
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toMatch(/usage/i);
		});

		test('should exit non-zero with usage for unknown subcommand', async () => {
			const result = await run('unknown-cmd');
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toMatch(/unknown/i);
		});

		test('set-design should require issue-id, task-count, task-file-path', async () => {
			const result = await run('set-design');
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toMatch(/usage/i);
		});

		test('set-acceptance should require issue-id and criteria-text', async () => {
			const result = await run('set-acceptance');
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toMatch(/usage/i);
		});

		test('update-progress should require all 7 args', async () => {
			const result = await run('update-progress', 'bd-xxx', '1');
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toMatch(/usage/i);
		});

		test('parse-progress should require issue-id', async () => {
			const result = await run('parse-progress');
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toMatch(/usage/i);
		});

		test('stage-transition should require issue-id, completed-stage, next-stage', async () => {
			const result = await run('stage-transition', 'bd-xxx');
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toMatch(/usage/i);
		});
	});

	describe('set-design', () => {
		test('should set design with valid args and exit 0', async () => {
			const result = await run(
				'set-design',
				testIssueId,
				'5',
				'docs/plans/2026-03-14-test-tasks.md',
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toMatch(/design/i);

			// Verify bd show contains the design info
			const show = await bd('show', testIssueId, '--json');
			expect(show.stdout).toContain('5 tasks');
			expect(show.stdout).toContain(
				'docs/plans/2026-03-14-test-tasks.md',
			);
		});

		test('should fail with non-existent issue ID', async () => {
			const result = await run(
				'set-design',
				'bd-nonexistent-999',
				'3',
				'docs/plans/fake.md',
			);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toMatch(/error|fail|not found/i);
		});
	});

	describe('set-acceptance', () => {
		test('should set acceptance criteria and exit 0', async () => {
			const criteria = 'All 5 tests pass. Coverage above 80%.';
			const result = await run(
				'set-acceptance',
				testIssueId,
				criteria,
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toMatch(/acceptance/i);

			// Verify bd show contains the acceptance criteria
			const show = await bd('show', testIssueId, '--json');
			expect(show.stdout).toContain('All 5 tests pass');
		});

		test('should handle special characters in criteria text', async () => {
			const criteria =
				'Must handle "quotes" and $variables & <angles>';
			const result = await run(
				'set-acceptance',
				testIssueId,
				criteria,
			);
			expect(result.exitCode).toBe(0);
		});

		test('should fail with non-existent issue ID', async () => {
			const result = await run(
				'set-acceptance',
				'bd-nonexistent-999',
				'Some criteria',
			);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toMatch(/error|fail|not found/i);
		});
	});

	describe('update-progress', () => {
		test('should append progress note and exit 0', async () => {
			const result = await run(
				'update-progress',
				testIssueId,
				'1',
				'7',
				'Types and interfaces',
				'abc1234',
				'5',
				'3',
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toMatch(/progress|task/i);

			// Verify the note was appended
			const show = await bd('show', testIssueId, '--json');
			expect(show.stdout).toContain('Task 1/7');
			expect(show.stdout).toContain('Types and interfaces');
			expect(show.stdout).toContain('abc1234');
		});

		test('should sanitize task title with quotes and newlines', async () => {
			const result = await run(
				'update-progress',
				testIssueId,
				'2',
				'7',
				'Title with "quotes" and\nnewline',
				'def5678',
				'3',
				'2',
			);
			expect(result.exitCode).toBe(0);
		});

		test('should fail with non-existent issue ID', async () => {
			const result = await run(
				'update-progress',
				'bd-nonexistent-999',
				'1',
				'5',
				'Some task',
				'abc1234',
				'3',
				'1',
			);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toMatch(/error|fail|not found/i);
		});

		test('should not execute shell injection in task title (OWASP A03)', async () => {
			// Attempt shell injection via $() and backticks
			const maliciousTitle = '$(echo PWNED) `echo PWNED2` ; rm -rf /';
			const result = await run(
				'update-progress',
				testIssueId,
				'4',
				'7',
				maliciousTitle,
				'bad1234',
				'0',
				'0',
			);
			expect(result.exitCode).toBe(0);

			// Verify dangerous shell metacharacters were stripped from stored note
			const show = await bd('show', testIssueId, '--json');
			// $(...) should be removed entirely
			expect(show.stdout).not.toContain('$(');
			// Backticks should be removed
			expect(show.stdout).not.toContain('`');
			// Semicolons should be removed
			expect(show.stdout).not.toMatch(/Task 4\/7.*[;]/);
		});

		test('should handle multiple progress updates (append, not overwrite)', async () => {
			await run(
				'update-progress',
				testIssueId,
				'3',
				'7',
				'Third task',
				'ghi9012',
				'4',
				'1',
			);

			const show = await bd('show', testIssueId, '--json');
			// Should contain both task 1 and task 3 notes
			expect(show.stdout).toContain('Task 1/7');
			expect(show.stdout).toContain('Task 3/7');
		});
	});

	describe('parse-progress', () => {
		test('should output formatted progress summary', async () => {
			const result = await run('parse-progress', testIssueId);
			expect(result.exitCode).toBe(0);
			// Should contain task count and last task info
			expect(result.stdout).toMatch(/\d+\/\d+ tasks done/);
			// Should contain the commit SHA in the last-task parenthetical
			expect(result.stdout).toMatch(/\([a-z0-9]+\)/);
		});

		test('should output "No progress data" for issue with no notes', async () => {
			// Create a fresh issue with no progress (use bd create, not bd q)
			const fresh = await bd(
				'create',
				'--title=beads-context-fresh-test',
				'--type=task',
			);
			const match = fresh.stdout.match(/([a-zA-Z]+-[a-zA-Z0-9]+)/);
			const freshId = match ? match[1] : '';

			// Guard: skip if bd create didn't return a parseable ID
			if (!freshId) {
				console.warn('Could not parse fresh issue ID; skipping');
				return;
			}

			try {
				const result = await run('parse-progress', freshId);
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toMatch(/no progress data/i);
			} finally {
				// Clean up regardless of test outcome
				if (freshId) await bd('delete', freshId, '--force');
			}
		});

		test('should fail with non-existent issue ID', async () => {
			const result = await run('parse-progress', 'bd-nonexistent-999');
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toMatch(/error|fail|not found/i);
		});
	});

	describe('stage-transition', () => {
		test('should record stage transition comment and exit 0', async () => {
			const result = await run(
				'stage-transition',
				testIssueId,
				'plan',
				'dev',
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toMatch(/stage|transition/i);

			// Verify the comment was added
			const comments = await bd('comments', testIssueId);
			expect(comments.stdout).toContain('plan');
			expect(comments.stdout).toContain('dev');
		});

		test('should fail with non-existent issue ID', async () => {
			const result = await run(
				'stage-transition',
				'bd-nonexistent-999',
				'plan',
				'dev',
			);
			expect(result.exitCode).not.toBe(0);
		});
	});
});

describe('/plan command integration with beads-context.sh', () => {
	const PLAN_MD_PATH = path.join(
		__dirname,
		'..',
		'.claude',
		'commands',
		'plan.md',
	);
	let planContent;

	beforeAll(() => {
		planContent = fs.readFileSync(PLAN_MD_PATH, 'utf-8');
	});

	test('plan.md should reference beads-context.sh set-design after task list creation', () => {
		expect(planContent).toContain('beads-context.sh set-design');
	});

	test('plan.md should reference beads-context.sh set-acceptance after task list creation', () => {
		expect(planContent).toContain('beads-context.sh set-acceptance');
	});

	test('plan.md should reference beads-context.sh stage-transition for plan to dev', () => {
		expect(planContent).toContain('beads-context.sh stage-transition');
		expect(planContent).toContain('plan dev');
	});

	test('plan.md HARD-GATE should include set-design success check', () => {
		// The exit HARD-GATE should mention set-design ran successfully
		expect(planContent).toMatch(
			/HARD-GATE.*plan exit[\s\S]*?set-design.*ran successfully/i,
		);
	});

	test('plan.md HARD-GATE should include set-acceptance success check', () => {
		// The exit HARD-GATE should mention set-acceptance ran successfully
		expect(planContent).toMatch(
			/HARD-GATE.*plan exit[\s\S]*?set-acceptance.*ran successfully/i,
		);
	});
});

describe('/dev command integration with beads-context.sh', () => {
	const DEV_MD_PATH = path.join(
		__dirname,
		'..',
		'.claude',
		'commands',
		'dev.md',
	);
	let devContent;

	beforeAll(() => {
		devContent = fs.readFileSync(DEV_MD_PATH, 'utf-8');
	});

	test('dev.md Step E HARD-GATE should reference beads-context.sh update-progress', () => {
		expect(devContent).toContain('beads-context.sh update-progress');
	});

	test('dev.md should reference beads-context.sh stage-transition for dev to validate', () => {
		expect(devContent).toContain('beads-context.sh stage-transition');
		expect(devContent).toContain('dev validate');
	});

	test('dev.md Step E HARD-GATE should include update-progress as a gate item', () => {
		// The task completion HARD-GATE should mention update-progress ran successfully
		expect(devContent).toMatch(
			/HARD-GATE.*task completion[\s\S]*?beads-context\.sh update-progress[\s\S]*?ran successfully/i,
		);
	});

	test('dev.md Beads update section should use stage-transition instead of bd update', () => {
		// The Beads update section should use stage-transition, not bd update --comment
		expect(devContent).toMatch(
			/Beads update[\s\S]*?beads-context\.sh stage-transition/i,
		);
	});
});

describe('/status command integration with smart-status', () => {
	const STATUS_MD_PATH = path.join(
		__dirname,
		'..',
		'.claude',
		'commands',
		'status.md',
	);
	let statusContent;

	beforeAll(() => {
		statusContent = fs.readFileSync(STATUS_MD_PATH, 'utf-8');
	});

	test('status.md should reference smart-status.sh as the primary status command', () => {
		expect(statusContent).toContain('bash scripts/smart-status.sh');
	});

	test('status.md should include hint to use bd show for full context', () => {
		expect(statusContent).toMatch(/bd show/i);
	});

	test('status.md should describe dynamic ranked output', () => {
		expect(statusContent).toContain('composite score');
	});
});

describe('/validate command integration with beads-context.sh', () => {
	const VALIDATE_MD_PATH = path.join(
		__dirname,
		'..',
		'.claude',
		'commands',
		'validate.md',
	);
	let validateContent;

	beforeAll(() => {
		validateContent = fs.readFileSync(VALIDATE_MD_PATH, 'utf-8');
	});

	test('validate.md should reference beads-context.sh stage-transition', () => {
		expect(validateContent).toContain('beads-context.sh stage-transition');
	});

	test('validate.md should reference stage-transition from validate to ship', () => {
		expect(validateContent).toContain('validate ship');
	});
});

describe('/ship command integration with beads-context.sh', () => {
	const SHIP_MD_PATH = path.join(
		__dirname,
		'..',
		'.claude',
		'commands',
		'ship.md',
	);
	let shipContent;

	beforeAll(() => {
		shipContent = fs.readFileSync(SHIP_MD_PATH, 'utf-8');
	});

	test('ship.md should reference beads-context.sh stage-transition', () => {
		expect(shipContent).toContain('beads-context.sh stage-transition');
	});

	test('ship.md should reference stage-transition from ship to review', () => {
		expect(shipContent).toContain('ship review');
	});
});

describe('/review command integration with beads-context.sh', () => {
	const REVIEW_MD_PATH = path.join(
		__dirname,
		'..',
		'.claude',
		'commands',
		'review.md',
	);
	let reviewContent;

	beforeAll(() => {
		reviewContent = fs.readFileSync(REVIEW_MD_PATH, 'utf-8');
	});

	test('review.md should reference beads-context.sh stage-transition', () => {
		expect(reviewContent).toContain('beads-context.sh stage-transition');
	});

	test('review.md should reference stage-transition from review to premerge', () => {
		expect(reviewContent).toContain('review premerge');
	});
});
