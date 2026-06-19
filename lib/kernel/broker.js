'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { buildConflict, evaluateKernelEvent, normalizePayload } = require('./evaluators');
const { buildKernelMigrationPlan } = require('./migrations');
const { buildClaimConflict, isValidExpiresAt, planClaimAcquisition } = require('./lease-enforcer');
const {
	ISSUE_COMMAND_EXIT_CODES,
	ISSUE_COMMAND_SCHEMA_VERSION,
	formatIssueCommandError,
	getIssueCommandContract,
} = require('./issue-command-contract');

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

// The real driver's applyAcceptedIssueMutation tags a lost-update collision (its
// row-level CAS UPDATE matched 0 rows because the issue's revision moved between
// the evaluator's out-of-transaction pre-read and the serialized commit). It is the
// issue-revision analogue of the claim-lease partial-UNIQUE backstop: a structural
// guarantee the evaluator's pre-read alone cannot provide under concurrency.
function isRevisionConflict(error) {
	return Boolean(error && error.kernelRevisionConflict);
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
	// Issue-revision lost-update detected by the driver's row-level CAS: a same-key
	// retry of an already-committed winner still replays as a duplicate; otherwise
	// quarantine as stale_revision (byte-identical to an evaluator-produced conflict)
	// so mapMutationResult surfaces it as a RETRYABLE conflict — the caller re-reads
	// the bumped revision and retries.
	if (isRevisionConflict(err)) {
		const replay = await replayDuplicateIfIdempotent(driver, event, context, config);
		if (replay) return replay;
		const conflict = await driver.insertKernelConflict({
			...buildConflict(event, 'stale_revision', err.actualRevision),
			created_at: event.created_at || now,
		}, context, config);
		return { decision: 'quarantine', reason: 'stale_revision', conflict, projection: false };
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
		// Apply the accepted event's authority-table effect (issue upsert / revision
		// bump / comment insert) on the SAME connection, inside this transaction, so
		// the event and its issue-row effect commit or roll back atomically. The hook
		// is OPTIONAL: drivers that only supply event-store primitives (and every
		// inline broker test fake) omit it, leaving the append/CAS path unchanged.
		let mutation;
		if (typeof driver.applyAcceptedIssueMutation === 'function') {
			mutation = await driver.applyAcceptedIssueMutation(acceptedEvent, context, config);
		}
		const outboxEntry = await driver.enqueueKernelProjection(
			buildProjectionOutboxEntry(acceptedEvent, context.projectionTarget || 'beads', now),
			context,
			config,
		);
		await driver.exec('COMMIT;', config);
		return { ...evaluation, event: acceptedEvent, outboxEntry, mutation };
	} catch (err) {
		await driver.exec('ROLLBACK;', config);
		return recoverGuardedFailure({ driver, err, event, claimScope, context, config, now });
	}
}

// --- Issue-mutation routing (K-DRV Wave 3) ------------------------------------
// The KernelIssueAdapter routes every op to runIssueOperation. Reads delegate
// straight to driver.issueOperation; mutations must instead flow through the
// guarded-event path so CAS/idempotency/quarantine (proven in #220) apply. This
// surface builds a kernel event from the CLI args, runs runGuardedEvent, and maps
// the decision back to an issue-command-contract response — without changing
// runGuardedEvent itself.

// Ops that must go through runGuardedEvent. Reads stay on driver.issueOperation.
const ISSUE_MUTATION_OPERATIONS = Object.freeze(new Set([
	'create', 'update', 'close', 'comment',
	'dep.add', 'dep.remove', 'claim', 'release',
]));

// Ops whose kernel event targets a non-issue entity stream (a dependency edge or a
// claim lease). These carry entity_type 'dependency'/'claim' and an entity_id that
// is the dep/claim row id — NOT the issue id — so they must never fall into the
// issue-upsert apply branch in the driver.
const DEPENDENCY_OPERATIONS = Object.freeze(new Set(['dep.add', 'dep.remove']));
const CLAIM_OPERATIONS = Object.freeze(new Set(['claim', 'release']));

// Map an issue mutation op to its event_type and the contract command id used for
// response/error shaping.
const ISSUE_MUTATION_EVENT_TYPES = Object.freeze({
	create: 'issue.create',
	update: 'issue.update',
	close: 'issue.close',
	comment: 'issue.comment',
	'dep.add': 'dependency.add',
	'dep.remove': 'dependency.remove',
	claim: 'claim.create',
	release: 'claim.release',
});
const ISSUE_MUTATION_COMMAND_IDS = Object.freeze({
	create: 'issue.create',
	update: 'issue.update',
	close: 'issue.close',
	comment: 'issue.comment',
	'dep.add': 'issue.dep.add',
	'dep.remove': 'issue.dep.remove',
	claim: 'claim',
	release: 'release',
});

