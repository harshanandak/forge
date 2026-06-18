'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { evaluateKernelEvent, normalizePayload } = require('./evaluators');
const { buildKernelMigrationPlan } = require('./migrations');
const { buildClaimConflict, isValidExpiresAt, planClaimAcquisition } = require('./lease-enforcer');

const LOCAL_BROKER_PRAGMAS = Object.freeze([
	'PRAGMA journal_mode=WAL;',
	'PRAGMA synchronous=NORMAL;',
	'PRAGMA foreign_keys=ON;',
	'PRAGMA busy_timeout=5000;',
]);

function normalizeExecOutput(output) {
	if (Buffer.isBuffer(output)) {
		return output.toString('utf8');
	}
	return String(output || '');
}

function resolveGitCommonDir(projectRoot, deps = {}) {
	if (!projectRoot) {
		throw new Error('projectRoot is required to resolve the Kernel broker common-dir');
	}

	const exec = deps.execFileSync || execFileSync;
	const rawCommonDir = normalizeExecOutput(exec('git', [
		'-C',
		projectRoot,
		'rev-parse',
		'--git-common-dir',
	], { encoding: 'utf8' })).trim();

	if (!rawCommonDir) {
		throw new Error('git rev-parse --git-common-dir returned an empty path');
	}

	return path.resolve(path.isAbsolute(rawCommonDir)
		? rawCommonDir
		: path.join(projectRoot, rawCommonDir));
}

function buildLocalBrokerConfig(options = {}) {
	const projectRoot = options.projectRoot || process.cwd();
	const gitCommonDir = path.resolve(options.gitCommonDir || resolveGitCommonDir(projectRoot, options));
	const brokerDir = path.join(gitCommonDir, 'forge');

	return {
		mode: 'local',
		storage: 'sqlite',
		journalMode: 'WAL',
		synchronous: 'NORMAL',
		foreignKeys: true,
		busyTimeoutMs: 5000,
		projectRoot,
		gitCommonDir,
		brokerDir,
		databasePath: options.databasePath || path.join(brokerDir, 'kernel.sqlite'),
		pragmas: [...LOCAL_BROKER_PRAGMAS],
		migrationPlan: options.migrationPlan || buildKernelMigrationPlan(),
	};
}

function requireDriverMethod(driver, methodName) {
	if (!driver || typeof driver[methodName] !== 'function') {
		throw new Error(`Kernel local broker driver must provide ${methodName}()`);
	}
}

function isExpectedRevisionAddColumn(statement) {
	return statement === 'ALTER TABLE kernel_events ADD COLUMN expected_revision INTEGER NOT NULL DEFAULT 0;';
}

function isDuplicateColumnError(error) {
	return /duplicate column name/i.test(String(error && error.message ? error.message : error));
}

function isIdempotencyConflict(error) {
	const msg = String(error?.message ?? error);
	return /UNIQUE constraint failed/i.test(msg) && /idempotency_key/i.test(msg);
}

// Match ONLY the active-lease partial UNIQUE index (kernel_claims.issue_id), not
// the table's primary key (kernel_claims.id): a duplicate-id violation is a
// distinct bug and must not be misclassified as a lease conflict.
function isClaimLeaseConflict(error) {
	const msg = String(error?.message ?? error);
	return /UNIQUE constraint failed/i.test(msg) && /kernel_claims\.issue_id/i.test(msg);
}

async function execMigrationStatement(driver, statement, config) {
	try {
		await driver.exec(statement, config);
	} catch (error) {
		if (isExpectedRevisionAddColumn(statement) && isDuplicateColumnError(error)) {
			return { skipped: true, reason: 'column-already-exists' };
		}
		throw error;
	}
	return { skipped: false };
}

function buildProjectionOutboxEntry(event, target, now) {
	return {
		event_id: event.id,
		target,
		status: 'pending',
		attempts: 0,
		created_at: now,
	};
}

function parseEventPayload(event = {}) {
	if (event.payload) return event.payload;
	if (!event.payload_json) return {};
	try {
		return JSON.parse(event.payload_json);
	} catch {
		return {};
	}
}

function buildDependencyScope(event) {
	if (event.event_type !== 'dependency.add') return null;
	const payload = parseEventPayload(event);
	if (!payload.issue_id || !payload.blocks_issue_id) return null;
	return {
		issue_id: payload.issue_id,
		blocks_issue_id: payload.blocks_issue_id,
		dependency_type: payload.dependency_type || 'blocks',
		entity_type: event.entity_type,
		entity_id: event.entity_id,
	};
}

