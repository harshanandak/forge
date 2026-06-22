'use strict';

const { describe, expect, test } = require('bun:test');

const {
	classifyFromSignals,
	classifyFilesystem,
	gatherSignals,
	assertFilesystemSafeForKernel,
	isUnsafeFsOverrideActive,
	defaultProbeDriveType,
	parseNetUseDriveType,
	parseDisplayRoot,
	REMEDIATION,
} = require('../../lib/kernel/fs-class');

const T = 3000;

describe('classifyFromSignals — win32', () => {
	test('UNC path classifies as network-unc / refuse', () => {
		const c = classifyFromSignals({
			platform: 'win32',
			absPath: '\\\\server\\share\\repo\\kernel.sqlite',
			env: {},
			homedir: 'C:\\Users\\x',
			isUNC: true,
			driveType: null,
		});
		expect(c.class).toBe('network-unc');
		expect(c.riskTier).toBe('refuse');
	}, T);

	test('mapped network drive (driveType network) → mapped-network-drive / refuse', () => {
		const c = classifyFromSignals({
			platform: 'win32',
			absPath: 'Z:\\repo\\kernel.sqlite',
			env: {},
			homedir: 'C:\\Users\\x',
			isUNC: false,
			driveType: 'network',
		});
		expect(c.class).toBe('mapped-network-drive');
		expect(c.riskTier).toBe('refuse');
	}, T);

	test('env.OneDriveCommercial prefix → onedrive / refuse', () => {
		const c = classifyFromSignals({
			platform: 'win32',
			absPath: 'C:\\Users\\x\\OneDrive - Contoso\\forge\\kernel.sqlite',
			env: { OneDriveCommercial: 'C:\\Users\\x\\OneDrive - Contoso' },
			homedir: 'C:\\Users\\x',
			isUNC: false,
			driveType: 'fixed',
		});
		expect(c.class).toBe('onedrive');
		expect(c.riskTier).toBe('refuse');
	}, T);

	test('OneDrive - Contoso path segment (no env) → onedrive', () => {
		const c = classifyFromSignals({
			platform: 'win32',
			absPath: 'D:\\Sync\\OneDrive - Contoso\\forge\\kernel.sqlite',
			env: {},
			homedir: 'C:\\Users\\x',
			isUNC: false,
			driveType: 'fixed',
		});
		expect(c.class).toBe('onedrive');
	}, T);

	test('Dropbox segment → dropbox / refuse', () => {
		const c = classifyFromSignals({
			platform: 'win32',
			absPath: 'C:\\Users\\x\\Dropbox\\forge\\kernel.sqlite',
			env: {},
			homedir: 'C:\\Users\\x',
			isUNC: false,
			driveType: 'fixed',
		});
		expect(c.class).toBe('dropbox');
		expect(c.riskTier).toBe('refuse');
	}, T);

	test('Google Drive segment → gdrive / refuse', () => {
		const c = classifyFromSignals({
			platform: 'win32',
			absPath: 'G:\\My Drive\\Google Drive\\forge\\kernel.sqlite',
			env: {},
			homedir: 'C:\\Users\\x',
			isUNC: false,
			driveType: 'fixed',
		});
		expect(c.class).toBe('gdrive');
		expect(c.riskTier).toBe('refuse');
	}, T);

	test('plain C:\\dev\\repo → local-ok / safe', () => {
		const c = classifyFromSignals({
			platform: 'win32',
			absPath: 'C:\\dev\\repo\\.git\\forge\\kernel.sqlite',
			env: {},
			homedir: 'C:\\Users\\x',
			isUNC: false,
			driveType: 'fixed',
		});
		expect(c.class).toBe('local-ok');
		expect(c.riskTier).toBe('safe');
	}, T);

	test('Downloads path with NO OneDrive env → local-ok (no false positive)', () => {
		const c = classifyFromSignals({
			platform: 'win32',
			absPath: 'C:\\Users\\x\\Downloads\\forge\\.git\\forge\\kernel.sqlite',
			env: {},
			homedir: 'C:\\Users\\x',
			isUNC: false,
			driveType: 'fixed',
		});
		expect(c.class).toBe('local-ok');
	}, T);

	test('Downloads redirected under OneDrive env → onedrive', () => {
		const c = classifyFromSignals({
			platform: 'win32',
			absPath: 'C:\\Users\\x\\OneDrive\\Downloads\\forge\\kernel.sqlite',
			env: { OneDrive: 'C:\\Users\\x\\OneDrive' },
			homedir: 'C:\\Users\\x',
			isUNC: false,
			driveType: 'fixed',
		});
		expect(c.class).toBe('onedrive');
	}, T);

	test('OneDrive env prefix is boundary-aware (OneDriveBackup is NOT onedrive)', () => {
		const c = classifyFromSignals({
			platform: 'win32',
			absPath: 'C:\\Users\\x\\OneDriveBackup\\forge\\kernel.sqlite',
			env: { OneDrive: 'C:\\Users\\x\\OneDrive' },
			homedir: 'C:\\Users\\x',
			isUNC: false,
			driveType: 'fixed',
		});
		expect(c.class).toBe('local-ok');
	}, T);

	test('driveType unknown (probe miss) does NOT suppress OneDrive env detection → onedrive / refuse', () => {
		// Drive probe failed (G1 fallback) BUT the path is positively under the
		// OneDrive sync root. Cloud detection is path/env-based and independent of
		// the drive probe; it must still fire and REFUSE (never downgrade to warn).
		const c = classifyFromSignals({
			platform: 'win32',
			absPath: 'C:\\Users\\x\\OneDrive\\forge\\kernel.sqlite',
			env: { OneDrive: 'C:\\Users\\x\\OneDrive' },
			homedir: 'C:\\Users\\x',
			isUNC: false,
			driveType: 'unknown',
		});
		expect(c.class).toBe('onedrive');
		expect(c.riskTier).toBe('refuse');
	}, T);

	test('driveType unknown (probe miss) does NOT suppress Dropbox segment detection → dropbox / refuse', () => {
		const c = classifyFromSignals({
			platform: 'win32',
			absPath: 'C:\\Users\\x\\Dropbox\\forge\\kernel.sqlite',
			env: {},
			homedir: 'C:\\Users\\x',
			isUNC: false,
			driveType: 'unknown',
		});
		expect(c.class).toBe('dropbox');
		expect(c.riskTier).toBe('refuse');
	}, T);

	test('driveType unknown (probe miss) on plain letter → unknown / warn (fail-open)', () => {
		const c = classifyFromSignals({
			platform: 'win32',
			absPath: 'Z:\\repo\\kernel.sqlite',
			env: {},
			homedir: 'C:\\Users\\x',
			isUNC: false,
			driveType: 'unknown',
		});
		expect(c.class).toBe('unknown');
		expect(c.riskTier).toBe('warn');
	}, T);
});

