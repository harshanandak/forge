const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { PROTECTED_SURFACES } = require('../lib/protected-state-surfaces');

describe('protected state surface docs', () => {
	test('documents protected surfaces and is linked from the docs index', () => {
		const root = path.join(__dirname, '..');
		const docPath = path.join(root, 'docs', 'reference', 'protected-state-surfaces.md');
		const indexPath = path.join(root, 'docs', 'INDEX.md');
		const manifestPath = path.join(root, '.forge', 'protected-paths.yaml');
		const doc = fs.readFileSync(docPath, 'utf8');
		const index = fs.readFileSync(indexPath, 'utf8');
		const manifest = fs.readFileSync(manifestPath, 'utf8');

		for (const expected of [
			'beads_state',
			'forge_config',
			'generated_harness',
			'memory_projection',
			'workflows',
			'lockfiles',
			'extension_manifests',
			'secrets',
			'immutable',
			'append_only_logs',
			'repair hint',
			'Forge API',
		]) {
			expect(doc).toContain(expected);
		}

		expect(index).toContain('protected-state-surfaces.md');
		const manifestIds = Object.keys(YAML.parse(manifest).surfaces).sort();
		const runtimeIds = PROTECTED_SURFACES.map(surface => surface.id).sort();
		expect(manifestIds).toEqual(runtimeIds);
	});
});