function nextCommandsFor(commandId) {
	const contract = getIssueCommandContract(commandId);
	return contract ? [...contract.nextCommands] : [];
}

// First non-flag token (the issue id for update/close/comment).
function firstPositionalArg(args = []) {
	return (args || []).find(value => typeof value === 'string' && !value.startsWith('-'));
}

// Parse the long-flag pairs CLI mutations carry (e.g. --title "x" --type task).
// Only --key value pairs are captured; bare positionals are ignored here.
function parseFlagPairs(args = []) {
	const flags = {};
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (typeof token !== 'string' || !token.startsWith('--')) continue;
		const key = token.slice(2);
		const next = args[index + 1];
		if (typeof next === 'string' && !next.startsWith('--')) {
			flags[key] = next;
			index += 1;
		} else {
			flags[key] = true;
		}
	}
	return flags;
}

// Build the create payload from flags. --id is optional (minted when absent); the
// minted/declared id becomes the event entity_id and the new issue's primary key.
function buildCreatePayload(flags) {
	const id = typeof flags.id === 'string' ? flags.id : randomUUID();
	const payload = { id };
	if (typeof flags.title === 'string') payload.title = flags.title;
	if (typeof flags.body === 'string') payload.body = flags.body;
	payload.type = typeof flags.type === 'string' ? flags.type : 'task';
	payload.status = typeof flags.status === 'string' ? flags.status : 'open';
	if (typeof flags.priority === 'string') payload.priority = flags.priority;
	if (flags['priority-rank'] !== undefined) payload.priority_rank = Number(flags['priority-rank']);
	if (typeof flags.parent === 'string') payload.parent_id = flags.parent;
	return payload;
}

// Build the update/close payload from flags (status/title/etc. when present).
function buildUpdatePayload(flags) {
	const payload = {};
	if (typeof flags.status === 'string') payload.status = flags.status;
	if (typeof flags.title === 'string') payload.title = flags.title;
	if (typeof flags.body === 'string') payload.body = flags.body;
	if (typeof flags.priority === 'string') payload.priority = flags.priority;
	if (flags['priority-rank'] !== undefined) payload.priority_rank = Number(flags['priority-rank']);
	return payload;
}

// The comment body is the first non-id positional (forge comment <id> <body...>).
function buildCommentPayload(issueId, args) {
	const positionals = (args || []).filter(value => typeof value === 'string' && !value.startsWith('-'));
	const body = positionals.slice(1).join(' ');
	return { issue_id: issueId, body, comment_id: randomUUID() };
}

// Resolve the (issue_id, blocks_issue_id) endpoints a dependency op names. Accepts
// the --issue/--blocks flag pair; both MUST be present so buildDependencyScope can
// scope the event (else the cycle guard is skipped and the edge insert is malformed).
function resolveDependencyEndpoints(flags) {
	return {
		issue_id: typeof flags.issue === 'string' ? flags.issue : undefined,
		blocks_issue_id: typeof flags.blocks === 'string' ? flags.blocks : undefined,
		dependency_type: typeof flags['dep-type'] === 'string' ? flags['dep-type'] : 'blocks',
	};
}

// Build the kernel event for a dependency.add / dependency.remove op. The event is
// scoped on the 'dependency' entity stream: a freshly minted entity_id becomes the
// dependency row id (add) and the cycle-guard / edge-write key. The idempotency key
// is derived from the edge endpoints so a retry of the same edge replays rather
// than minting a second row.
function buildDependencyMutationEvent(operation, flags, actor, origin, context) {
	const endpoints = resolveDependencyEndpoints(flags);
	const dependencyId = context.dependencyId || randomUUID();
	const eventType = ISSUE_MUTATION_EVENT_TYPES[operation];
	const idempotencyKey = context.idempotencyKey
		|| `${eventType}:${endpoints.issue_id}:${endpoints.blocks_issue_id}`;
	return {
		entity_type: 'dependency',
		entity_id: dependencyId,
		event_type: eventType,
		idempotency_key: idempotencyKey,
		expected_revision: 0,
		actor,
		origin,
		payload: {
			issue_id: endpoints.issue_id,
			blocks_issue_id: endpoints.blocks_issue_id,
			dependency_type: endpoints.dependency_type,
		},
	};
}