describe('classifyFromSignals — darwin', () => {
	test('iCloud Mobile Documents → icloud / refuse', () => {
		const c = classifyFromSignals({
			platform: 'darwin',
			absPath: '/Users/x/Library/Mobile Documents/com~apple~CloudDocs/forge/kernel.sqlite',
			env: {},
			homedir: '/Users/x',
			isUNC: false,
			driveType: null,
		});
		expect(c.class).toBe('icloud');
		expect(c.riskTier).toBe('refuse');
	}, T);

	test('~/Dropbox → dropbox', () => {
		const c = classifyFromSignals({
			platform: 'darwin',
			absPath: '/Users/x/Dropbox/forge/kernel.sqlite',
			env: {},
			homedir: '/Users/x',
			isUNC: false,
			driveType: null,
		});
		expect(c.class).toBe('dropbox');
	}, T);

	test('~/Google Drive → gdrive', () => {
		const c = classifyFromSignals({
			platform: 'darwin',
			absPath: '/Users/x/Google Drive/forge/kernel.sqlite',
			env: {},
			homedir: '/Users/x',
			isUNC: false,
			driveType: null,
		});
		expect(c.class).toBe('gdrive');
	}, T);

	test('~/Library/CloudStorage/OneDrive-Contoso → onedrive', () => {
		const c = classifyFromSignals({
			platform: 'darwin',
			absPath: '/Users/x/Library/CloudStorage/OneDrive-Contoso/forge/kernel.sqlite',
			env: {},
			homedir: '/Users/x',
			isUNC: false,
			driveType: null,
		});
		expect(c.class).toBe('onedrive');
	}, T);

	test('plain ~/dev/repo → local-ok', () => {
		const c = classifyFromSignals({
			platform: 'darwin',
			absPath: '/Users/x/dev/repo/.git/forge/kernel.sqlite',
			env: {},
			homedir: '/Users/x',
			isUNC: false,
			driveType: null,
		});
		expect(c.class).toBe('local-ok');
	}, T);
});

