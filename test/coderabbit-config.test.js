const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const CONFIG_PATH = path.join(__dirname, '..', '.coderabbit.yaml');

function loadConfig() {
	return yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

describe('.coderabbit.yaml', () => {
	test('parses as YAML and keeps auto review enabled', () => {
		const config = loadConfig();

		expect(typeof config).toBe('object');
		expect(config.reviews.auto_review.enabled).toBe(true);
	});

	test('encodes the pre-user shipping regime for the reviewer', () => {
		const config = loadConfig();

		// The regime is advisory-by-default: only always-wrong findings block.
		expect(config.reviews.profile).toBe('chill');

		const tone = String(config.tone_instructions || '').toLowerCase();
		expect(tone).toContain('secret');
		expect(tone).toContain('injection');
		expect(tone).toContain('build');
		// The reviewer must never grow the PR; follow-ups go to their own issue.
		expect(tone).toContain('follow-up');
	});
});
