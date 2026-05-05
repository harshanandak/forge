#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_LOCK_FILES = [
	'.github/agentic-workflows/behavioral-test.lock.yml',
	'.github/workflows/behavioral-test.lock.yml',
];

const IMAGE_PINS = [
	{
		image: 'ghcr.io/github/gh-aw-mcpg:v0.3.0',
		digest: 'sha256:9c2228324fb1f26f39dc9471612e530ae3efc3156dac05efb2e8d212878d454d',
		pinnedImage: 'ghcr.io/github/gh-aw-mcpg@sha256:9c2228324fb1f26f39dc9471612e530ae3efc3156dac05efb2e8d212878d454d',
	},
	{
		image: 'ghcr.io/github/github-mcp-server:v1.0.2',
		digest: 'sha256:26db03408086a99cf1916348dcc4f9614206658f9082a8060dc7c81ad787f4ba',
		pinnedImage: 'ghcr.io/github/github-mcp-server@sha256:26db03408086a99cf1916348dcc4f9614206658f9082a8060dc7c81ad787f4ba',
	},
];

function updateManifestLine(line) {
	const prefix = '# gh-aw-manifest: ';
	if (!line.startsWith(prefix)) {
		return line;
	}

	const manifest = JSON.parse(line.slice(prefix.length));
	if (!Array.isArray(manifest.containers)) {
		return line;
	}

	manifest.containers = manifest.containers.map((container) => {
		const pin = IMAGE_PINS.find(candidate => candidate.image === container.image);
		if (!pin) {
			return container;
		}

		return {
			...container,
			digest: pin.digest,
			pinned_image: pin.pinnedImage,
		};
	});

	return `${prefix}${JSON.stringify(manifest)}`;
}

function pinLockContent(content) {
	const lines = content.split(/\r?\n/);
	if (lines.length > 1) {
		lines[1] = updateManifestLine(lines[1]);
	}

	let pinned = lines.join('\n');
	const manifestPrefix = /^# gh-aw-manifest: .*$/m;
	const manifestMatch = pinned.match(manifestPrefix);
	const manifestLine = manifestMatch ? manifestMatch[0] : null;
	pinned = pinned.replace(manifestPrefix, '__GH_AW_MANIFEST_PLACEHOLDER__');

	for (const pin of IMAGE_PINS) {
		pinned = pinned.split(pin.image).join(pin.pinnedImage);
	}

	if (manifestLine) {
		pinned = pinned.replace('__GH_AW_MANIFEST_PLACEHOLDER__', updateManifestLine(manifestLine));
	}

	return pinned;
}

function pinLockFile(filePath) {
	const original = fs.readFileSync(filePath, 'utf8');
	const pinned = pinLockContent(original);
	if (pinned !== original) {
		fs.writeFileSync(filePath, pinned, 'utf8');
		return true;
	}
	return false;
}

function main() {
	const args = process.argv.slice(2);
	const files = args.length > 0 ? args : DEFAULT_LOCK_FILES;
	const changed = [];

	for (const file of files) {
		const filePath = path.resolve(process.cwd(), file);
		if (pinLockFile(filePath)) {
			changed.push(file);
		}
	}

	if (changed.length === 0) {
		console.log('Agentic workflow runtime images already pinned');
		return;
	}

	console.log(`Pinned agentic workflow runtime images: ${changed.join(', ')}`);
}

if (require.main === module) {
	main();
}

module.exports = {
	IMAGE_PINS,
	pinLockContent,
	pinLockFile,
};