describe('classifyFromSignals — linux / WSL', () => {
	test('WSL interop + /mnt/c → wsl-cross / warn', () => {
		const c = classifyFromSignals({
			platform: 'linux',
			absPath: '/mnt/c/Users/x/forge/kernel.sqlite',
			env: {},
			homedir: '/home/x',
			isUNC: false,
			driveType: null,
			mountFsType: 'drvfs',
			isWslInterop: true,
		});
		expect(c.class).toBe('wsl-cross');
		expect(c.riskTier).toBe('warn');
	}, T);

	test('cifs mount → network-unc / refuse', () => {
		const c = classifyFromSignals({
			platform: 'linux',
			absPath: '/mnt/share/forge/kernel.sqlite',
			env: {},
			homedir: '/home/x',
			isUNC: false,
			driveType: null,
			mountFsType: 'cifs',
			isWslInterop: false,
		});
		expect(c.class).toBe('network-unc');
		expect(c.riskTier).toBe('refuse');
	}, T);

	test('fuse.rclone mount → gdrive / refuse', () => {
		const c = classifyFromSignals({
			platform: 'linux',
			absPath: '/home/x/mnt/rclone/forge/kernel.sqlite',
			env: {},
			homedir: '/home/x',
			isUNC: false,
			driveType: null,
			mountFsType: 'fuse.rclone',
			isWslInterop: false,
		});
		expect(c.class).toBe('gdrive');
		expect(c.riskTier).toBe('refuse');
	}, T);

	test('native ext4 → local-ok', () => {
		const c = classifyFromSignals({
			platform: 'linux',
			absPath: '/home/x/dev/repo/.git/forge/kernel.sqlite',
			env: {},
			homedir: '/home/x',
			isUNC: false,
			driveType: null,
			mountFsType: 'ext4',
			isWslInterop: false,
		});
		expect(c.class).toBe('local-ok');
	}, T);
});

describe('classifyFromSignals — unknown / fail-open + non-path inputs', () => {
	test('unmatched platform → unknown / warn', () => {
		const c = classifyFromSignals({
			platform: 'sunos',
			absPath: '/weird/path/kernel.sqlite',
			env: {},
			homedir: '/home/x',
			isUNC: false,
			driveType: null,
		});
		expect(c.class).toBe('unknown');
		expect(c.riskTier).toBe('warn');
	}, T);

	test(':memory: classifies local-ok / safe', () => {
		const c = classifyFromSignals({
			platform: 'win32',
			absPath: ':memory:',
			env: {},
			homedir: 'C:\\Users\\x',
			isUNC: false,
			driveType: 'fixed',
		});
		expect(c.class).toBe('local-ok');
		expect(c.riskTier).toBe('safe');
	}, T);

	test('file: URI classifies local-ok / safe', () => {
		const c = classifyFromSignals({
			platform: 'linux',
			absPath: 'file:kernel?mode=memory',
			env: {},
			homedir: '/home/x',
			isUNC: false,
			driveType: null,
			mountFsType: 'ext4',
			isWslInterop: false,
		});
		expect(c.class).toBe('local-ok');
	}, T);

	test('empty path → local-ok / safe', () => {
		const c = classifyFromSignals({
			platform: 'win32',
			absPath: '',
			env: {},
			homedir: 'C:\\Users\\x',
			isUNC: false,
			driveType: 'fixed',
		});
		expect(c.class).toBe('local-ok');
	}, T);
});

