'use strict';

// D19 — Filesystem-class detector + default-on gate helper.
//
// Two layers (the split is the testability crux):
//   Layer A — classifyFromSignals(signals): PURE, zero I/O. 100% synthetic-tested.
//   Layer B — gatherSignals(absPath, deps): thin I/O shell, ALL probes injectable.
// Public entry: classifyFilesystem(absPath, deps) = classifyFromSignals(gatherSignals(...)).
//
// Scope discipline: this module reports the filesystem CLASS only. Broad health
// stays in runtime-health.js. See docs/work/2026-06-06-kernel-backlog-memory-roadmap/
// D19-filesystem-doctor-design.md.

const os = require('node:os');
const { execFileSync } = require('node:child_process');

// --- Remediation message table (remediationKey -> human text) ----------------

const OVERRIDE_LINE =
	'Override (NOT recommended): set FORGE_KERNEL_ALLOW_UNSAFE_FS=1 to proceed\n' +
	'at your own risk.';

const REMEDIATION = Object.freeze({
	'local-ok': 'No action needed — the kernel database is on a local fixed disk.',
	onedrive:
		'Forge kernel cannot place its SQLite database on a cloud-synced folder\n' +
		'(OneDrive). SQLite WAL mode corrupts when a sync client rewrites the\n' +
		'database mid-write.\n\n' +
		'Fix: move this repository outside the OneDrive folder, e.g. a non-synced\n' +
		'local path such as C:\\dev\\<repo>, then re-run.\n\n' +
		OVERRIDE_LINE,
	dropbox:
		'Forge kernel cannot place its SQLite database on a Dropbox-synced folder.\n' +
		'A sync client rewriting the DB mid-write corrupts SQLite WAL mode.\n\n' +
		'Fix: move this repository outside the Dropbox folder to a non-synced\n' +
		'local path, then re-run.\n\n' +
		OVERRIDE_LINE,
	gdrive:
		'Forge kernel cannot place its SQLite database on a Google Drive folder.\n' +
		'A sync/streaming client rewriting the DB mid-write corrupts SQLite WAL mode.\n\n' +
		'Fix: move this repository outside the Google Drive folder to a non-synced\n' +
		'local path, then re-run.\n\n' +
		OVERRIDE_LINE,
	icloud:
		'Forge kernel cannot place its SQLite database under iCloud Drive\n' +
		'(Library/Mobile Documents). iCloud may evict/rewrite the file and corrupt\n' +
		'SQLite WAL mode.\n\n' +
		'Fix: move this repository outside iCloud Drive to a non-synced local path,\n' +
		'then re-run.\n\n' +
		OVERRIDE_LINE,
	'network-unc':
		'Forge kernel cannot place its SQLite database on a network share\n' +
		'(UNC / SMB / NFS). SQLite file locking is unreliable over network\n' +
		'filesystems and can corrupt the database.\n\n' +
		'Fix: move this repository to a local fixed disk, then re-run.\n\n' +
		OVERRIDE_LINE,
	'mapped-network-drive':
		'Forge kernel cannot place its SQLite database on a mapped network drive.\n' +
		'SQLite file locking is unreliable over SMB/NFS and can corrupt the database.\n\n' +
		'Fix: move this repository to a local fixed disk, then re-run.\n\n' +
		OVERRIDE_LINE,
	'wsl-cross':
		'Warning: the kernel database lives on the Windows volume across the WSL\n' +
		'filesystem boundary (/mnt/<letter>). This works but is slow and has lock\n' +
		'edge cases. For best results, keep the repository on the Linux-native\n' +
		'filesystem (e.g. under your home directory).',
	unknown:
		'Warning: Forge could not classify the filesystem holding the kernel\n' +
		'database. Proceeding (fail-open). If you hit database corruption, ensure\n' +
		'the repository is on a local fixed disk (not cloud-synced or networked).',
});

// --- Risk-tier mapping (class -> tier) ---------------------------------------

const REFUSE_CLASSES = new Set([
	'onedrive',
	'dropbox',
	'gdrive',
	'icloud',
	'network-unc',
	'mapped-network-drive',
]);
const WARN_CLASSES = new Set(['wsl-cross', 'unknown']);

