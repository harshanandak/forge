const { describe, test, expect } = require('bun:test');
const { pinLockContent, IMAGE_PINS } = require('../../scripts/pin-agentic-workflow-images.js');

describe('pin-agentic-workflow-images', () => {
	test('pins MCP runtime images in manifest and workflow body', () => {
		const content = [
			'# gh-aw-metadata: {}',
			'# gh-aw-manifest: {"version":1,"containers":[{"image":"ghcr.io/github/gh-aw-mcpg:v0.3.0"},{"image":"ghcr.io/github/github-mcp-server:v1.0.2"}]}',
			'#   - ghcr.io/github/gh-aw-mcpg:v0.3.0',
			'run: ghcr.io/github/github-mcp-server:v1.0.2 ghcr.io/github/gh-aw-mcpg:v0.3.0',
			'container: "ghcr.io/github/github-mcp-server:v1.0.2"',
		].join('\n');

		const pinned = pinLockContent(content);

		for (const pin of IMAGE_PINS) {
			expect(pinned).toContain(`"image":"${pin.image}"`);
			expect(pinned).toContain(`"digest":"${pin.digest}"`);
			expect(pinned).toContain(`"pinned_image":"${pin.pinnedImage}"`);
			expect(pinned).toContain(pin.pinnedImage);
		}

		expect(pinned.split('\n').slice(2).join('\n')).not.toContain('ghcr.io/github/gh-aw-mcpg:v0.3.0');
		expect(pinned.split('\n').slice(2).join('\n')).not.toContain('ghcr.io/github/github-mcp-server:v1.0.2');
	});
});