describe('every Classification has a resolvable remediation', () => {
	test('refuse/warn classes resolve to non-empty REMEDIATION text', () => {
		const samples = [
			{ platform: 'win32', absPath: '\\\\s\\sh\\k.sqlite', env: {}, homedir: 'C:\\u', isUNC: true, driveType: null },
			{ platform: 'win32', absPath: 'Z:\\k.sqlite', env: {}, homedir: 'C:\\u', isUNC: false, driveType: 'network' },
			{ platform: 'win32', absPath: 'C:\\u\\OneDrive\\k.sqlite', env: { OneDrive: 'C:\\u\\OneDrive' }, homedir: 'C:\\u', isUNC: false, driveType: 'fixed' },
			{ platform: 'darwin', absPath: '/Users/x/Library/Mobile Documents/k.sqlite', env: {}, homedir: '/Users/x', isUNC: false, driveType: null },
			{ platform: 'linux', absPath: '/mnt/c/k.sqlite', env: {}, homedir: '/home/x', isUNC: false, driveType: null, mountFsType: 'drvfs', isWslInterop: true },
		];
		for (const s of samples) {
			const c = classifyFromSignals(s);
			expect(typeof c.remediationKey).toBe('string');
			expect(c.remediationKey.length).toBeGreaterThan(0);
			expect(typeof REMEDIATION[c.remediationKey]).toBe('string');
			expect(REMEDIATION[c.remediationKey].length).toBeGreaterThan(0);
		}
	}, T);
});

describe('assertFilesystemSafeForKernel', () => {
	const refuseDeps = {
		classifyFilesystem: () => ({ class: 'onedrive', riskTier: 'refuse', signal: 'env', remediationKey: 'onedrive' }),
	};

	test('refuse class throws when override unset', () => {
		expect(() => assertFilesystemSafeForKernel('C:\\u\\OneDrive\\k.sqlite', {
			...refuseDeps,
			env: {},
		})).toThrow();
	}, T);

	test('refuse class does NOT throw with FORGE_KERNEL_ALLOW_UNSAFE_FS=1 (warns)', () => {
		const warnings = [];
		expect(() => assertFilesystemSafeForKernel('C:\\u\\OneDrive\\k.sqlite', {
			...refuseDeps,
			env: { FORGE_KERNEL_ALLOW_UNSAFE_FS: '1' },
			warn: msg => warnings.push(msg),
		})).not.toThrow();
		expect(warnings.length).toBeGreaterThan(0);
	}, T);

	test('warn class never throws', () => {
		const warnings = [];
		expect(() => assertFilesystemSafeForKernel('/mnt/c/k.sqlite', {
			classifyFilesystem: () => ({ class: 'wsl-cross', riskTier: 'warn', signal: 'wsl', remediationKey: 'wsl-cross' }),
			env: {},
			warn: msg => warnings.push(msg),
		})).not.toThrow();
		expect(warnings.length).toBeGreaterThan(0);
	}, T);

	test('safe class never throws and does not warn', () => {
		const warnings = [];
		expect(() => assertFilesystemSafeForKernel('C:\\dev\\repo\\k.sqlite', {
			classifyFilesystem: () => ({ class: 'local-ok', riskTier: 'safe', signal: 'none', remediationKey: 'local-ok' }),
			env: {},
			warn: msg => warnings.push(msg),
		})).not.toThrow();
		expect(warnings.length).toBe(0);
	}, T);
});