function riskTierFor(klass) {
	if (REFUSE_CLASSES.has(klass)) return 'refuse';
	if (WARN_CLASSES.has(klass)) return 'warn';
	return 'safe';
}

function makeClassification(klass, signal) {
	return {
		class: klass,
		riskTier: riskTierFor(klass),
		signal,
		remediationKey: klass,
	};
}

// --- Path helpers (pure) -----------------------------------------------------

// SQLite "paths" that never touch a real directory: in-memory and file: URIs.
function isNonFsPath(absPath) {
	if (!absPath) return true;
	if (absPath === ':memory:') return true;
	if (/^file:/i.test(absPath)) return true;
	return false;
}

// Split a path into lowercase segments on both separators (for segment matching).
function pathSegments(absPath) {
	return String(absPath)
		.split(/[\\/]+/)
		.filter(Boolean)
		.map(seg => seg.toLowerCase());
}

// Boundary-aware, case/separator-normalized prefix test. Returns true only when
// `root` covers `absPath` at a path boundary (avoids OneDrive vs OneDriveBackup).
function pathStartsWith(absPath, root, { caseInsensitive }) {
	if (!root) return false;
	const norm = value => {
		let v = String(value).replace(/[\\/]+/g, '/').replace(/\/+$/, '');
		if (caseInsensitive) v = v.toLowerCase();
		return v;
	};
	const a = norm(absPath);
	const r = norm(root);
	if (a === r) return true;
	return a.startsWith(`${r}/`);
}

function hasSegmentMatching(absPath, regex) {
	return pathSegments(absPath).some(seg => regex.test(seg));
}

function hasExactSegment(absPath, lowerName) {
	return pathSegments(absPath).includes(lowerName);
}

// --- Layer A: pure classifier ------------------------------------------------

function classifyWin32(signals) {
	const { absPath, env = {} } = signals;

	if (signals.isUNC) {
		return makeClassification('network-unc', String.raw`UNC path (\\server\share)`);
	}
	if (signals.driveType === 'network') {
		return makeClassification('mapped-network-drive', 'driveType=network');
	}

	// Cloud-sync detection is path/env-based and INDEPENDENT of the drive probe.
	// It must run BEFORE the driveType==='unknown' fail-open below, so a positively
	// identified OneDrive/Dropbox/gdrive path still REFUSES even when the mapped-
	// drive probe failed (G1 fallback). Otherwise the highest-risk class would be
	// silently downgraded to warn and the kernel would init on a synced folder.

	// OneDrive: env-declared sync roots (boundary-aware) OR a path segment.
	const oneDriveRoots = [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial]
		.filter(Boolean);
	for (const root of oneDriveRoots) {
		if (pathStartsWith(absPath, root, { caseInsensitive: true })) {
			return makeClassification('onedrive', 'env OneDrive root prefix');
		}
	}
	if (hasSegmentMatching(absPath, /^onedrive([ -].+)?$/i)) {
		return makeClassification('onedrive', 'OneDrive path segment');
	}

	if (env.Dropbox && pathStartsWith(absPath, env.Dropbox, { caseInsensitive: true })) {
		return makeClassification('dropbox', 'env Dropbox root prefix');
	}
	if (hasExactSegment(absPath, 'dropbox')) {
		return makeClassification('dropbox', 'Dropbox path segment');
	}

	if (hasSegmentMatching(absPath, /^(google ?drive|googledrive|drivefs)$/i)) {
		return makeClassification('gdrive', 'Google Drive path segment');
	}

	// Drive probe miss with no cloud signal: fail-open per G1 (warn, never block).
	if (signals.driveType === 'unknown') {
		return makeClassification('unknown', 'driveType probe returned unknown');
	}

	return makeClassification('local-ok', 'no cloud/network signal matched');
}

