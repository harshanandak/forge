'use strict';

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FORGE_BIN = path.join(REPO_ROOT, 'bin', 'forge.js');

describe('bin/forge.js dispatch-safety — the shepherd trigger never affects the command', () => {
	test('STRUCTURAL: the trigger fires from a `finally` and is wrapped in a bare catch (a throwing tick can never break the command)', () => {
		const src = fs.readFileSync(FORGE_BIN, 'utf8');
		// The trigger call exists.
		expect(src).toContain('reconcile-executor');
		expect(src).toContain('fireAndForget');
		// It lives in a finally on the dispatch try, and is wrapped so a throw is swallowed.
		const idx = src.indexOf('fireAndForget');
		const around = src.slice(Math.max(0, idx - 900), idx + 200);
		expect(around).toMatch(/finally\s*\{/);
		expect(around).toMatch(/try\s*\{[\s\S]*fireAndForget[\s\S]*\}\s*catch/);
		// No `await` on the trigger — it must be non-blocking.
		expect(around).not.toMatch(/await[^\n]*fireAndForget/);
	});

	test('RUNTIME: a normal command still exits cleanly with the trigger attached (hermetic — non-git temp dir, no daemon spawn)', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws4b-dispatch-'));
		// `hooks session-start --harness nope` is a registry command that fail-opens to
		// empty output and exit 0. In a non-git dir the trigger's gitCommonDir resolve
		// throws and fireAndForget early-returns — so no lease, no daemon spawn.
		const res = spawnSync(process.execPath, [FORGE_BIN, 'hooks', 'session-start', '--harness', 'nope'], {
			cwd: dir, encoding: 'utf8', timeout: 30000, windowsHide: true,
			// Kill-switch keeps the trigger fully inert so the run spawns no daemon.
			env: { ...process.env, FORGE_SHEPHERD_DISABLE: '1' },
		});
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
		expect(res.status).toBe(0);
		// The trigger must not leak its own errors onto the command's streams.
		expect(String(res.stderr)).not.toMatch(/reconcile-executor|fireAndForget/);
	});
});