describe('isUnsafeFsOverrideActive — only "1"/"true" enable the override (M4)', () => {
	test('"1" → active', () => {
		expect(isUnsafeFsOverrideActive({ FORGE_KERNEL_ALLOW_UNSAFE_FS: '1' })).toBe(true);
	}, T);

	test('"true"/"TRUE" (case-insensitive) → active', () => {
		expect(isUnsafeFsOverrideActive({ FORGE_KERNEL_ALLOW_UNSAFE_FS: 'true' })).toBe(true);
		expect(isUnsafeFsOverrideActive({ FORGE_KERNEL_ALLOW_UNSAFE_FS: 'TRUE' })).toBe(true);
	}, T);

	test('"0" → NOT active (truthy-string bug regression)', () => {
		expect(isUnsafeFsOverrideActive({ FORGE_KERNEL_ALLOW_UNSAFE_FS: '0' })).toBe(false);
	}, T);

	test('"false" → NOT active', () => {
		expect(isUnsafeFsOverrideActive({ FORGE_KERNEL_ALLOW_UNSAFE_FS: 'false' })).toBe(false);
	}, T);

	test('unset / empty → NOT active', () => {
		expect(isUnsafeFsOverrideActive({})).toBe(false);
		expect(isUnsafeFsOverrideActive({ FORGE_KERNEL_ALLOW_UNSAFE_FS: '' })).toBe(false);
	}, T);
});

describe('assertFilesystemSafeForKernel — override env honors "1"/"true" only (M4)', () => {
	const refuseDeps = {
		classifyFilesystem: () => ({ class: 'onedrive', riskTier: 'refuse', signal: 'env', remediationKey: 'onedrive' }),
	};

	test('refuse class with FORGE_KERNEL_ALLOW_UNSAFE_FS=0 STILL throws (override not applied)', () => {
		expect(() => assertFilesystemSafeForKernel('C:\\u\\OneDrive\\k.sqlite', {
			...refuseDeps,
			env: { FORGE_KERNEL_ALLOW_UNSAFE_FS: '0' },
		})).toThrow();
	}, T);

	test('refuse class with FORGE_KERNEL_ALLOW_UNSAFE_FS=false STILL throws', () => {
		expect(() => assertFilesystemSafeForKernel('C:\\u\\OneDrive\\k.sqlite', {
			...refuseDeps,
			env: { FORGE_KERNEL_ALLOW_UNSAFE_FS: 'false' },
		})).toThrow();
	}, T);
});

