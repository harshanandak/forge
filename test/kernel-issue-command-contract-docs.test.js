'use strict';

const { describe, expect, test } = require('bun:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');

function readDoc(relPath) {
	return readFileSync(join(ROOT, relPath), 'utf8');
}

describe('Kernel issue command contract docs', () => {
	test('links the issue command contract from the documentation index', () => {
		const index = readDoc('docs/INDEX.md');

		expect(index).toContain('reference/forge-kernel-issue-command-contract.md');
		expect(index).toContain('Forge Kernel issue command contract');
	});

	test('documents commands, schemas, exit codes, and revision/idempotency expectations', () => {
		const doc = readDoc('docs/reference/forge-kernel-issue-command-contract.md');

		for (const phrase of [
			'forge issue ready --json',
			'forge issue list --json',
			'forge issue show <id> --json',
			'forge issue search <query> --json',
			'forge issue stats --json',
			'forge issue create',
			'forge issue update',
			'forge issue close',
			'forge issue comment',
			'forge issue dep add',
			'forge issue dep remove',
			'forge claim <id>',
			'forge release <id>',
			'next_commands',
			'forge.issue.error.v1',
			'expected_revision',
			'idempotency',
		]) {
			expect(doc).toContain(phrase);
		}
	});
});
