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
	// Only x64 exists for Windows and only arm64/x64 for the rest — but every
	// os/arch pair in the matrix below is real, so no further pruning is needed.
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