describe('gatherSignals — injected probes (no real FS) + G1 fallback', () => {
	test('win32: probeDriveType returning network yields driveType network', () => {
		const s = gatherSignals('Z:\\repo\\kernel.sqlite', {
			platform: 'win32',
			env: {},
			homedir: () => 'C:\\Users\\x',
			probeDriveType: () => 'network',
		});
		expect(s.platform).toBe('win32');
		expect(s.driveType).toBe('network');
		expect(s.isUNC).toBe(false);
	}, T);

	test('win32 UNC path flags isUNC without probing a drive letter', () => {
		const s = gatherSignals('\\\\server\\share\\kernel.sqlite', {
			platform: 'win32',
			env: {},
			homedir: () => 'C:\\Users\\x',
			probeDriveType: () => { throw new Error('should not probe UNC'); },
		});
		expect(s.isUNC).toBe(true);
	}, T);

	test('G1: probeDriveType THROWS → driveType unknown (fail-safe fallback, never refuse)', () => {
		const s = gatherSignals('Z:\\repo\\kernel.sqlite', {
			platform: 'win32',
			env: {},
			homedir: () => 'C:\\Users\\x',
			probeDriveType: () => { throw new Error('net use failed'); },
		});
		expect(s.driveType).toBe('unknown');
		const c = classifyFromSignals(s);
		expect(c.class).toBe('unknown');
		expect(c.riskTier).toBe('warn');
	}, T);

	test('linux: probeMounts/readWslInterop injected', () => {
		const s = gatherSignals('/mnt/c/repo/kernel.sqlite', {
			platform: 'linux',
			env: {},
			homedir: () => '/home/x',
			probeMounts: () => 'drvfs',
			readWslInterop: () => true,
		});
		expect(s.mountFsType).toBe('drvfs');
		expect(s.isWslInterop).toBe(true);
	}, T);

	test('linux: probeMounts THROWS → mountProbeThrew set → unknown/warn (M3, symmetric w/ win32)', () => {
		const s = gatherSignals('/srv/data/kernel.sqlite', {
			platform: 'linux',
			env: {},
			homedir: () => '/home/x',
			probeMounts: () => { throw new Error('cannot read /proc/mounts'); },
			readWslInterop: () => false,
		});
		expect(s.mountFsType).toBeNull();
		expect(s.mountProbeThrew).toBe(true);
		// A THROWN probe must NOT silently fail-open to local-ok; it is unknown/warn.
		const c = classifyFromSignals(s);
		expect(c.class).toBe('unknown');
		expect(c.riskTier).toBe('warn');
	}, T);

	test('linux: probeMounts returns null with NO match → local-ok (no warn)', () => {
		// Distinct from a throw: the probe ran fine and simply matched no network/cloud
		// mount. This is genuinely a local path and must stay local-ok / safe.
		const s = gatherSignals('/srv/data/kernel.sqlite', {
			platform: 'linux',
			env: {},
			homedir: () => '/home/x',
			probeMounts: () => null,
			readWslInterop: () => false,
		});
		expect(s.mountFsType).toBeNull();
		expect(s.mountProbeThrew).toBe(false);
		const c = classifyFromSignals(s);
		expect(c.class).toBe('local-ok');
		expect(c.riskTier).toBe('safe');
	}, T);
});

describe('classifyLinux — mountProbeThrew distinguishes threw vs no-match (M3)', () => {
	test('mountProbeThrew=true with no other signal → unknown / warn', () => {
		const c = classifyFromSignals({
			platform: 'linux',
			absPath: '/srv/data/kernel.sqlite',
			env: {},
			homedir: '/home/x',
			isUNC: false,
			driveType: null,
			mountFsType: null,
			isWslInterop: false,
			mountProbeThrew: true,
		});
		expect(c.class).toBe('unknown');
		expect(c.riskTier).toBe('warn');
	}, T);

	test('mountProbeThrew=true STILL yields a cloud class when a path segment matches (path signal survives)', () => {
		const c = classifyFromSignals({
			platform: 'linux',
			absPath: '/home/x/Dropbox/forge/kernel.sqlite',
			env: {},
			homedir: '/home/x',
			isUNC: false,
			driveType: null,
			mountFsType: null,
			isWslInterop: false,
			mountProbeThrew: true,
		});
		expect(c.class).toBe('dropbox');
		expect(c.riskTier).toBe('refuse');
	}, T);

	test('mountProbeThrew=true STILL yields network-unc when a mount fs type was found', () => {
		// Defensive: even if a throw flag is set, a concrete network fs wins over unknown.
		const c = classifyFromSignals({
			platform: 'linux',
			absPath: '/mnt/share/forge/kernel.sqlite',
			env: {},
			homedir: '/home/x',
			isUNC: false,
			driveType: null,
			mountFsType: 'cifs',
			isWslInterop: false,
			mountProbeThrew: true,
		});
		expect(c.class).toBe('network-unc');
		expect(c.riskTier).toBe('refuse');
	}, T);
});

