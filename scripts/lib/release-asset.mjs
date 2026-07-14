// Canonical GitHub Release asset-name mapping for the single-binary distribution
// (epic 6f11d483, Step 4 / issue 50afbc47). This is the SINGLE SOURCE OF TRUTH
// for how a detected platform (os / arch / libc) maps to the release asset that
// `scripts/install.sh` and `scripts/install.ps1` download.
//
// The CI workflow `.github/workflows/build-binary.yml` compiles seven canonical
// bun targets and publishes each to the GitHub Release under the names produced
// here. The install scripts re-derive the same name from the host platform, so
// this table is exercised by `scripts/release-asset.test.js` (which also
// cross-checks the shell script's own detection against it) to guarantee the two
// sides never drift.
//
// bun target            -> release asset
// bun-windows-x64        -> forge-windows-x64.exe
// bun-darwin-arm64       -> forge-darwin-arm64
// bun-darwin-x64         -> forge-darwin-x64
// bun-linux-x64          -> forge-linux-x64
// bun-linux-arm64        -> forge-linux-arm64
// bun-linux-x64-musl     -> forge-linux-x64-musl
// bun-linux-arm64-musl   -> forge-linux-arm64-musl

/** Operating systems we publish binaries for. */
export const SUPPORTED_OS = ['windows', 'darwin', 'linux'];
/** CPU architectures we publish binaries for. */
export const SUPPORTED_ARCH = ['x64', 'arm64'];

/**
 * Map a detected platform to its GitHub Release asset filename.
 *
 * @param {object} p
 * @param {string} p.os    - 'windows' | 'darwin' | 'linux'
 * @param {string} p.arch  - 'x64' | 'arm64'
 * @param {string} [p.libc] - 'glibc' | 'musl' (linux only; ignored elsewhere)
 * @returns {string} asset filename, e.g. 'forge-linux-x64-musl' or 'forge-windows-x64.exe'
 * @throws {Error} on an unsupported os/arch combination
 */
export function releaseAssetName({ os, arch, libc } = {}) {
	if (!SUPPORTED_OS.includes(os)) {
		throw new Error(`Unsupported OS: ${os} (supported: ${SUPPORTED_OS.join(', ')})`);
	}
	if (!SUPPORTED_ARCH.includes(arch)) {
		throw new Error(`Unsupported arch: ${arch} (supported: ${SUPPORTED_ARCH.join(', ')})`);
	}
	// Reject os/arch pairs that are not actually published. The independent
	// allowlists above would otherwise accept e.g. windows/arm64 and invent a
	// `forge-windows-arm64.exe` asset that no release contains. Validate the
	// tuple against the canonical matrix (windows is x64-only) so JS, install.sh
	// and install.ps1 all agree on the same supported set.
	if (!PUBLISHED_OS_ARCH.has(`${os}/${arch}`)) {
		throw new Error(
			`Unsupported platform: ${os}/${arch} is not a published target ` +
				`(supported: ${[...PUBLISHED_OS_ARCH].join(', ')})`,
		);
	}
	let name = `forge-${os}-${arch}`;
	if (os === 'linux' && libc === 'musl') {
		name += '-musl';
	}
	if (os === 'windows') {
		name += '.exe';
	}
	return name;
}

/**
 * The full set of seven canonical assets, in the same order as the CI matrix.
 * Exported for tests and for anyone enumerating the published release.
 */
export const CANONICAL_ASSETS = [
	{ os: 'windows', arch: 'x64', libc: undefined, asset: 'forge-windows-x64.exe' },
	{ os: 'darwin', arch: 'arm64', libc: undefined, asset: 'forge-darwin-arm64' },
	{ os: 'darwin', arch: 'x64', libc: undefined, asset: 'forge-darwin-x64' },
	{ os: 'linux', arch: 'x64', libc: 'glibc', asset: 'forge-linux-x64' },
	{ os: 'linux', arch: 'arm64', libc: 'glibc', asset: 'forge-linux-arm64' },
	{ os: 'linux', arch: 'x64', libc: 'musl', asset: 'forge-linux-x64-musl' },
	{ os: 'linux', arch: 'arm64', libc: 'musl', asset: 'forge-linux-arm64-musl' },
];

/**
 * The set of published `os/arch` tuples, derived from CANONICAL_ASSETS so it can
 * never drift from the actual release matrix. Used by releaseAssetName() to
 * reject unsupported combinations (e.g. windows/arm64).
 */
export const PUBLISHED_OS_ARCH = new Set(CANONICAL_ASSETS.map((a) => `${a.os}/${a.arch}`));
