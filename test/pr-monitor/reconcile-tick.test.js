'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { tick, RECONCILE_MIN_INTERVAL } = require('../../lib/pr-monitor/reconcile-tick');
const { STALE_MS } = require('../../lib/pr-monitor/shepherd-lease');

// W-S4 design §2: the debounce/cost guard. Cheap-path-first, three gates. It reads
// the lock + sentinel from disk (a temp dir here) but enumerate()/execute() are
// INJECTED spies so the whole guard runs with ZERO gh/SELECT/spawn. `now` is a fake
// clock. The sentinel file's mtime IS `last_enumerated_at` (no content).
const BASE = 1_700_000_000_000;

describe('reconcile tick() debounce (§2)', () => {
	let dir; // stands in for gitCommonDir
	let forgeDir;

	function lockPath() { return path.join(forgeDir, 'shepherd.lock'); }
	function sentinelPath() { return path.join(forgeDir, 'shepherd.reconcile'); }

	function writeLock({ heartbeatAgoMs }) {
		const payload = { pid: 1234, token: 't', startedAt: new Date(BASE - heartbeatAgoMs).toISOString(), heartbeatAt: new Date(BASE - heartbeatAgoMs).toISOString(), watchers: [] };
		fs.writeFileSync(lockPath(), JSON.stringify(payload));
	}
	function writeSentinelAgo(ms) {
		fs.writeFileSync(sentinelPath(), '');
		const secs = (BASE - ms) / 1000;
		fs.utimesSync(sentinelPath(), secs, secs);
	}
	function makeSpies() {
		const calls = { enumerate: 0, execute: 0 };
		return {
			calls,
			now: () => BASE,
			enumerate: () => { calls.enumerate += 1; return { desired: { gitCommonDir: dir, openPrs: [] }, observed: { lease: null, prRows: [], liveWatcherPids: [] } }; },
			execute: () => { calls.execute += 1; },
		};
	}

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tick-'));
		forgeDir = path.join(dir, 'forge');
		fs.mkdirSync(forgeDir, { recursive: true });
	});
	afterEach(() => {
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
		delete process.env.FORGE_RECONCILE_MIN_INTERVAL;
	});

	test('RECONCILE_MIN_INTERVAL default is 60000', () => {
		expect(RECONCILE_MIN_INTERVAL).toBe(60000);
	});

	// MAKE-OR-BREAK: a fresh lease (a live daemon heart-beating) means the tick does
	// NOTHING — zero gh/SELECT/enumerate calls. G1 short-circuits before any stat.
	test('fresh lease (heartbeat now-5s) → ZERO enumerate/execute calls', () => {
		writeLock({ heartbeatAgoMs: 5000 });
		const s = makeSpies();

		const result = tick({ gitCommonDir: dir, now: s.now, enumerate: s.enumerate, execute: s.execute });

		expect(s.calls.enumerate).toBe(0);
		expect(s.calls.execute).toBe(0);
		expect(result.path).toBe('G1');
		// G1 must not even create the sentinel.
		expect(fs.existsSync(sentinelPath())).toBe(false);
		// Sanity: the lease really is fresh under STALE_MS.
		expect(5000).toBeLessThan(STALE_MS);
	});

	test('stale lease + sentinel now-90s → enumerate runs exactly once, sentinel bumped', () => {
		writeLock({ heartbeatAgoMs: STALE_MS + 10000 }); // 40s > 30s → stale
		writeSentinelAgo(90000);
		const s = makeSpies();

		const result = tick({ gitCommonDir: dir, now: s.now, enumerate: s.enumerate, execute: s.execute });

		expect(result.path).toBe('G3');
		expect(s.calls.enumerate).toBe(1);
		expect(s.calls.execute).toBe(1);
		// Sentinel mtime bumped to `now` (throttle stamped before the expensive work).
		const mtimeMs = fs.statSync(sentinelPath()).mtimeMs;
		expect(Math.abs(mtimeMs - BASE)).toBeLessThan(1000);
	});

	test('stale lease + sentinel now-10s → NO enumeration (window not elapsed)', () => {
		writeLock({ heartbeatAgoMs: STALE_MS + 10000 });
		writeSentinelAgo(10000);
		const s = makeSpies();

		const result = tick({ gitCommonDir: dir, now: s.now, enumerate: s.enumerate, execute: s.execute });

		expect(result.path).toBe('G2');
		expect(s.calls.enumerate).toBe(0);
		expect(s.calls.execute).toBe(0);
	});

	// G3 bumps the sentinel BEFORE the (unwrapped) enumerate() — so even a slow/failing
	// gh call still stamps the throttle and the NEXT tick takes G2 instead of re-hammering
	// gh. If the bump were moved after enumerate(), a throw would skip it and the throttle
	// would never hold. This asserts the documented ordering invariant.
	test('G3 stamps the sentinel BEFORE enumerate so a failing gh still throttles the next tick', () => {
		writeLock({ heartbeatAgoMs: STALE_MS + 10000 }); // stale
		writeSentinelAgo(90000); // window elapsed → G3
		const calls = { enumerate: 0, execute: 0 };
		const throwingEnumerate = () => { calls.enumerate += 1; throw new Error('gh timed out'); };
		const execute = () => { calls.execute += 1; };

		// The failure surfaces out of tick (fireAndForget swallows it in prod)…
		expect(() => tick({ gitCommonDir: dir, now: () => BASE, enumerate: throwingEnumerate, execute })).toThrow('gh timed out');
		expect(calls.enumerate).toBe(1);
		expect(calls.execute).toBe(0);
		// …but the sentinel was already stamped to `now` BEFORE enumerate ran.
		expect(Math.abs(fs.statSync(sentinelPath()).mtimeMs - BASE)).toBeLessThan(1000);

		// A follow-up tick 10s later now takes G2 — the throttle held; NO re-enumeration.
		const s2 = makeSpies();
		const r2 = tick({ gitCommonDir: dir, now: () => BASE + 10000, enumerate: s2.enumerate, execute: s2.execute });
		expect(r2.path).toBe('G2');
		expect(s2.calls.enumerate).toBe(0);
	});

	test('no lock at all + no sentinel → cold path enumerates once and creates sentinel', () => {
		const s = makeSpies();

		const result = tick({ gitCommonDir: dir, now: s.now, enumerate: s.enumerate, execute: s.execute });

		expect(result.path).toBe('G3');
		expect(s.calls.enumerate).toBe(1);
		expect(fs.existsSync(sentinelPath())).toBe(true);
	});

	test('FORGE_RECONCILE_MIN_INTERVAL overrides the window at runtime', () => {
		process.env.FORGE_RECONCILE_MIN_INTERVAL = '20000';
		writeLock({ heartbeatAgoMs: STALE_MS + 10000 });
		writeSentinelAgo(30000); // 30s ago: within default 60s, but past the 20s override
		const s = makeSpies();

		const result = tick({ gitCommonDir: dir, now: s.now, enumerate: s.enumerate, execute: s.execute });

		expect(result.path).toBe('G3');
		expect(s.calls.enumerate).toBe(1);
	});
});
