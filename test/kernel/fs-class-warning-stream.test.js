'use strict';

// Kernel issue 83a06824: the filesystem advisory spammed every command (four
// times for `forge status` / `forge prime`, once per broker instance) and any
// leak onto stdout would corrupt the JSON envelope that `--json` consumers
// parse. These tests run the gate in a REAL child process — the default `warn`
// path, with nothing injected — so they pin the two guarantees that matter to a
// machine consumer: the advisory lands on stderr only, and it lands once.

const { describe, test, expect } = require('bun:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FS_CLASS = path.join(REPO_ROOT, 'lib', 'kernel', 'fs-class.js').replace(/\\/g, '\\\\');
const WARNING_MARKER = 'forge kernel filesystem warning';

// Assert the gate four times against one path — the `forge status` shape — using
// the module's OWN default warn (no `warn` dep), then print a JSON envelope on
// stdout exactly as a --json command would.
const SCRIPT = `
const fsClass = require('${FS_CLASS}');
const classifyFilesystem = () => ({
  class: 'unknown', riskTier: 'warn', signal: 'probe', remediationKey: 'unknown',
});
for (let i = 0; i < 4; i += 1) {
  fsClass.assertFilesystemSafeForKernel('C:\\\\dev\\\\repo\\\\kernel.sqlite', { env: {}, classifyFilesystem });
}
process.stdout.write(JSON.stringify({ ok: true, schema_version: 'forge.issue.v1' }));
`;

function runGate() {
	const result = spawnSync(process.execPath, ['-e', SCRIPT], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 20000,
	});
	if (result.status !== 0) {
		throw new Error(`gate script exited ${result.status}: ${(result.stderr || '').slice(0, 500)}`);
	}
	return result;
}

describe('filesystem warning stream discipline + dedupe (child process)', () => {
	test('the warning goes to stderr and NEVER to stdout', () => {
		const result = runGate();
		expect(result.stderr).toContain(WARNING_MARKER);
		expect(result.stdout).not.toContain(WARNING_MARKER);
	}, 30000);

	test('stdout stays a single parseable JSON envelope', () => {
		const result = runGate();
		const parsed = JSON.parse(result.stdout);
		expect(parsed.ok).toBe(true);
		expect(parsed.schema_version).toBe('forge.issue.v1');
	}, 30000);

	test('four gate runs in one process emit the warning exactly once', () => {
		const result = runGate();
		const occurrences = result.stderr.split(WARNING_MARKER).length - 1;
		expect(occurrences).toBe(1);
	}, 30000);
});