function classifyDarwin(signals) {
	const { absPath, homedir } = signals;
	const home = homedir || '';

	if (pathStartsWith(absPath, `${home}/Library/Mobile Documents`, { caseInsensitive: false })) {
		return makeClassification('icloud', 'iCloud Mobile Documents');
	}
	if (
		pathStartsWith(absPath, `${home}/Dropbox`, { caseInsensitive: false }) ||
		hasSegmentMatching(absPath, /^dropbox.*$/i) && absPath.includes('/Library/CloudStorage/')
	) {
		return makeClassification('dropbox', 'Dropbox folder');
	}
	if (
		pathStartsWith(absPath, `${home}/Google Drive`, { caseInsensitive: false }) ||
		hasSegmentMatching(absPath, /^googledrive.*$/i) && absPath.includes('/Library/CloudStorage/')
	) {
		return makeClassification('gdrive', 'Google Drive folder');
	}
	if (hasSegmentMatching(absPath, /^onedrive.*$/i) && absPath.includes('/Library/CloudStorage/')) {
		return makeClassification('onedrive', 'OneDrive CloudStorage folder');
	}

	return makeClassification('local-ok', 'no cloud signal matched');
}

const NETWORK_FS_TYPES = new Set(['cifs', 'smb3', 'smb', 'nfs', 'nfs4', 'fuse.sshfs']);
const FUSE_CLOUD_MAP = new Map([
	['fuse.dropbox', 'dropbox'],
	['fuse.rclone', 'gdrive'],
	['fuse.google-drive-ocamlfuse', 'gdrive'],
]);

function classifyLinux(signals) {
	const { absPath, mountFsType, isWslInterop } = signals;

	if (isWslInterop && /^\/mnt\/[a-z]\//i.test(absPath)) {
		return makeClassification('wsl-cross', 'WSL interop + /mnt/<letter>');
	}
	if (mountFsType && NETWORK_FS_TYPES.has(mountFsType)) {
		return makeClassification('network-unc', `network mount fs=${mountFsType}`);
	}
	if (mountFsType && FUSE_CLOUD_MAP.has(mountFsType)) {
		return makeClassification(FUSE_CLOUD_MAP.get(mountFsType), `fuse mount fs=${mountFsType}`);
	}
	// Secondary segment signal for cloud sync folders on native mounts. These are
	// PATH-based and remain valid even when the mount probe threw, so they run
	// BEFORE the unknown-on-throw fallback below.
	if (hasSegmentMatching(absPath, /^onedrive.*$/i)) {
		return makeClassification('onedrive', 'OneDrive path segment');
	}
	if (hasExactSegment(absPath, 'dropbox')) {
		return makeClassification('dropbox', 'Dropbox path segment');
	}
	if (hasSegmentMatching(absPath, /^(google ?drive)$/i)) {
		return makeClassification('gdrive', 'Google Drive path segment');
	}

	// M3: the mount probe THREW (could not read /proc/mounts) and no path/wsl signal
	// matched. Treat as unknown/warn — symmetric with win32's G1 fail-safe — instead
	// of silently returning local-ok, which would suppress the warning entirely.
	if (signals.mountProbeThrew) {
		return makeClassification('unknown', 'mount probe failed (could not classify)');
	}

	return makeClassification('local-ok', 'no cloud/network/wsl signal matched');
}

function classifyFromSignals(signals = {}) {
	if (isNonFsPath(signals.absPath)) {
		return makeClassification('local-ok', 'non-filesystem path (memory/uri)');
	}
	switch (signals.platform) {
		case 'win32':
			return classifyWin32(signals);
		case 'darwin':
			return classifyDarwin(signals);
		case 'linux':
			return classifyLinux(signals);
		default:
			return makeClassification('unknown', `unrecognized platform ${signals.platform}`);
	}
}

// --- Layer B: thin signal gatherer (all probes injectable) -------------------

function isUNC(absPath) {
	return /^[\\/]{2}[^\\/]/.test(String(absPath || ''));
}

function driveLetterOf(absPath) {
	const match = /^([a-z]):[\\/]/i.exec(String(absPath || ''));
	return match ? `${match[1].toUpperCase()}:` : null;
}

