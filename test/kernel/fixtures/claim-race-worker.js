'use strict';

// Multi-process claim-lease contention worker (task 9.5.1). Each worker is a
// separate OS process that opens the SAME on-disk WAL SQLite database and races
// to insert an active claim for the SAME issue_id inside BEGIN IMMEDIATE,
// mirroring the broker's transaction. The partial UNIQUE index
// (idx_kernel_claims_active_lease) is what guarantees exactly one winner — under
// BEGIN IMMEDIATE alone every INSERT would succeed and leave N active rows.
//
// Prints exactly one token to stdout: 'acquired' (won the lease) or 'conflict'
// (lost to the active-lease UNIQUE index). Any other failure exits non-zero.

const { createBuiltinSQLiteDriver } = require('../../../lib/kernel/sqlite-driver');

async function main() {
	const [databasePath, issueId, workerId] = process.argv.slice(2);
	const driver = createBuiltinSQLiteDriver({ databasePath });
	// busy_timeout MUST be set first: opening a WAL database can trigger lock
	// contention (including WAL recovery) on the very first statement, and
	// without a busy timeout that surfaces as an immediate SQLITE_BUSY instead
	// of waiting for the lock. WAL journal mode itself persists in the database
	// header from setup, so it is not (and must not be) re-issued here.
	await driver.exec('PRAGMA busy_timeout=5000;');
	await driver.exec('PRAGMA foreign_keys=ON;');

	const now = new Date().toISOString();
	try {
		await driver.exec('BEGIN IMMEDIATE;');
		await driver.exec(
			'INSERT INTO kernel_claims (id, issue_id, actor, state, claimed_at) VALUES ('
			+ `'claim-${workerId}', '${issueId}', 'agent-${workerId}', 'active', '${now}'`
			+ ');',
		);
		await driver.exec('COMMIT;');
		process.stdout.write('acquired');
	} catch (err) {
		try {
			await driver.exec('ROLLBACK;');
		} catch {
			// The failed statement may already have aborted the transaction.
		}
		const message = String(err?.message ?? err);
		// Only the active-lease index (kernel_claims.issue_id) counts as a lease
		// conflict — aligns with the broker's isClaimLeaseConflict classifier and
		// avoids masking unrelated UNIQUE/schema regressions as false passes.
		if (/UNIQUE constraint failed/i.test(message) && /kernel_claims\.issue_id/i.test(message)) {
			process.stdout.write('conflict');
		} else {
			process.stderr.write(message);
			process.exitCode = 1;
		}
	} finally {
		driver.close();
	}
}

main();