// A claim.create event targets entity_type='claim'/entity_id=<claim id>, so the
// issue being claimed lives in the payload (exactly like dependency.add). Returns
// null for non-claim events AND for malformed claim.create events (missing
// issue_id or invalid expires_at) — the broker turns the latter into an
// invalid_claim_scope quarantine rather than letting them through unscoped.
function buildClaimScope(event) {
	if (event.event_type !== 'claim.create') return null;
	// A claim.create MUST be on the claim entity stream (entity_type='claim'). A
	// claim.create carried on another entity (e.g. an 'issue' event) is malformed:
	// it would otherwise insert a kernel_claims lease while the event/outbox are
	// recorded on the wrong stream. Reject the scope so it quarantines.
	if (event.entity_type !== 'claim') return null;
	// Read from the SAME normalized payload the evaluator persists, so the lease
	// can never describe a different issue than the accepted event/outbox.
	const payload = normalizePayload(event);
	// issue_id must be a non-empty STRING: a truthy non-string ({}, [], a number)
	// would otherwise be coerced into a bogus lease key or surface as a raw FK
	// error instead of the documented invalid_claim_scope quarantine.
	if (!payload || typeof payload.issue_id !== 'string' || !payload.issue_id) return null;
	// Reject a malformed expires_at up front: a junk value would make
	// isLeaseExpired meaningless (lock the issue forever or look instantly stale).
	if (!isValidExpiresAt(payload.expires_at)) return null;
	return {
		issue_id: payload.issue_id,
		entity_type: event.entity_type,
		entity_id: event.entity_id,
	};
}

const GUARDED_DRIVER_METHODS = Object.freeze([
	'exec',
	'loadKernelEntity',
	'listKernelEvents',
	'loadKernelEventByIdempotencyKey',
	'insertKernelConflict',
	'insertKernelEvent',
	'enqueueKernelProjection',
]);

function requireGuardedDriverMethods(driver) {
	for (const methodName of GUARDED_DRIVER_METHODS) {
		requireDriverMethod(driver, methodName);
	}
}

// Insert a quarantined claim-conflict row and return the quarantine result.
async function insertClaimConflictResult(driver, event, currentClaim, reason, context, config, now) {
	const conflict = await driver.insertKernelConflict({
		...buildClaimConflict(event, currentClaim, reason),
		created_at: event.created_at || now,
	}, context, config);
	return { decision: 'quarantine', reason, conflict, projection: false };
}

// Re-read the idempotency key and, if a committed winner now exists, return a
// duplicate replay. Used wherever a same-key retry might otherwise be misread as
// a fresh conflict — the parallel guard reads are not a consistent snapshot, so
// the idempotency lookup can miss a winner that a later read (or an insert
// collision) then observes.
async function replayDuplicateIfIdempotent(driver, event, context, config) {
	if (!event.idempotency_key) return null;
	const existingEvent = await driver.loadKernelEventByIdempotencyKey(event.idempotency_key, context, config);
	if (!existingEvent) return null;
	return { decision: 'duplicate', event, originalEvent: existingEvent, projection: false };
}

// Decide how an accepted claim.create maps to a claim row. Returns {terminal} to
// short-circuit runGuardedEvent (duplicate replay or claim_conflict quarantine),
// or {claimPlan} (possibly null for non-claim events) to proceed to the commit.
async function resolveClaimAcquisition({ driver, event, claimScope, activeClaim, context, config, now }) {
	if (!claimScope) return { claimPlan: null };
	const claimPlan = planClaimAcquisition({ event, activeClaim, now });
	if (claimPlan.action === 'conflict') {
		// Split-read guard: the idempotency lookup may have run before the winner
		// committed while the active-claim lookup ran after, so a legitimate
		// same-key retry can reach here. Re-check before quarantining.
		const terminal = (await replayDuplicateIfIdempotent(driver, event, context, config))
			|| await insertClaimConflictResult(driver, event, activeClaim, 'claim_conflict', context, config, now);
		return { terminal };
	}
	if (claimPlan.action === 'reclaim') {
		requireDriverMethod(driver, 'updateKernelClaimState');
	}
	return { claimPlan };
}

// Recover from a failed accept transaction (after ROLLBACK). A committed
// idempotency winner replays as a duplicate regardless of which unique index
// tripped (the claim insert precedes the event insert, so the active-lease index
// can throw before the events idempotency index); a genuine cross-owner lease
// collision becomes a claim_conflict quarantine; anything else rethrows.
async function recoverGuardedFailure({ driver, err, event, claimScope, context, config, now }) {
	const isUniqueConflict = isIdempotencyConflict(err) || (claimScope && isClaimLeaseConflict(err));
	if (isUniqueConflict) {
		const replay = await replayDuplicateIfIdempotent(driver, event, context, config);
		if (replay) return replay;
	}
	if (claimScope && isClaimLeaseConflict(err)) {
		const winner = await driver.loadActiveKernelClaim(claimScope.issue_id, context, config);
		return insertClaimConflictResult(driver, event, winner, 'claim_conflict', context, config, now);
	}
	throw err;
}