describe('defaultProbeDriveType — bounded exec (B1) + canned-stdout parsing (M5)', () => {
	test('B1: both net use and PowerShell execs pass timeout=1500 + killSignal SIGKILL', () => {
		const seenOptions = [];
		const fakeExec = (_file, _args, options) => {
			seenOptions.push(options);
			// Return empty so net use misses and the PowerShell fallback also runs,
			// exercising BOTH exec calls in one probe.
			return '';
		};
		const result = defaultProbeDriveType('Z:', { execFileSync: fakeExec });
		// Both probes ran (net use, then PowerShell DisplayRoot).
		expect(seenOptions.length).toBe(2);
		for (const options of seenOptions) {
			expect(options.timeout).toBe(1500);
			expect(options.killSignal).toBe('SIGKILL');
			// The pre-existing encoding option must be preserved.
			expect(options.encoding).toBe('utf8');
		}
		// No network backing detected → fixed.
		expect(result).toBe('fixed');
	}, T);

	test('B1: a hanging exec that throws (timeout-style) propagates so gather maps it to unknown/warn', () => {
		// execFileSync with { timeout } throws on a hang; the probe does NOT catch it.
		// gatherSignals catches and maps to driveType=unknown → warn (symmetric w/ G1).
		const hangingExec = () => { throw new Error('spawnSync net ETIMEDOUT'); };
		const s = gatherSignals('Z:\\repo\\kernel.sqlite', {
			platform: 'win32',
			env: {},
			homedir: () => 'C:\\Users\\x',
			probeDriveType: letter => defaultProbeDriveType(letter, { execFileSync: hangingExec }),
		});
		expect(s.driveType).toBe('unknown');
		const c = classifyFromSignals(s);
		expect(c.class).toBe('unknown');
		expect(c.riskTier).toBe('warn');
	}, T);

	test('M5: parseNetUseDriveType detects a mapped letter from real net use stdout', () => {
		const stdout = [
			'New connections will be remembered.',
			'',
			'Status       Local     Remote                    Network',
			'-------------------------------------------------------------------------------',
			'OK           Z:        \\\\fileserver\\team        Microsoft Windows Network',
			'OK           Y:        \\\\nas\\backups            Microsoft Windows Network',
			'The command completed successfully.',
			'',
		].join('\r\n');
		expect(parseNetUseDriveType(stdout, 'Z:')).toBe('network');
		expect(parseNetUseDriveType(stdout, 'Y:')).toBe('network');
	}, T);

	test('M5: parseNetUseDriveType returns null when the letter is absent', () => {
		const stdout = [
			'Status       Local     Remote                    Network',
			'OK           Y:        \\\\nas\\backups            Microsoft Windows Network',
			'The command completed successfully.',
		].join('\r\n');
		expect(parseNetUseDriveType(stdout, 'Z:')).toBeNull();
		// Must not partial-match (e.g. a line mentioning Z elsewhere).
		expect(parseNetUseDriveType('OK  AZ:  ...', 'Z:')).toBeNull();
	}, T);

	test('M5: parseDisplayRoot treats a non-empty DisplayRoot as network, empty/whitespace as null', () => {
		expect(parseDisplayRoot('\\\\fileserver\\share\r\n')).toBe('network');
		expect(parseDisplayRoot('   \r\n')).toBeNull();
		expect(parseDisplayRoot('')).toBeNull();
	}, T);

	test('M5: defaultProbeDriveType returns network when net use stdout lists the letter', () => {
		const stdout = 'OK           Z:        \\\\fileserver\\team        Microsoft Windows Network\r\n';
		const fakeExec = (file) => (file === 'net' ? stdout : '');
		expect(defaultProbeDriveType('Z:', { execFileSync: fakeExec })).toBe('network');
	}, T);

	test('M5: defaultProbeDriveType returns network when PowerShell DisplayRoot is non-empty', () => {
		const fakeExec = (file) => (file === 'net' ? '' : '\\\\nas\\share\r\n');
		expect(defaultProbeDriveType('Z:', { execFileSync: fakeExec })).toBe('network');
	}, T);
});

describe('classifyFilesystem — end-to-end with injected probes', () => {
	test('win32 mapped drive via injected probe → mapped-network-drive / refuse', () => {
		const c = classifyFilesystem('Z:\\repo\\kernel.sqlite', {
			platform: 'win32',
			env: {},
			homedir: () => 'C:\\Users\\x',
			probeDriveType: () => 'network',
		});
		expect(c.class).toBe('mapped-network-drive');
		expect(c.riskTier).toBe('refuse');
	}, T);
});
