const { describe, expect, test } = require('bun:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..', '..');

function readDoc(relPath) {
	return readFileSync(join(ROOT, relPath), 'utf8');
}

describe('Kernel conflict evaluator docs', () => {
	test('links the conflict evaluator reference from the documentation index', () => {
		const index = readDoc('docs/INDEX.md');

		expect(index).toContain('reference/kernel-conflict-evaluators.md');
		expect(index).toContain('Kernel conflict evaluators');
	});

	test('documents quarantine, idempotency, dedupe, and projection ordering', () => {
		const doc = readDoc('docs/reference/kernel-conflict-evaluators.md');

		expect(doc).toContain('Quarantined writes insert `kernel_conflicts` records');
		expect(doc).toContain('Duplicate idempotency keys return the original accepted event');
		expect(doc).toContain('Equivalent duplicate writes dedupe');
		expect(doc).toContain('Enqueue projection outbox rows only after event acceptance');
		expect(doc).toContain('Fixture cases cover import fidelity');
	});
});
