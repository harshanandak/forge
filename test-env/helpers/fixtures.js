const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveBashCommand } = require('../../test/helpers/bash.js');

const TEST_ENV_DIR = path.join(__dirname, '..');
const FIXTURES_DIR = path.join(TEST_ENV_DIR, 'fixtures');
const SETUP_SCRIPT = path.join(TEST_ENV_DIR, 'automation', 'setup-fixtures.sh');
// Written by setup-fixtures.sh only after every fixture was created and verified.
// The early sentinels below cannot detect a repair that died partway through.
const FIXTURES_COMPLETE_MARKER = '.fixtures-complete';

// Wall-clock ceiling for the synchronous fixture-setup spawn. Generous enough
// for a cold Windows checkout, but bounded so a hung git/bash aborts fast.
const SETUP_SPAWN_TIMEOUT_MS = 60000;

function sleep(ms) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		// Busy-wait briefly while another worker repairs fixtures.
	}
}

// The marker plus the early sentinels; each entry names what is wrong.
const FIXTURE_STATE_CHECKS = [
	{ path: [FIXTURES_COMPLETE_MARKER], present: true },
	{ path: ['fresh-project', '.git'], present: true },
	{ path: ['dirty-git', 'uncommitted.txt'], present: true },
	{ path: ['detached-head', '.git'], present: true },
	{ path: ['merge-conflict', '.git', 'MERGE_HEAD'], present: true },
	{ path: ['no-git', '.git'], present: false },
	{ path: ['read-only-dirs', '.claude'], present: true },
];

// Returns a description of the first failed check, or null when fixtures hold.
function describeIncompleteFixtures(fixturesDir) {
	for (const check of FIXTURE_STATE_CHECKS) {
		if (fs.existsSync(path.join(fixturesDir, ...check.path)) !== check.present) {
			return `${check.present ? 'missing' : 'unexpected'} ${check.path.join('/')}`;
		}
	}
	return null;
}

function fixturesNeedRepair(fixturesDir) {
	return describeIncompleteFixtures(fixturesDir) !== null;
}

// The full-suite runner prepares fixtures once, then sets this for every shard.
// Such shards are readers only: repairing here would race the other shards.
function fixturesPreparedByRunner(env) {
	return env.FORGE_FIXTURES_PREPARED === '1';
}

// The script builds its default tree unless FORGE_FIXTURES_DIR names another
// one, which it only accepts when that directory holds a .forge-fixtures-sandbox
// file (test trees). Never pass the default tree explicitly, and drop any
// inherited override.
function setupScriptEnv(fixturesDir) {
	const env = { ...process.env };
	delete env.FORGE_FIXTURES_DIR;
	if (path.resolve(fixturesDir) !== path.resolve(FIXTURES_DIR)) {
		env.FORGE_FIXTURES_DIR = fixturesDir;
	}
	return env;
}

function repairFixtures(setupScript, fixturesDir = FIXTURES_DIR) {
	try {
		fs.chmodSync(setupScript, 0o755);
	} catch (_error) {
		// Best-effort on platforms that do not support chmod here.
	}

	execFileSync(resolveBashCommand(), [setupScript, '--force', '--no-validate'], {
		cwd: path.dirname(setupScript),
		env: setupScriptEnv(fixturesDir),
		stdio: 'pipe',
		// Bound this synchronous spawn: bun's per-test `--timeout` cannot preempt a
		// blocking execFileSync, so a hung git/bash here would hang the whole push
		// (issue 8aef79e8). A timeout makes it throw ETIMEDOUT and fail fast instead.
		timeout: SETUP_SPAWN_TIMEOUT_MS,
		killSignal: 'SIGKILL',
	});
}

function ensureTestFixtures(options = {}) {
	const fixturesDir = options.fixturesDir ?? FIXTURES_DIR;
	const setupScript = options.setupScript ?? SETUP_SCRIPT;
	const lockDir = options.lockDir ?? path.join(fixturesDir, '.setup-lock');
	const repair = options.repairFixtures ?? (() => repairFixtures(setupScript, fixturesDir));
	const needsRepair = () => fixturesNeedRepair(fixturesDir);

	if (fixturesPreparedByRunner(options.env ?? process.env)) {
		const problem = describeIncompleteFixtures(fixturesDir);
		if (problem) {
			throw new Error(`fixtures were prepared by the runner but are incomplete: ${problem}`);
		}
		return;
	}

	if (!needsRepair()) {
		return;
	}

	// Standalone runs (`bun test <file>`) repair under this helper lock.

	fs.mkdirSync(fixturesDir, { recursive: true });
	const deadline = Date.now() + 30000;

	while (true) {
		try {
			fs.mkdirSync(lockDir);
			break;
		} catch (error) {
			if (error.code !== 'EEXIST') {
				throw error;
			}
			if (!needsRepair()) {
				return;
			}
			if (Date.now() >= deadline) {
				throw new Error('Timed out waiting for fixture repair lock');
			}
			sleep(50);
		}
	}

	try {
		if (needsRepair()) {
			repair();
		}
		if (needsRepair()) {
			throw new Error('Fixture repair did not restore expected test fixture state');
		}
	} finally {
		fs.rmSync(lockDir, { recursive: true, force: true });
	}
}

module.exports = {
	ensureTestFixtures,
	FIXTURES_COMPLETE_MARKER,
	FIXTURES_DIR,
};
