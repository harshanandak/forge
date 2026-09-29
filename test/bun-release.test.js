'use strict';

const { describe, expect, test } = require('bun:test');

const {
	BUN_LATEST_RELEASE_URL,
	compareStableVersions,
	isStableBunVersion,
	resolveLatestStableBun,
} = require('../lib/bun-release');

function jsonFetch(body, { ok = true, status = 200 } = {}) {
	const calls = [];
	const fetch = async (url, init) => {
		calls.push({ url, init });
		return { ok, status, json: async () => body };
	};
	return { fetch, calls };
}

describe('resolveLatestStableBun', () => {
	test('parses the stable version from the bun-vX.Y.Z tag of the latest release', async () => {
		const { fetch, calls } = jsonFetch({ tag_name: 'bun-v1.4.3', draft: false, prerelease: false });
		const result = await resolveLatestStableBun({ fetch, token: 'token-value' });
		expect(result).toEqual({
			version: '1.4.3',
			tag: 'bun-v1.4.3',
			releaseUrl: 'https://github.com/oven-sh/bun/releases/tag/bun-v1.4.3',
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(BUN_LATEST_RELEASE_URL);
		expect(BUN_LATEST_RELEASE_URL).toBe('https://api.github.com/repos/oven-sh/bun/releases/latest');
		expect(calls[0].init.headers.Authorization).toBe('Bearer token-value');
	});

	test('omits the Authorization header without a token', async () => {
		const { fetch, calls } = jsonFetch({ tag_name: 'bun-v1.4.3', draft: false, prerelease: false });
		await resolveLatestStableBun({ fetch });
		expect(calls[0].init.headers.Authorization).toBeUndefined();
	});

	test('rejects prerelease and draft releases', async () => {
		await expect(resolveLatestStableBun(jsonFetch({ tag_name: 'bun-v1.5.0', draft: false, prerelease: true })))
			.rejects.toThrow(/prerelease/);
		await expect(resolveLatestStableBun(jsonFetch({ tag_name: 'bun-v1.5.0', draft: true, prerelease: false })))
			.rejects.toThrow(/draft/);
	});

	test('fails closed on malformed release data', async () => {
		const malformed = [
			null,
			[],
			{},
			{ tag_name: 'v1.4.3', draft: false, prerelease: false },
			{ tag_name: 'bun-v1.4', draft: false, prerelease: false },
			{ tag_name: 'bun-v1.5.0-canary.1', draft: false, prerelease: false },
			{ tag_name: 'canary', draft: false, prerelease: false },
			{ tag_name: 'bun-v1.4.3', prerelease: false },
			{ tag_name: 'bun-v1.4.3', draft: false },
			{ tag_name: 'bun-v1.4.3', draft: 'false', prerelease: false },
		];
		for (const body of malformed) {
			await expect(resolveLatestStableBun(jsonFetch(body))).rejects.toThrow();
		}
		const unreadable = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } });
		await expect(resolveLatestStableBun({ fetch: unreadable })).rejects.toThrow(/bad json/);
	});

	test('rejects a fetch failure or a non-success response', async () => {
		const failing = async () => { throw new Error('network down'); };
		await expect(resolveLatestStableBun({ fetch: failing })).rejects.toThrow(/network down/);
		await expect(resolveLatestStableBun(jsonFetch({ message: 'rate limited' }, { ok: false, status: 403 })))
			.rejects.toThrow(/403/);
	});

	test('requires a fetch implementation', async () => {
		await expect(resolveLatestStableBun({ fetch: null })).rejects.toThrow(/fetch/);
	});
});

describe('stable Bun version helpers', () => {
	test('accepts only exact X.Y.Z versions', () => {
		expect(isStableBunVersion('1.4.2')).toBe(true);
		for (const value of ['1.4', '1.4.2-canary.1', 'v1.4.2', 'canary', 'latest', '1.4.2 ', '', null, 142]) {
			expect(isStableBunVersion(value)).toBe(false);
		}
	});

	test('compares versions numerically, not lexically', () => {
		expect(compareStableVersions('1.10.0', '1.9.9')).toBe(1);
		expect(compareStableVersions('1.4.2', '1.4.2')).toBe(0);
		expect(compareStableVersions('1.4.2', '2.0.0')).toBe(-1);
		expect(() => compareStableVersions('1.4', '1.4.2')).toThrow();
	});
});
