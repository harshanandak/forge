const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveBashCommand } = require('../../test/helpers/bash.js');

const TEST_ENV_DIR = path.join(__dirname, '..');
const FIXTURES_DIR = path.join(TEST_ENV_DIR, 'fixtures');
const SETUP_SCRIPT = path.join(TEST_ENV_DIR, 'automation', 'setup-fixtures.sh');
const FIXTURE_LOCK_DIR = path.join(FIXTURES_DIR, '.setup-lock');

function sleep(ms) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		// Busy-wait briefly while another worker repairs fixtures.
	}
}

function fixturesNeedRepair() {
	return !fs.existsSync(path.join(FIXTURES_DIR, 'fresh-project', '.git'))
		|| !fs.existsSync(path.join(FIXTURES_DIR, 'dirty-git', 'uncommitted.txt'))
		|| !fs.existsSync(path.join(FIXTURES_DIR, 'detached-head', '.git'))
		|| !fs.existsSync(path.join(FIXTURES_DIR, 'merge-conflict', '.git', 'MERGE_HEAD'))
		|| fs.existsSync(path.join(FIXTURES_DIR, 'no-git', '.git'))
		|| !fs.existsSync(path.join(FIXTURES_DIR, 'read-only-dirs', '.claude'));
}

function repairFixtures() {
	try {
		fs.chmodSync(SETUP_SCRIPT, 0o755);
	} catch (_error) {
		// Best-effort on platforms that do not support chmod here.
	}

	execFileSync(resolveBashCommand(), [SETUP_SCRIPT, '--force', '--no-validate'], {
		cwd: path.dirname(SETUP_SCRIPT),
		stdio: 'pipe',
	});
}

function ensureTestFixtures() {
	if (!fixturesNeedRepair()) {
		return;
	}

	fs.mkdirSync(FIXTURES_DIR, { recursive: true });
	const deadline = Date.now() + 30000;

	while (true) {
		try {
			fs.mkdirSync(FIXTURE_LOCK_DIR);
			break;
		} catch (error) {
			if (error.code !== 'EEXIST') {
				throw error;
			}
			if (!fixturesNeedRepair()) {
				return;
			}
			if (Date.now() >= deadline) {
				throw new Error('Timed out waiting for fixture repair lock');
			}
			sleep(50);
		}
	}

	try {
		if (fixturesNeedRepair()) {
			repairFixtures();
		}
		if (fixturesNeedRepair()) {
			throw new Error('Fixture repair did not restore expected test fixture state');
		}
	} finally {
		fs.rmSync(FIXTURE_LOCK_DIR, { recursive: true, force: true });
	}
}

module.exports = {
	ensureTestFixtures,
	FIXTURES_DIR,
};
