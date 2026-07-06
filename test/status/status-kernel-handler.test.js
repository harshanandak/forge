'use strict';

const { describe, test, expect } = require('bun:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const statusCommand = require('../../lib/commands/status.js');
const { runIssueOperation } = require('../../lib/forge-issues.js');

// Handler-path revert guard for bug 40f35797. Zero-arg `forge status` on a
// kernel-DEFAULT repo (no .beads fixture, no issueBackend pin) must read the Kernel
// and surface ready work. This drives the REAL handler wiring in lib/commands/status.js
// end to end — not readKernelSnapshot directly — so reverting the status.js
// readBeadsSnapshot -> readStatusSnapshot swap turns this RED: the empty/absent Beads
// store yields "Ready: none" and the "/plan" dead end instead of the ready count.
function createKernelDefaultRepo() {
	const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-status-kernel-default-'));
	const run = (args) => execFileSync('git', args, { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] });
	run(['init']);
	run(['config', 'user.email', 'harshanandak@users.noreply.github.com']);
	run(['config', 'user.name', 'Harsha Nanda']);
	run(['checkout', '-b', 'feat/status-kernel-default']);
	// A born branch keeps repo-context detection on its normal path. The kernel DB lands
	// under .git/, so the working tree stays clean.
	run(['commit', '--allow-empty', '--no-verify', '--no-gpg-sign', '-m', 'init']);
	return repoRoot;
}

function cleanup(dir) {
	// The builtin SQLite driver holds the DB open for the process lifetime, so on Windows
	// rmSync can hit EBUSY at teardown. Cleanup is not the assertion.
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// ignore: OS reclaims the temp dir.
	}
}

describe('forge status handler reads the Kernel on a kernel-default repo (bug 40f35797)', () => {
	test('zero-arg status surfaces the ready count + claim fallback, not the /plan dead end', async () => {
		const repoRoot = createKernelDefaultRepo();
		try {
			// Seed through the SAME default kernel resolution the handler will use (no
			// explicit db path / gitCommonDir), so create and the status read share one store.
			const deps = { issueBackend: 'kernel' };
			const a = await runIssueOperation('create', ['--title', 'Kernel ready A', '--type', 'task'], repoRoot, deps);
			const b = await runIssueOperation('create', ['--title', 'Kernel ready B', '--type', 'task'], repoRoot, deps);
			expect(a.ok).toBe(true);
			expect(b.ok).toBe(true);

			const result = await statusCommand.handler([], {}, repoRoot);

			expect(result.success).toBe(true);
			expect(result.output).toContain('Ready: 2 more (forge issue ready)');
			// State-aware fallback names the top ready issue instead of the empty-state /plan.
			const claimMatch = result.output.match(/forge claim (\S+), then \/plan/);
			expect(claimMatch).not.toBeNull();
			expect([a.data.id, b.data.id]).toContain(claimMatch[1]);
			expect(result.output).not.toContain('no ready issues. Next: /plan');
		} finally {
			cleanup(repoRoot);
		}
	}, 30000);
});
