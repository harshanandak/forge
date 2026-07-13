/* eslint-disable no-undef -- Bun globals are provided by the Bun runtime */
// Tests the canonical release asset-name mapping (scripts/lib/release-asset.mjs)
// for all seven published targets, and cross-checks that the shipping installer
// scripts/install.sh derives the SAME names via its hidden --print-asset mode.
// This is the drift guard between the JS contract and the shell implementation.

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { describe, test, expect } = require('bun:test');
const { resolveBashCommand } = require('../test/helpers/bash.js');
const {
	releaseAssetName,
	CANONICAL_ASSETS,
	SUPPORTED_OS,
	SUPPORTED_ARCH,
} = require('./lib/release-asset.mjs');

const INSTALL_SH = path.join(__dirname, 'install.sh');

// The exhaustive expected mapping: input platform -> asset filename, one row per
// canonical bun target in the CI matrix (build-binary.yml set-matrix step).
const EXPECTED = [
	{ os: 'windows', arch: 'x64', libc: undefined, asset: 'forge-windows-x64.exe' },
	{ os: 'darwin', arch: 'arm64', libc: undefined, asset: 'forge-darwin-arm64' },
	{ os: 'darwin', arch: 'x64', libc: undefined, asset: 'forge-darwin-x64' },
	{ os: 'linux', arch: 'x64', libc: 'glibc', asset: 'forge-linux-x64' },
	{ os: 'linux', arch: 'arm64', libc: 'glibc', asset: 'forge-linux-arm64' },
	{ os: 'linux', arch: 'x64', libc: 'musl', asset: 'forge-linux-x64-musl' },
	{ os: 'linux', arch: 'arm64', libc: 'musl', asset: 'forge-linux-arm64-musl' },
];

describe('releaseAssetName (canonical JS mapping)', () => {
	test('covers exactly the 7 published targets', () => {
		expect(EXPECTED).toHaveLength(7);
		expect(CANONICAL_ASSETS).toHaveLength(7);
	});

	for (const { os, arch, libc, asset } of EXPECTED) {
		test(`${os}/${arch}/${libc ?? 'n/a'} -> ${asset}`, () => {
			expect(releaseAssetName({ os, arch, libc })).toBe(asset);
		});
	}

	test('exported CANONICAL_ASSETS agrees with releaseAssetName()', () => {
		for (const row of CANONICAL_ASSETS) {
			expect(releaseAssetName(row)).toBe(row.asset);
		}
	});

	test('all asset names are unique', () => {
		const names = EXPECTED.map((e) => e.asset);
		expect(new Set(names).size).toBe(names.length);
	});

	test('linux libc defaults to glibc (undefined libc -> no -musl suffix)', () => {
		expect(releaseAssetName({ os: 'linux', arch: 'x64' })).toBe('forge-linux-x64');
	});

	test('rejects unsupported os', () => {
		expect(() => releaseAssetName({ os: 'plan9', arch: 'x64' })).toThrow(/Unsupported OS/);
	});

	test('rejects unsupported arch', () => {
		expect(() => releaseAssetName({ os: 'linux', arch: 'riscv' })).toThrow(/Unsupported arch/);
	});

	test('supported sets are as expected', () => {
		expect(SUPPORTED_OS).toEqual(['windows', 'darwin', 'linux']);
		expect(SUPPORTED_ARCH).toEqual(['x64', 'arm64']);
	});
});

// Drift guard: the shell installer must resolve the same asset names as the JS
// contract. install.sh --print-asset honors FORGE_OS/FORGE_ARCH/FORGE_LIBC so we
// can force each target regardless of the host we run the test on.
describe('install.sh --print-asset matches the JS mapping', () => {
	function shAsset(os, arch, libc) {
		return execFileSync(resolveBashCommand(), [INSTALL_SH, '--print-asset'], {
			env: {
				...process.env,
				FORGE_OS: os,
				FORGE_ARCH: arch,
				FORGE_LIBC: libc ?? 'none',
			},
			encoding: 'utf8',
		}).trim();
	}

	// Only the six non-Windows targets are installable by install.sh; the Windows
	// asset is covered by the JS mapping above and install.ps1.
	const UNIX = EXPECTED.filter((e) => e.os !== 'windows');

	for (const { os, arch, libc, asset } of UNIX) {
		test(`sh: ${os}/${arch}/${libc ?? 'n/a'} -> ${asset}`, () => {
			expect(shAsset(os, arch, libc)).toBe(asset);
		});
	}
});
