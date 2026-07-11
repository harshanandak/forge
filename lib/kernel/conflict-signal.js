'use strict';

// Typed conflict-signal classification (issues 89bf8930 / d4ce47bb).
//
// The broker used to classify write conflicts by substring-parsing raw SQLite
// error text (`/UNIQUE constraint failed/`, `kernel_claims.issue_id`, ...) inline.
// That coupled the broker to one driver's error dialect and was fragile across
// SQLite versions/runtimes and future backends (libSQL/Turso/CF).
//
// This module is the SINGLE place that owns that driver-boundary knowledge. It
// maps a raw driver/SQLite error into a stable TYPED code; the broker branches on
// the code and never parses strings. It mirrors the driver's existing structural
// signal (`error.kernelRevisionConflict`, set by applyAcceptedIssueMutation's
// row-level CAS) and generalizes it to every conflict class.
//
// When a new backend is added, only classifyConflictSignal changes — the broker's
// branching stays put. A CI integration test (test/kernel/conflict-signal.test.js)
// provokes real conflicts against the deployed driver and asserts the mapping,
// converting the standing "error text" assumption into a build-time contract.

const CONFLICT_SIGNAL = Object.freeze({
	// Optimistic-CAS lost update: the row-level revision guard matched 0 rows because
	// the entity's revision moved between the evaluator's out-of-transaction pre-read
	// and the serialized commit. Driver-tagged structurally (never string-derived).
	CAS_STALE: 'CAS_STALE',
	// Duplicate idempotency key — a same-key event replay collided on the events
	// UNIQUE(idempotency_key) index. The broker replays the committed winner.
	UNIQUE_IDEMPOTENCY: 'UNIQUE_IDEMPOTENCY',
	// Two active leases raced on one issue: the partial UNIQUE active-lease index
	// (kernel_claims.issue_id WHERE state='active') rejected the second. The broker
	// quarantines it as a claim_conflict.
	UNIQUE_CLAIM_LEASE: 'UNIQUE_CLAIM_LEASE',
	// Transient lock contention (SQLITE_BUSY / "database is locked"). Part of the
	// typed vocabulary; the broker does not currently branch on it (behavior parity).
	BUSY: 'BUSY',
	// Transient table-level lock (SQLITE_LOCKED). Typed for completeness as above.
	LOCKED: 'LOCKED',
});

// Map a raw driver/SQLite error → typed conflict code, or null if it is not a
// recognized conflict. Precedence: an already-typed signal (driver-supplied or a
// prior classification) wins over any string inspection, so once the driver tags
// an error at its boundary this never re-parses text.
function classifyConflictSignal(error) {
	if (!error) return null;

	// 1. Already-typed, driver-supplied signals take priority over any string parse.
	if (typeof error === 'object') {
		if (error.conflictSignal && isKnownSignal(error.conflictSignal)) {
			return error.conflictSignal;
		}
		// The driver's row-level CAS backstop tags this structurally.
		if (error.kernelRevisionConflict) return CONFLICT_SIGNAL.CAS_STALE;
	}

	// 2. Fallback for un-tagged native errors: inspect the driver's error surface.
	//    This is the ONLY place any error-text/code inspection is permitted.
	const message = String(error && error.message != null ? error.message : error);
	const code = String((error && error.code) || '');

	if (/UNIQUE constraint failed/i.test(message)) {
		// Match ONLY the active-lease partial index (kernel_claims.issue_id), not the
		// table PK (kernel_claims.id): a duplicate-id violation is a distinct bug.
		if (/kernel_claims\.issue_id/i.test(message)) return CONFLICT_SIGNAL.UNIQUE_CLAIM_LEASE;
		if (/idempotency_key/i.test(message)) return CONFLICT_SIGNAL.UNIQUE_IDEMPOTENCY;
		return null;
	}

	if (/^SQLITE_BUSY/i.test(code) || /database is locked/i.test(message)) return CONFLICT_SIGNAL.BUSY;
	if (/^SQLITE_LOCKED/i.test(code) || /database table is locked/i.test(message)) return CONFLICT_SIGNAL.LOCKED;

	return null;
}

function isKnownSignal(value) {
	return Object.prototype.hasOwnProperty.call(CONFLICT_SIGNAL, value);
}

module.exports = {
	CONFLICT_SIGNAL,
	classifyConflictSignal,
};
