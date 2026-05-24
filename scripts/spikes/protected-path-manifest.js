#!/usr/bin/env node
'use strict';

const path = require('node:path');
const {
	buildProtectedPathManifestEvidence,
	loadProtectedPathManifest,
} = require('../../lib/protected-path-manifest');

const root = path.resolve(__dirname, '..', '..');
const manifestPath = path.join(root, '.forge', 'protected-paths.yaml');
const manifest = loadProtectedPathManifest(manifestPath);

process.stdout.write(`${JSON.stringify(buildProtectedPathManifestEvidence(manifest), null, 2)}\n`);