// Commit an accepted event: acquire/supersede the claim lease (if any), insert
// the event, and enqueue the projection outbox entry — all inside one
// BEGIN IMMEDIATE transaction, with ROLLBACK + recovery on failure.
async function commitGuardedAccept({ driver, event, evaluation, claimScope, activeClaim, context, config, now }) {
	const resolved = await resolveClaimAcquisition({ driver, event, claimScope, activeClaim, context, config, now });
	if (resolved.terminal) return resolved.terminal;
	const { claimPlan } = resolved;

	await driver.exec('BEGIN IMMEDIATE;', config);
	try {
		if (claimPlan) {
			if (claimPlan.action === 'reclaim') {
				await driver.updateKernelClaimState(
					claimPlan.supersede.claimId, claimPlan.supersede.toState, context, config,
				);
			}
			await driver.insertKernelClaim(claimPlan.claim, context, config);
		}
		const acceptedEvent = await driver.insertKernelEvent({
			...evaluation.event,
			created_at: evaluation.event.created_at || now,
		}, context, config);
		const outboxEntry = await driver.enqueueKernelProjection(
			buildProjectionOutboxEntry(acceptedEvent, context.projectionTarget || 'beads', now),
			context,
			config,
		);
		await driver.exec('COMMIT;', config);
		return { ...evaluation, event: acceptedEvent, outboxEntry };
	} catch (err) {
		await driver.exec('ROLLBACK;', config);
		return recoverGuardedFailure({ driver, err, event, claimScope, context, config, now });
	}
}

function createLocalBroker(options = {}) {
	const driver = options.driver;
	let cachedConfig;

	function getConfig() {
		if (!cachedConfig) {
			cachedConfig = buildLocalBrokerConfig(options);
		}
		return cachedConfig;
	}

	return {
		get config() {
			return getConfig();
		},

		async initialize() {
			requireDriverMethod(driver, 'exec');
			const config = getConfig();
			for (const statement of config.pragmas) {
				await driver.exec(statement, config);
			}
			for (const statement of config.migrationPlan.apply) {
				await execMigrationStatement(driver, statement, config);
			}

			return {
				success: true,
				mode: config.mode,
				databasePath: config.databasePath,
				gitCommonDir: config.gitCommonDir,
				journalMode: config.journalMode,
				synchronous: config.synchronous,
				foreignKeys: config.foreignKeys,
				migrationsApplied: config.migrationPlan.migrations.map(migration => migration.id),
			};
		},

		async runIssueOperation(operation, args = [], context = {}) {
			requireDriverMethod(driver, 'issueOperation');
			return driver.issueOperation(operation, args, context, getConfig());
		},

		async runGuardedEvent(event, context = {}) {
			requireGuardedDriverMethods(driver);

			const config = getConfig();
			const now = context.now || new Date().toISOString();
			const normalizedEvent = {
				...event,
				created_at: event.created_at || now,
			};
			const dependencyScope = buildDependencyScope(normalizedEvent);
			if (dependencyScope) {
				requireDriverMethod(driver, 'listKernelDependencies');
			}
			const claimScope = buildClaimScope(normalizedEvent);
			// A claim.create with a missing/invalid payload (or wrong entity) has no
			// scope. Quarantine it instead of falling through as a non-claim event:
			// the generic evaluator would otherwise accept and persist the event +
			// outbox without ever creating a kernel_claims lease, so a later claim on
			// the real issue would proceed as if nothing were claimed. BUT a retry of
			// an already-accepted claim (same idempotency_key) must still replay as a
			// duplicate even if this retry's payload is malformed, so check that first.
			if (normalizedEvent.event_type === 'claim.create' && !claimScope) {
				return (await replayDuplicateIfIdempotent(driver, normalizedEvent, context, config))
					|| insertClaimConflictResult(driver, normalizedEvent, null, 'invalid_claim_scope', context, config, now);
			}
			if (claimScope) {
				requireDriverMethod(driver, 'loadActiveKernelClaim');
				requireDriverMethod(driver, 'insertKernelClaim');
			}

			const [entity, entityEvents, idempotencyEvent, dependencies, activeClaim] = await Promise.all([
				driver.loadKernelEntity(normalizedEvent.entity_type, normalizedEvent.entity_id, context, config),
				driver.listKernelEvents(normalizedEvent.entity_type, normalizedEvent.entity_id, context, config),
				driver.loadKernelEventByIdempotencyKey(normalizedEvent.idempotency_key, context, config),
				dependencyScope
					? driver.listKernelDependencies(dependencyScope, context, config)
					: Promise.resolve([]),
				claimScope
					? driver.loadActiveKernelClaim(claimScope.issue_id, context, config)
					: Promise.resolve(null),
			]);
			const priorEvents = idempotencyEvent
				? [idempotencyEvent, ...entityEvents.filter(candidate => candidate.id !== idempotencyEvent.id)]
				: entityEvents;
			const evaluation = evaluateKernelEvent({
				event: normalizedEvent,
				entity,
				priorEvents,
				dependencies,
			});

			if (evaluation.decision === 'quarantine') {
				const conflict = await driver.insertKernelConflict({
					...evaluation.conflict,
					created_at: evaluation.conflict.created_at || now,
				}, context, config);
				return { ...evaluation, conflict };
			}

			if (evaluation.decision !== 'accept') {
				return evaluation;
			}

			return commitGuardedAccept({
				driver, event: normalizedEvent, evaluation, claimScope, activeClaim, context, config, now,
			});
		},
	};
}

module.exports = {
	LOCAL_BROKER_PRAGMAS,
	buildLocalBrokerConfig,
	createLocalBroker,
	resolveGitCommonDir,
};
