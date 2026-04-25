const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveBashCommand } = require('../../test/helpers/bash.js');

const TEST_ENV_DIR = path.join(__dirname, '..');
const FIXTURES_DIR = path.join(TEST_ENV_DIR, 'fixtures');
const SETUP_SCRIPT = path.join(TEST_ENV_DIR, 'automation', 'setup-fixtures.sh');

function sleep(ms) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		// Busy-wait briefly while another worker repairs fixtures.
	}
}

function fixturesNeedRepair(fixturesDir) {
	return !fs.existsSync(path.join(fixturesDir, 'fresh-project', '.git'))
		|| !fs.existsSync(path.join(fixturesDir, 'dirty-git', 'uncommitted.txt'))
		|| !fs.existsSync(path.join(fixturesDir, 'detached-head', '.git'))
		|| !fs.existsSync(path.join(fixturesDir, 'merge-conflict', '.git', 'MERGE_HEAD'))
		|| fs.existsSync(path.join(fixturesDir, 'no-git', '.git'))
		|| !fs.existsSync(path.join(fixturesDir, 'read-only-dirs', '.claude'));
}

function repairFixtures(setupScript) {
	try {
		fs.chmodSync(setupScript, 0o755);
	} catch (_error) {
		// Best-effort on platforms that do not support chmod here.
	}

	execFileSync(resolveBashCommand(), [setupScript, '--force', '--no-validate'], {
		cwd: path.dirname(setupScript),
		stdio: 'pipe',
	});
}

function ensureTestFixtures(options = {}) {
	const fixturesDir = options.fixturesDir ?? FIXTURES_DIR;
	const setupScript = options.setupScript ?? SETUP_SCRIPT;
	const lockDir = options.lockDir ?? path.join(fixturesDir, '.setup-lock');
	const repair = options.repairFixtures ?? (() => repairFixtures(setupScript));
	const needsRepair = () => fixturesNeedRepair(fixturesDir);

	if (!needsRepair()) {
		return;
	}

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
	FIXTURES_DIR,
};
