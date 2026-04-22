const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } = require('bun:test');

const { cleanupTmpDir, createMockBd, daysAgo, runSmartStatus } = require('./smart-status.helpers');

setDefaultTimeout(20000);

function createMockGit(porcelainOutput) {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-status-git-'));
	const mockScript = path.join(tmpDir, 'git');
	const scriptContent = `#!/usr/bin/env bash
if [ "$1" = "worktree" ]; then
  cat <<'PORCELAINEOF'
${porcelainOutput}
PORCELAINEOF
  exit 0
elif [ "$1" = "rev-parse" ]; then
  if [ "$3" = "master" ]; then exit 0; fi
  exit 1
elif [ "$1" = "diff" ]; then
  echo ""
  exit 0
fi
exit 0
`;
	fs.writeFileSync(mockScript, scriptContent, { mode: 0o755 });
	return { tmpDir, mockScript };
}

describe('smart-status.sh > session detection smoke', () => {
	let trackedGit;
	let trackedBd;
	let orphanGit;
	let orphanBd;

	beforeAll(() => {
		trackedGit = createMockGit([
			'worktree /repo',
			'HEAD abc123',
			'branch refs/heads/master',
			'',
			'worktree /repo/.worktrees/workflow-intelligence',
			'HEAD def456',
			'branch refs/heads/feat/workflow-intelligence',
			'',
		].join('\n'));
		trackedBd = createMockBd({
			issues: [
				{ id: 'forge-68oj', title: 'Workflow intelligence', priority: 'P1', type: 'feature', status: 'in_progress', dependent_count: 0, updated_at: daysAgo(1) },
			],
		});
		orphanGit = createMockGit([
			'worktree /repo',
			'HEAD abc123',
			'branch refs/heads/master',
			'',
			'worktree /repo/.worktrees/orphan-branch',
			'HEAD def456',
			'branch refs/heads/feat/orphan-branch',
			'',
		].join('\n'));
		orphanBd = createMockBd({
			issues: [
				{ id: 'forge-abc', title: 'Some issue', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
			],
		});
	});

	afterAll(() => {
		for (const fixture of [trackedGit, trackedBd, orphanGit, orphanBd]) {
			cleanupTmpDir(fixture?.tmpDir);
		}
	});

	test('shows ACTIVE SESSIONS before grouped output and matches the branch to an in-progress issue', () => {
		const result = runSmartStatus([], {
			BD_CMD: trackedBd.mockScript,
			GIT_CMD: trackedGit.mockScript,
			NO_COLOR: '1',
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('ACTIVE SESSIONS');
		expect(result.stdout).toContain('feat/workflow-intelligence');
		expect(result.stdout).toContain('forge-68oj');
		expect(result.stdout.indexOf('ACTIVE SESSIONS')).toBeLessThan(result.stdout.indexOf('RESUME'));
	});

	test('shows unmatched branches as untracked', () => {
		const result = runSmartStatus([], {
			BD_CMD: orphanBd.mockScript,
			GIT_CMD: orphanGit.mockScript,
			NO_COLOR: '1',
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('feat/orphan-branch');
		expect(result.stdout).toContain('untracked');
	});
});
