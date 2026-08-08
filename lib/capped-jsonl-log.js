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
/**
 * How many times the trim re-reads the log for records appended since its
 * snapshot. Each pass copies less than the last, so a small bound is enough to
 * drain a burst without letting a busy writer keep the rename waiting forever.
 */
const TRIM_DELTA_PASSES = 3;
/**
 * How many times the trim rewrites the log to get it under the cap. A rewrite
 * that drained concurrent appends can still sit above it, and one more quiet
 * pass settles that; the bound stops a relentless writer from pinning the lock.
 */
const NEWLINE_BYTE = 0x0a;
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

/**
 * Reads the log as whole records plus the byte offset they end at, so a later
 * read can resume exactly where this one stopped. A trailing partial line is
 * excluded from both: it belongs to an append still in flight, and cutting the
 * offset at the last newline keeps the resume point on a record boundary.
 */
function snapshotJsonl(logPath) {
	let raw;
	try {
		raw = fs.readFileSync(logPath);
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
		return { lines: [], size: 0 };
	}

	const size = raw.lastIndexOf(NEWLINE_BYTE) + 1;
	return { lines: raw.subarray(0, size).toString('utf8').split('\n').filter(Boolean), size };
}

/** The whole records appended past `offset`, or null when there are none yet. */
function readAppendsSince(logPath, offset) {
	let size;
	try {
		// Almost every trim runs with nobody appending, so answer from a stat alone
		// and keep the extra work off the lock in the common case.
		size = fs.statSync(logPath).size;
	} catch (error) {
		if (error.code === 'ENOENT') return null;
		throw error;
	}
	if (size <= offset) return null;

	let handle;
	try {
		handle = fs.openSync(logPath, 'r');
	} catch (error) {
		if (error.code === 'ENOENT') return null;
		throw error;
	}

	try {
		const buffer = Buffer.alloc(size - offset);
		const read = fs.readSync(handle, buffer, 0, buffer.length, offset);
		const end = buffer.subarray(0, read).lastIndexOf(NEWLINE_BYTE) + 1;
		if (end === 0) return null;

		const bytes = buffer.subarray(0, end);
		return { bytes, records: bytes.toString('utf8').split('\n').filter(Boolean).length };
	} finally {
		fs.closeSync(handle);
	}
}

/**
 * One rewrite of the log down to its cap, returning the record count it left
 * behind — or null when a contended rename made it give up. Records drained from
 * concurrent appenders ride above the cap, so the caller has to check.
 * Must be called with the trim lock held.
 */
function rewriteToCap(logPath, maxRecords, pendingLine = null) {
	const snapshot = snapshotJsonl(logPath);
	if (snapshot.lines.length < maxRecords && pendingLine !== null) {
		fs.appendFileSync(logPath, `${pendingLine}\n`, 'utf8');
		return snapshot.lines.length + 1;
	}
	if (snapshot.lines.length <= maxRecords && pendingLine === null) return snapshot.lines.length;

	const candidates = pendingLine === null ? snapshot.lines : [...snapshot.lines, pendingLine];
	const kept = candidates.slice(-maxRecords);
	// Write-then-rename so a crash mid-trim cannot leave a torn log behind.
	const tempPath = `${logPath}.${process.pid}.tmp`;
	fs.writeFileSync(tempPath, `${kept.join('\n')}\n`, 'utf8');

	// Appenders hold no lock, so records keep landing in the log this rename is
	// about to replace. Copy them onto the temp file first — repeatedly, since
	// the copy itself takes time a writer can append into. Nothing heavier goes
	// between the last copy and the rename, which is what keeps the window small.
	let offset = snapshot.size;
	let drained = 0;
	for (let pass = 0; pass < TRIM_DELTA_PASSES; pass += 1) {
		const appended = readAppendsSince(logPath, offset);
		if (appended === null) break;
		fs.appendFileSync(tempPath, appended.bytes);
		offset += appended.bytes.length;
		drained += appended.records;
	}
	if (pendingLine !== null && drained > 0) {
		const prepared = snapshotJsonl(tempPath).lines;
		fs.writeFileSync(tempPath, `${prepared.slice(-maxRecords).join('\n')}\n`, 'utf8');
	}

	try {
		fs.renameSync(tempPath, logPath);
	} catch (error) {
		// Another writer still has the log open for its append. Same answer as
		// losing the lock race: drop this trim, the next writer will do it.
		if (!FILE_CONTENDED_CODES.has(error.code)) throw error;
		fs.rmSync(tempPath, { force: true });
		return null;
	}
	return pendingLine === null ? kept.length + drained : Math.min(kept.length + drained, maxRecords);
}

function appendAtCap(logPath, recordLine, maxRecords) {
	const snapshot = snapshotJsonl(logPath);

	const lockPath = `${logPath}.lock`;
	const lock = acquireTrimLock(lockPath);
	// A held lock means another writer is already trimming. These logs are
	// best-effort sinks on the hot path of a hook or a command, so skip and let
	// the next writer past the cap trim instead of blocking the caller.
	if (lock === null) {
		fs.appendFileSync(logPath, `${recordLine}\n`, 'utf8');
		return snapshot.lines.length + 1;
	}

	try {
		const rewritten = rewriteToCap(logPath, maxRecords, recordLine);
		if (rewritten === null) {
			fs.appendFileSync(logPath, `${recordLine}\n`, 'utf8');
			return snapshotJsonl(logPath).lines.length;
		}
		return rewritten;
	} finally {
		releaseTrimLock(lock, lockPath);
	}
}

/**
 * Below the cap, O_APPEND keeps each small record atomic. At the cap, the new
 * record is prepared inside the locked replacement so failure cannot be
 * reported after the authorization has already landed in the live log.
 *
 * That leaves one window, and the trim narrows rather than closes it: records
 * appended after the trim's snapshot are drained onto the replacement file right
 * before the rename, so only a record landing between the final drain and the
 * rename syscall itself can still be lost. Closing it completely would mean
 * locking every append, which these hot-path sinks do not pay for.
 */
function appendCappedJsonlRecord(logPath, record, maxRecords) {
	fs.mkdirSync(path.dirname(logPath), { recursive: true });
	const recordLine = JSON.stringify(record);
	const snapshot = snapshotJsonl(logPath);
	if (snapshot.lines.length < maxRecords) {
		fs.appendFileSync(logPath, `${recordLine}\n`, 'utf8');
		return snapshot.lines.length + 1;
	}
	return appendAtCap(logPath, recordLine, maxRecords);
}

module.exports = {
	appendCappedJsonlRecord,
};