// Build the kernel event for a claim / release op. The event is scoped on the
// 'claim' entity stream (entity_id = claim lease id). The default idempotency key
// is keyed on issue_id + actor so a same-actor retry replays as a duplicate while a
// different actor produces a distinct key that reaches the lease-conflict path.
function buildClaimMutationEvent(operation, flags, actor, origin, context) {
	const issueId = typeof flags.issue === 'string' ? flags.issue : undefined;
	const claimId = context.claimId || randomUUID();
	const eventType = ISSUE_MUTATION_EVENT_TYPES[operation];
	const idempotencyKey = context.idempotencyKey || `${eventType}:${issueId}:${actor}`;
	const payload = { issue_id: issueId };
	if (typeof flags.expires === 'string') payload.expires_at = flags.expires;
	return {
		entity_type: 'claim',
		entity_id: claimId,
		event_type: eventType,
		idempotency_key: idempotencyKey,
		expected_revision: 0,
		actor,
		origin,
		session_id: context.sessionId ?? null,
		worktree_id: context.worktreeId ?? null,
		payload,
	};
}

// Construct the kernel event for a mutation op. For update/close/comment, the
// expected_revision is the FRESHLY READ stored revision (so runIssueOperation can
// never manufacture a stale CAS — a behind revision only arrives via a raw
// runGuardedEvent call). entity_id is the issue id; payload carries the change.
async function buildIssueMutationEvent(driver, operation, args, context, config) {
	const flags = parseFlagPairs(args);
	const actor = context.actor || 'forge';
	const origin = context.origin || 'cli';

	if (operation === 'create') {
		const payload = buildCreatePayload(flags);
		return {
			entity_type: 'issue',
			entity_id: payload.id,
			event_type: ISSUE_MUTATION_EVENT_TYPES.create,
			idempotency_key: context.idempotencyKey || `issue.create:${payload.id}`,
			expected_revision: 0,
			actor,
			origin,
			payload,
		};
	}

	// Dependency / claim ops target their own entity stream (no issue-row CAS): the
	// event entity_type is 'dependency'/'claim' and entity_id is a fresh dep/claim id.
	if (DEPENDENCY_OPERATIONS.has(operation)) {
		return buildDependencyMutationEvent(operation, flags, actor, origin, context);
	}
	if (CLAIM_OPERATIONS.has(operation)) {
		return buildClaimMutationEvent(operation, flags, actor, origin, context);
	}

	const issueId = firstPositionalArg(args);
	const entity = await driver.loadKernelEntity('issue', issueId, context, config);
	const expectedRevision = Number(entity?.entity_revision || 0);
	// For close, the driver maps event_type='issue.close' to a terminal status; an
	// explicit --status flag (rework move) still wins via the update payload.
	const payload = operation === 'comment'
		? buildCommentPayload(issueId, args)
		: buildUpdatePayload(flags);
	// Comments never bump entity_revision, so a revision-based key would collide for
	// every comment on the same issue (second → false duplicate → silently dropped).
	// Key on the minted comment_id instead. For update/close the synthesized key uses
	// the current revision: a CLI retry re-reads the bumped revision and re-applies
	// (not truly idempotent) — callers needing retry-safety pass context.idempotencyKey.
	const idempotencyKey = context.idempotencyKey || (operation === 'comment'
		? `${ISSUE_MUTATION_EVENT_TYPES.comment}:${issueId}:${payload.comment_id}`
		: `${ISSUE_MUTATION_EVENT_TYPES[operation]}:${issueId}:rev-${expectedRevision}`);
	return {
		entity_type: 'issue',
		entity_id: issueId,
		event_type: ISSUE_MUTATION_EVENT_TYPES[operation],
		idempotency_key: idempotencyKey,
		expected_revision: expectedRevision,
		actor,
		origin,
		payload,
	};
}

function okMutationResponse(commandId, data) {
	return {
		ok: true,
		schema_version: ISSUE_COMMAND_SCHEMA_VERSION,
		command: commandId,
		data,
		next_commands: nextCommandsFor(commandId),
	};
}

// The issue id a mutation event touches: for issue ops it IS the entity_id; for
// dependency/claim ops the entity_id is the dep/claim row id, so the issue lives in
// the payload. Used to report a stable issue revision on a duplicate replay.
function mutationIssueId(operation, event) {
	if (DEPENDENCY_OPERATIONS.has(operation) || CLAIM_OPERATIONS.has(operation)) {
		const payload = parseEventPayload(event);
		return payload.issue_id;
	}
	return event.entity_id;
}

