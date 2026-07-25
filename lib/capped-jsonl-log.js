const fs = require('node:fs');
const path = require('node:path');

/**
 * The local append-only JSONL sink shared by every Forge log that must survive
 * without a database handle: the protected-state audit log and the subagent
 * audit-evidence log. Kept in its own module so both writers get the same
 * concurrency and cap behaviour instead of a second copy drifting from the first.
 */

const TRIM_LOCK_ATTEMPTS = 5;
const TRIM_LOCK_RETRY_MS = 20;
/** The trim rewrite takes milliseconds, so an older lock outlived its process. */
const TRIM_LOCK_STALE_MS = 5000;
/**
 * Another process is using the file. POSIX reports only EEXIST/EBUSY, but
 * Windows answers EPERM/EACCES both for a lock whose delete is still pending and
 * for a replace of a log some other writer holds open.
 */
const FILE_CONTENDED_CODES = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockHeldSinceMs(lockPath) {
	try {
		return fs.lstatSync(lockPath).mtimeMs;
	} catch (error) {
		if (error.code === 'ENOENT') return null;
		throw error;
	}
}

function acquireTrimLock(lockPath) {
	for (let attempt = 0; attempt < TRIM_LOCK_ATTEMPTS; attempt += 1) {
		try {
			return fs.openSync(lockPath, 'wx');
		} catch (error) {
			if (!FILE_CONTENDED_CODES.has(error.code)) throw error;

			const heldSince = lockHeldSinceMs(lockPath);
			if (heldSince !== null && Date.now() - heldSince > TRIM_LOCK_STALE_MS) {
				try {
					fs.unlinkSync(lockPath);
				} catch {
					// Another writer reclaimed it first; retry against theirs.
				}
				continue;
			}

			sleepSync(TRIM_LOCK_RETRY_MS);
		}
	}

	return null;
}

function releaseTrimLock(handle, lockPath) {
	try {
		fs.closeSync(handle);
	} catch {
		// Already closed.
	}
	try {
		fs.unlinkSync(lockPath);
	} catch {
		// Already reclaimed as stale.
	}
}

function readJsonlLines(logPath) {
	try {
		return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
		return [];
	}
}

function trimJsonlToCap(logPath, maxRecords) {
	let lines = readJsonlLines(logPath);
	if (lines.length <= maxRecords) return lines.length;

	const lockPath = `${logPath}.lock`;
	const lock = acquireTrimLock(lockPath);
	// A held lock means another writer is already trimming. These logs are
	// best-effort sinks on the hot path of a hook or a command, so skip and let
	// the next writer past the cap trim instead of blocking the caller.
	if (lock === null) return lines.length;

	try {
		lines = readJsonlLines(logPath);
		if (lines.length <= maxRecords) return lines.length;

		const kept = lines.slice(-maxRecords);
		// Write-then-rename so a crash mid-trim cannot leave a torn log behind.
		const tempPath = `${logPath}.${process.pid}.tmp`;
		fs.writeFileSync(tempPath, `${kept.join('\n')}\n`, 'utf8');
		try {
			fs.renameSync(tempPath, logPath);
		} catch (error) {
			// Another writer still has the log open for its append. Same answer as
			// losing the lock race: drop this trim, the next writer will do it.
			if (!FILE_CONTENDED_CODES.has(error.code)) throw error;
			fs.rmSync(tempPath, { force: true });
			return lines.length;
		}
		return kept.length;
	} finally {
		releaseTrimLock(lock, lockPath);
	}
}

/**
 * The append is lock-free: O_APPEND makes a single small record atomic, so
 * concurrent processes cannot overwrite each other. Only the trim rewrite is
 * serialised, because that is the read-modify-write that could drop a record
 * appended between its read and its write.
 */
function appendCappedJsonlRecord(logPath, record, maxRecords) {
	fs.mkdirSync(path.dirname(logPath), { recursive: true });
	fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8');
	return trimJsonlToCap(logPath, maxRecords);
}

module.exports = {
	appendCappedJsonlRecord,
};
