#!/usr/bin/env node
'use strict';

const path = require('node:path');
const {
	buildProtectedPathManifestEvidence,
	loadProtectedPathManifest,
} = require('../../lib/protected-path-manifest');

const root = path.resolve(__dirname, '..', '..');
const manifestPath = path.join(root, '.forge', 'protected-paths.yaml');

try {
	const manifest = loadProtectedPathManifest(manifestPath);
	process.stdout.write(`${JSON.stringify(buildProtectedPathManifestEvidence(manifest), null, 2)}\n`);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`Failed to build protected path manifest evidence from ${manifestPath}: ${message}\n`);
	process.exit(1);
}
