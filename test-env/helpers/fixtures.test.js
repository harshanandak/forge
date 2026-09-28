import { afterEach, describe, expect, test } from 'bun:test';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureTestFixtures, FIXTURES_COMPLETE_MARKER } = require('./fixtures.js');

const tempDirs = [];

// Repair-path tests must not see the full-suite runner's FORGE_FIXTURES_PREPARED=1
// (every shard inherits it), or ensureTestFixtures takes the verify-only branch.
const REPAIR_ENV = {};

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function createTempFixturesDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-fixtures-'));
	tempDirs.push(dir);
	return dir;
}

function materializeSentinels(fixturesDir) {
	fs.mkdirSync(path.join(fixturesDir, 'fresh-project', '.git'), { recursive: true });
	fs.mkdirSync(path.join(fixturesDir, 'dirty-git'), { recursive: true });
	fs.writeFileSync(path.join(fixturesDir, 'dirty-git', 'uncommitted.txt'), 'dirty', 'utf8');
	fs.mkdirSync(path.join(fixturesDir, 'detached-head', '.git'), { recursive: true });
	fs.mkdirSync(path.join(fixturesDir, 'merge-conflict', '.git'), { recursive: true });
	fs.writeFileSync(path.join(fixturesDir, 'merge-conflict', '.git', 'MERGE_HEAD'), 'merge', 'utf8');
	fs.mkdirSync(path.join(fixturesDir, 'no-git'), { recursive: true });
	fs.mkdirSync(path.join(fixturesDir, 'read-only-dirs', '.claude'), { recursive: true });
}

function materializeFixtureState(fixturesDir) {
	materializeSentinels(fixturesDir);
	fs.writeFileSync(path.join(fixturesDir, FIXTURES_COMPLETE_MARKER), '', 'utf8');
}