// Bounded exec options for the Windows drive probes. The timeout is the BLOCKER-1
// fix: execFileSync's try/catch only catches throws, never hangs, so an
// unresponsive `net use` / PowerShell (e.g. a wedged network redirector) would
// hang the whole process indefinitely. With a timeout, a hang becomes a throw
// that the gatherSignals catch turns into driveType='unknown' → warn (never
// refuse), symmetric with the G1 fail-safe. killSignal forces the child dead.
const WIN_PROBE_EXEC_OPTIONS = Object.freeze({
	encoding: 'utf8',
	timeout: 1500,
	killSignal: 'SIGKILL',
});

// PURE (M5): does `net use` stdout list this drive letter as a mapped (network)
// connection? Returns 'network' on a boundary-matched letter, else null. The
// regex is anchored to a line-leading "<letter>:" preceded by start/whitespace
// so a stray mention of the letter elsewhere cannot false-positive.
function parseNetUseDriveType(stdout, driveLetter) {
	const letter = String(driveLetter || '').replace(':', '');
	if (!letter) return null;
	const letterRe = new RegExp(String.raw`(^|\s)${letter}:\s`, 'i');
	for (const line of String(stdout || '').split(/\r?\n/)) {
		if (letterRe.test(line)) {
			return 'network';
		}
	}
	return null;
}

// PURE (M5): a non-empty PowerShell DisplayRoot means the PSDrive is backed by a
// network/remote root. Returns 'network' when non-blank, else null.
function parseDisplayRoot(stdout) {
	return String(stdout || '').trim() ? 'network' : null;
}

// Windows: detect whether a drive letter is a mapped network drive.
// FAIL-SAFE FALLBACK (locked decision G1, option a): try `net use`, then a
// PowerShell DisplayRoot fallback; on ANY probe failure (including a timeout-
// induced throw, per BLOCKER 1) the caller treats the result as 'unknown'.
// Probes use arg ARRAYS (no shell) so they remain injection-free.
function defaultProbeDriveType(driveLetter, deps = {}) {
	const exec = deps.execFileSync || execFileSync;

	// Primary: `net use` lists mapped drive letters (and their remote paths).
	const netOut = exec('net', ['use'], WIN_PROBE_EXEC_OPTIONS);
	if (parseNetUseDriveType(netOut, driveLetter) === 'network') {
		return 'network';
	}

	// Secondary: PowerShell DisplayRoot — non-empty for network-backed PSDrives.
	const psLetter = String(driveLetter).replace(':', '');
	const psCmd =
		`(Get-PSDrive -Name '${psLetter}' -ErrorAction SilentlyContinue).DisplayRoot`;
	const psOut = exec('powershell', ['-NoProfile', '-Command', psCmd], WIN_PROBE_EXEC_OPTIONS);
	if (parseDisplayRoot(psOut) === 'network') {
		return 'network';
	}

	// Letter exists, no network backing detected → fixed.
	return 'fixed';
}

// Linux: read /proc/mounts, return fs type of the longest mountpoint prefixing absPath.
function defaultProbeMounts(absPath, deps = {}) {
	const readFileSync = deps.readFileSync || require('node:fs').readFileSync;
	const raw = String(readFileSync('/proc/mounts', 'utf8') || '');
	let best = null;
	let bestLen = -1;
	for (const line of raw.split('\n')) {
		const parts = line.split(/\s+/);
		if (parts.length < 3) continue;
		const mountPoint = parts[1];
		const fsType = parts[2];
		if (
			(absPath === mountPoint || absPath.startsWith(`${mountPoint.replace(/\/$/, '')}/`)) &&
			mountPoint.length > bestLen
		) {
			best = fsType;
			bestLen = mountPoint.length;
		}
	}
	return best;
}

function defaultReadWslInterop(deps = {}) {
	const env = deps.env || process.env;
	if (env.WSL_DISTRO_NAME) return true;
	const readFileSync = deps.readFileSync || require('node:fs').readFileSync;
	const version = String(readFileSync('/proc/version', 'utf8') || '');
	return /microsoft/i.test(version);
}