// Map a runGuardedEvent result to an issue-command-contract mutation response (or
// error). A duplicate replay reports the existing single row; a quarantine becomes
// a (sometimes retryable) conflict error; an accept returns
// {id, revision, comment_id?/dependency_id?/claim_id?}.
async function mapMutationResult(driver, operation, event, result, context, config) {
	const commandId = ISSUE_MUTATION_COMMAND_IDS[operation];

	if (result.decision === 'accept') {
		const mutation = result.mutation || {};
		const data = {
			id: mutation.id ?? event.entity_id,
			revision: Number(mutation.revision ?? 0),
		};
		if (mutation.comment_id) data.comment_id = mutation.comment_id;
		if (DEPENDENCY_OPERATIONS.has(operation)) {
			data.dependency_id = mutation.dependency_id ?? event.entity_id;
		}
		if (CLAIM_OPERATIONS.has(operation)) {
			data.claim_id = mutation.claim_id ?? event.entity_id;
		}
		return okMutationResponse(commandId, data);
	}

	if (result.decision === 'duplicate' || result.decision === 'dedupe' || result.decision === 'projection_echo') {
		// Idempotent replay / equivalent write: no double-write. Report the host
		// issue's current persisted revision so the caller sees a stable result. For
		// dep/claim ops the issue id comes from the payload, not the entity_id.
		const issueId = mutationIssueId(operation, event);
		const entity = await driver.loadKernelEntity('issue', issueId, context, config);
		const data = {
			id: event.entity_id,
			revision: Number(entity?.entity_revision || 0),
		};
		if (DEPENDENCY_OPERATIONS.has(operation)) data.dependency_id = event.entity_id;
		if (CLAIM_OPERATIONS.has(operation)) data.claim_id = event.entity_id;
		return okMutationResponse(commandId, data);
	}

	if (result.decision === 'quarantine') {
		const retryable = result.reason === 'stale_revision';
		return formatIssueCommandError({
			command: commandId,
			code: `FORGE_ISSUE_${String(result.reason || 'CONFLICT').toUpperCase()}`,
			message: `Issue mutation ${operation} on ${event.entity_id} was quarantined: ${result.reason}`,
			exitCode: ISSUE_COMMAND_EXIT_CODES.conflict,
			retryable,
			details: { reason: result.reason, entity_id: event.entity_id },
			nextCommands: nextCommandsFor(commandId),
		});
	}

	// Any other decision (should not occur for issue mutations) is an internal error.
	return formatIssueCommandError({
		command: commandId,
		code: 'FORGE_ISSUE_INTERNAL',
		message: `Issue mutation ${operation} returned an unexpected decision: ${result.decision}`,
		exitCode: ISSUE_COMMAND_EXIT_CODES.internal,
		retryable: false,
		nextCommands: nextCommandsFor(commandId),
	});
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

	// The guarded-event pipeline (CAS/idempotency/lease/quarantine + atomic commit).
	// Extracted to a local function so runIssueOperation can route issue mutations
	// through it without re-implementing the path or going through `this`.
	async function runGuardedEventImpl(event, context = {}) {
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
	}

	// Route an issue mutation op through the guarded-event path: build the event,
	// run it, and shape the issue-command-contract response/error.
	async function runIssueMutation(operation, args, context) {
		const config = getConfig();
		const event = await buildIssueMutationEvent(driver, operation, args, context, config);
		const result = await runGuardedEventImpl(event, context);
		return mapMutationResult(driver, operation, event, result, context, config);
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
			// Mutations (create/update/close/comment) flow through the guarded-event
			// path to preserve CAS/idempotency/quarantine; reads delegate directly to
			// the driver's parameterized SELECT branch.
			if (ISSUE_MUTATION_OPERATIONS.has(operation)) {
				requireGuardedDriverMethods(driver);
				requireDriverMethod(driver, 'applyAcceptedIssueMutation');
				return runIssueMutation(operation, args, context);
			}
			requireDriverMethod(driver, 'issueOperation');
			return driver.issueOperation(operation, args, context, getConfig());
		},

		async runGuardedEvent(event, context = {}) {
			return runGuardedEventImpl(event, context);
		},

		// --- Projection-outbox read/update surface (D16) -----------------------
		// Additive read/update methods for projection consumers. These never touch
		// the append/CAS path above (runGuardedEvent / enqueueKernelProjection);
		// they only read and update existing outbox rows or dead-letter them.

		async listProjectionOutbox(filter = {}, context = {}) {
			requireDriverMethod(driver, 'listProjectionOutbox');
			return driver.listProjectionOutbox(filter, context, getConfig());
		},

		async loadProjectionModel(context = {}) {
			requireDriverMethod(driver, 'loadProjectionModel');
			return driver.loadProjectionModel(context, getConfig());
		},

		async markProjectionDelivered(ids, meta = {}, context = {}) {
			requireDriverMethod(driver, 'markProjectionDelivered');
			return driver.markProjectionDelivered(ids, meta, context, getConfig());
		},

		async recordProjectionFailure(record, context = {}) {
			requireDriverMethod(driver, 'recordProjectionFailure');
			return driver.recordProjectionFailure(record, context, getConfig());
		},

		async deadLetterProjection(record, context = {}) {
			requireDriverMethod(driver, 'deadLetterProjection');
			return driver.deadLetterProjection(record, context, getConfig());
		},
	};
}

module.exports = {
	LOCAL_BROKER_PRAGMAS,
	buildLocalBrokerConfig,
	createLocalBroker,
	resolveGitCommonDir,
};