describe('test-env/helpers/fixtures.js', () => {
	test('repairs incomplete fixture directories before tests run', () => {
		const fixturesDir = createTempFixturesDir();
		const lockDir = path.join(fixturesDir, '.setup-lock');
		let repairCount = 0;

		ensureTestFixtures({
			env: REPAIR_ENV,
			fixturesDir,
			lockDir,
			repairFixtures: () => {
				repairCount += 1;
				materializeFixtureState(fixturesDir);
			},
		});

		expect(repairCount).toBe(1);
		expect(fs.existsSync(path.join(fixturesDir, 'fresh-project', '.git'))).toBe(true);
		expect(fs.existsSync(path.join(fixturesDir, 'merge-conflict', '.git', 'MERGE_HEAD'))).toBe(true);
		expect(fs.existsSync(path.join(fixturesDir, 'no-git', '.git'))).toBe(false);
	});

	test('skips repair when fixture state is already complete', () => {
		const fixturesDir = createTempFixturesDir();
		const lockDir = path.join(fixturesDir, '.setup-lock');
		let repairCount = 0;

		materializeFixtureState(fixturesDir);
		ensureTestFixtures({
			env: REPAIR_ENV,
			fixturesDir,
			lockDir,
			repairFixtures: () => {
				repairCount += 1;
			},
		});

		expect(repairCount).toBe(0);
	});

	test('repairs when early sentinels exist but the completion marker is absent', () => {
		const fixturesDir = createTempFixturesDir();
		const lockDir = path.join(fixturesDir, '.setup-lock');
		let repairCount = 0;

		materializeSentinels(fixturesDir);
		ensureTestFixtures({
			env: REPAIR_ENV,
			fixturesDir,
			lockDir,
			repairFixtures: () => {
				repairCount += 1;
				materializeFixtureState(fixturesDir);
			},
		});

		expect(repairCount).toBe(1);
	});

	test('runner-prepared fixtures that are incomplete throw without repairing or locking', () => {
		const fixturesDir = createTempFixturesDir();
		const lockDir = path.join(fixturesDir, '.setup-lock');
		let repairCount = 0;

		materializeSentinels(fixturesDir);
		expect(() => ensureTestFixtures({
			env: { FORGE_FIXTURES_PREPARED: '1' },
			fixturesDir,
			lockDir,
			repairFixtures: () => {
				repairCount += 1;
				materializeFixtureState(fixturesDir);
			},
		})).toThrow(`fixtures were prepared by the runner but are incomplete: missing ${FIXTURES_COMPLETE_MARKER}`);

		expect(repairCount).toBe(0);
		expect(fs.existsSync(lockDir)).toBe(false);
		expect(fs.existsSync(path.join(fixturesDir, FIXTURES_COMPLETE_MARKER))).toBe(false);
	});

	test('runner-prepared fixtures that are complete are accepted without repairing or locking', () => {
		const fixturesDir = createTempFixturesDir();
		const lockDir = path.join(fixturesDir, '.setup-lock');
		let repairCount = 0;

		materializeFixtureState(fixturesDir);
		fs.mkdirSync(lockDir);
		ensureTestFixtures({
			env: { FORGE_FIXTURES_PREPARED: '1' },
			fixturesDir,
			lockDir,
			repairFixtures: () => {
				repairCount += 1;
			},
		});

		expect(repairCount).toBe(0);
	});

	test('default repair tells the setup script which tree to build', () => {
		const fixturesDir = createTempFixturesDir();
		const scriptDir = createTempFixturesDir();
		const setupScript = path.join(scriptDir, 'fake-setup.sh');
		const envReport = path.join(scriptDir, 'env.txt');
		// Stands in for setup-fixtures.sh: records what it was told, then publishes
		// the complete state so ensureTestFixtures accepts the repair.
		fs.writeFileSync(setupScript, [
			'#!/usr/bin/env bash',
			`printf '%s\\n%s\\n%s\\n%s\\n' "$FORGE_FIXTURE_LOCK_HELD" "$FORGE_FIXTURES_PREPARED" "$FORGE_FIXTURES_DIR" "$*" > '${envReport.replace(/\\/g, '/')}'`,
			'd="$FORGE_FIXTURES_DIR"',
			'mkdir -p "$d/fresh-project/.git" "$d/dirty-git" "$d/detached-head/.git" "$d/merge-conflict/.git" "$d/read-only-dirs/.claude"',
			'touch "$d/dirty-git/uncommitted.txt" "$d/merge-conflict/.git/MERGE_HEAD" "$d/.fixtures-complete"',
			'',
		].join('\n'), 'utf8');

		ensureTestFixtures({ env: REPAIR_ENV, fixturesDir, setupScript });

		const [lockHeld, prepared, reportedDir, args] = fs.readFileSync(envReport, 'utf8').split('\n');
		// The script no longer has its own lock, so the helper sends no lock flag.
		expect(lockHeld).toBe('');
		// The script is the builder here, so it never inherits the runner's reader flag.
		expect(prepared).toBe('');
		expect(path.resolve(reportedDir)).toBe(path.resolve(fixturesDir));
		expect(args).toBe('--force --no-validate');
		expect(fs.existsSync(path.join(fixturesDir, '.setup-lock'))).toBe(false);
	}, 30000);

	test('throws when repair leaves sentinels but never publishes the completion marker', () => {
		const fixturesDir = createTempFixturesDir();
		const lockDir = path.join(fixturesDir, '.setup-lock');
		let repairCount = 0;

		materializeSentinels(fixturesDir);
		expect(() => ensureTestFixtures({
			env: REPAIR_ENV,
			fixturesDir,
			lockDir,
			repairFixtures: () => {
				repairCount += 1;
			},
		})).toThrow('Fixture repair did not restore expected test fixture state');

		expect(repairCount).toBe(1);
		expect(fs.existsSync(path.join(fixturesDir, FIXTURES_COMPLETE_MARKER))).toBe(false);
		expect(fs.existsSync(lockDir)).toBe(false);
	});
});