function gatherSignals(absPath, deps = {}) {
	const platform = deps.platform || process.platform;
	const env = deps.env || process.env;
	const homedirFn = deps.homedir || os.homedir;
	const homedir = typeof homedirFn === 'function' ? homedirFn() : homedirFn;

	const signals = {
		platform,
		absPath,
		env,
		homedir,
		isUNC: isUNC(absPath),
		driveType: null,
		mountFsType: null,
		mountProbeThrew: false,
		isWslInterop: false,
	};

	if (platform === 'win32' && !signals.isUNC) {
		const driveLetter = driveLetterOf(absPath);
		if (driveLetter) {
			const probe = deps.probeDriveType || (letter => defaultProbeDriveType(letter, deps));
			try {
				signals.driveType = probe(driveLetter);
			} catch {
				// G1 fail-safe: any probe failure → unknown → warn (never refuse).
				signals.driveType = 'unknown';
			}
		}
	}

	if (platform === 'linux') {
		const probeMounts = deps.probeMounts || (p => defaultProbeMounts(p, deps));
		try {
			signals.mountFsType = probeMounts(absPath);
		} catch {
			// M3: a THROWN probe is distinct from a clean no-match. Record the throw so
			// classifyLinux maps it to unknown/warn (symmetric with win32) instead of
			// silently fail-opening to local-ok.
			signals.mountFsType = null;
			signals.mountProbeThrew = true;
		}
		const readWsl = deps.readWslInterop || (() => defaultReadWslInterop(deps));
		try {
			signals.isWslInterop = Boolean(readWsl());
		} catch {
			signals.isWslInterop = false;
		}
	}

	return signals;
}

function classifyFilesystem(absPath, deps = {}) {
	return classifyFromSignals(gatherSignals(absPath, deps));
}

// --- Default-on gate helper --------------------------------------------------

// The unsafe-FS override is a deliberate, explicit opt-in: only the strings "1"
// and "true" (case-insensitive) enable it. A truthy-but-disabling value such as
// "0" or "false" — which Boolean() would wrongly treat as enabled — leaves the
// refuse gate ACTIVE. Anything else (unset, "", "no", "off") is also not active.
function isUnsafeFsOverrideActive(env = {}) {
	const raw = env.FORGE_KERNEL_ALLOW_UNSAFE_FS;
	if (typeof raw !== 'string') return false;
	const value = raw.trim().toLowerCase();
	return value === '1' || value === 'true';
}

function assertFilesystemSafeForKernel(dbPath, deps = {}) {
	const env = deps.env || process.env;
	const warn = deps.warn || (msg => console.warn(msg));
	const classify = deps.classifyFilesystem || classifyFilesystem;

	const classification = classify(dbPath, deps);
	const remediation = REMEDIATION[classification.remediationKey] || REMEDIATION.unknown;

	if (classification.riskTier === 'safe') {
		return classification;
	}

	if (classification.riskTier === 'warn') {
		warn(`forge kernel filesystem warning (${classification.class}):\n${remediation}`);
		return classification;
	}

	// refuse
	const overrideActive = isUnsafeFsOverrideActive(env);
	if (overrideActive) {
		warn(
			`forge kernel filesystem REFUSE downgraded by FORGE_KERNEL_ALLOW_UNSAFE_FS ` +
			`(${classification.class}) — override active:\n${remediation}`,
		);
		return classification;
	}

	const error = new Error(
		`Forge kernel refuses to initialize on a ${classification.class} filesystem.\n\n` +
		`  Detected: ${classification.signal}\n` +
		`  Path:     ${dbPath}\n` +
		`  Class:    ${classification.class}\n\n` +
		`${remediation}`,
	);
	error.code = 'FORGE_KERNEL_UNSAFE_FS';
	error.classification = classification;
	throw error;
}

module.exports = {
	classifyFromSignals,
	gatherSignals,
	classifyFilesystem,
	assertFilesystemSafeForKernel,
	isUnsafeFsOverrideActive,
	defaultProbeDriveType,
	parseNetUseDriveType,
	parseDisplayRoot,
	REMEDIATION,
};
