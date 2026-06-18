'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseJsonl, stringifyJsonl } = require('../adapters/beads-kernel-compat');

const SCHEMA_VERSION = 1;

// Deterministic write/rename order. manifest.json is renamed last so a partial
// write never leaves a manifest pointing at incomplete JSONL (the manifest is
// effectively the commit marker for the snapshot).
const PROJECTION_FILE_ORDER = ['issues.jsonl', 'comments.jsonl', 'dependencies.jsonl', 'manifest.json'];
const DEFAULT_PROJECTION_DIR = path.join('.forge', 'kernel');

// Fixed key insertion order per D16-a and D16-c
const ISSUE_KEYS = ['kind', 'id', 'title', 'body', 'type', 'status', 'priority', 'priority_rank', 'created_at', 'updated_at', 'entity_revision'];
const COMMENT_KEYS = ['kind', 'id', 'issue_id', 'body', 'actor', 'visibility', 'created_at'];
const DEP_KEYS = ['kind', 'id', 'issue_id', 'blocks_issue_id', 'dependency_type', 'created_at'];

function pickKeys(record, keys) {
	const out = {};
	for (const key of keys) {
		out[key] = Object.prototype.hasOwnProperty.call(record, key) ? record[key] : null;
	}
	return out;
}

function normalizeIssue(raw) {
	return pickKeys({ ...raw, kind: 'issue', body: raw.body ?? null }, ISSUE_KEYS);
}

function normalizeComment(raw) {
	return pickKeys({ ...raw, kind: 'comment' }, COMMENT_KEYS);
}

function normalizeDependency(raw) {
	return pickKeys({ ...raw, kind: 'dependency' }, DEP_KEYS);
}

function normalizeProjectionModel(model) {
	return {
		issues: (model.issues || []).map(normalizeIssue),
		comments: (model.comments || []).map(normalizeComment),
		dependencies: (model.dependencies || []).map(normalizeDependency),
	};
}

function cmp(a, b) {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

function buildProjectionSnapshot(model) {
	const issues = [...model.issues].sort((a, b) => cmp(a.id, b.id));

	const comments = [...model.comments].sort((a, b) =>
		cmp(a.issue_id, b.issue_id) || cmp(a.created_at, b.created_at) || cmp(a.id, b.id),
	);

	const dependencies = [...model.dependencies].sort((a, b) =>
		cmp(a.issue_id, b.issue_id) ||
		cmp(a.blocks_issue_id, b.blocks_issue_id) ||
		cmp(a.dependency_type, b.dependency_type) ||
		cmp(a.id, b.id),
	);

	return { issues, comments, dependencies };
}

function serializeProjection(model) {
	const snap = buildProjectionSnapshot(model);

	const issuesJsonl = stringifyJsonl(snap.issues);
	const commentsJsonl = stringifyJsonl(snap.comments);
	const depsJsonl = stringifyJsonl(snap.dependencies);

	const contentSha256 = crypto
		.createHash('sha256')
		.update(issuesJsonl)
		.update(commentsJsonl)
		.update(depsJsonl)
		.digest('hex');

	const manifest = {
		schema_version: SCHEMA_VERSION,
		source: 'kernel',
		counts: {
			issues: snap.issues.length,
			comments: snap.comments.length,
			dependencies: snap.dependencies.length,
		},
		content_sha256: contentSha256,
	};

	return {
		files: {
			'issues.jsonl': issuesJsonl,
			'comments.jsonl': commentsJsonl,
			'dependencies.jsonl': depsJsonl,
			'manifest.json': JSON.stringify(manifest, null, 2) + '\n',
		},
	};
}

function importProjection(files) {
	if (!files['manifest.json']) {
		throw new Error('Missing manifest.json in projection files');
	}

	const manifest = JSON.parse(files['manifest.json']);

	const issuesJsonl = files['issues.jsonl'] || '';
	const commentsJsonl = files['comments.jsonl'] || '';
	const depsJsonl = files['dependencies.jsonl'] || '';

	const actualSha256 = crypto
		.createHash('sha256')
		.update(issuesJsonl)
		.update(commentsJsonl)
		.update(depsJsonl)
		.digest('hex');

	if (actualSha256 !== manifest.content_sha256) {
		throw new Error(
			`sha256 mismatch: manifest has ${manifest.content_sha256}, computed ${actualSha256}`,
		);
	}

	return {
		issues: issuesJsonl ? parseJsonl(issuesJsonl, 'issues.jsonl') : [],
		comments: commentsJsonl ? parseJsonl(commentsJsonl, 'comments.jsonl') : [],
		dependencies: depsJsonl ? parseJsonl(depsJsonl, 'dependencies.jsonl') : [],
	};
}

function resolveProjectionDir(projectionDir, projectRoot) {
	const resolved = path.resolve(projectionDir || (projectRoot ? path.join(projectRoot, DEFAULT_PROJECTION_DIR) : DEFAULT_PROJECTION_DIR));

	if (projectRoot) {
		const root = path.resolve(projectRoot);
		const relative = path.relative(root, resolved);
		const escapes = relative.startsWith('..') || path.isAbsolute(relative);
		if (escapes) {
			throw new Error(`Projection directory escapes the project root: ${resolved}`);
		}
	}

	return resolved;
}

// Atomic-ish multi-file write: render every file to a sibling temp, snapshot the
// existing targets, then rename temps into place in a fixed order. If any rename
// throws, restore the snapshot (rewrite prior content or delete files that did
// not previously exist) and clean up temps before rethrowing. A projection write
// failure must never leave a half-applied snapshot on disk.
function writeProjection({ model, projectionDir, projectRoot, fsImpl } = {}) {
	const io = fsImpl || fs;
	const dir = resolveProjectionDir(projectionDir, projectRoot);
	const { files } = serializeProjection(model);

	io.mkdirSync(dir, { recursive: true });

	const tempPaths = [];
	let bytes = 0;
	for (const name of PROJECTION_FILE_ORDER) {
		const content = files[name];
		const tempPath = path.join(dir, `.tmp-${name}`);
		io.writeFileSync(tempPath, content);
		tempPaths.push(tempPath);
		bytes += Buffer.byteLength(content, 'utf8');
	}

	const snapshots = [];
	const renamed = [];
	try {
		for (let i = 0; i < PROJECTION_FILE_ORDER.length; i += 1) {
			const name = PROJECTION_FILE_ORDER[i];
			const target = path.join(dir, name);
			const existed = io.existsSync(target);
			snapshots.push({ target, existed, content: existed ? io.readFileSync(target) : null });
			io.renameSync(tempPaths[i], target);
			renamed.push(target);
		}
	} catch (error) {
		rollbackProjectionWrite(io, snapshots, renamed);
		cleanupTempFiles(io, tempPaths);
		throw error;
	}

	cleanupTempFiles(io, tempPaths);

	return {
		dir,
		writes: PROJECTION_FILE_ORDER.length,
		bytes,
		files: [...PROJECTION_FILE_ORDER],
	};
}

function rollbackProjectionWrite(io, snapshots, renamed) {
	const renamedSet = new Set(renamed);
	for (const snapshot of snapshots) {
		if (!renamedSet.has(snapshot.target)) {
			continue;
		}
		if (snapshot.existed) {
			io.writeFileSync(snapshot.target, snapshot.content);
		} else {
			removeIfPresent(io, snapshot.target);
		}
	}
}

function cleanupTempFiles(io, tempPaths) {
	for (const tempPath of tempPaths) {
		removeIfPresent(io, tempPath);
	}
}

function removeIfPresent(io, target) {
	try {
		if (io.existsSync(target)) {
			io.rmSync(target, { force: true });
		}
	} catch {
		// best-effort cleanup; never mask the original failure
	}
}

const DEFAULT_PROJECTION_TARGET = 'jsonl';
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_BACKOFF_MS = 5000;

function computeBackoff(now, attempts, baseBackoffMs) {
	const start = Date.parse(now);
	const delay = baseBackoffMs * 2 ** Math.max(0, attempts - 1);
	return new Date(start + delay).toISOString();
}

// Outbox-driven JSONL consumer. Pending kernel_outbox rows for the projection
// target are dirty markers; draining them performs ONE full-snapshot write that
// covers all of them. On success every drained row is marked delivered. On write
// failure each row increments its attempt count: rows below maxAttempts return to
// pending with an exponential backoff; rows that reach maxAttempts are
// dead-lettered. A projection failure never mutates Kernel authority.
async function runJsonlProjectionConsumer({
	broker,
	projectionDir,
	projectRoot,
	now = new Date().toISOString(),
	maxAttempts = DEFAULT_MAX_ATTEMPTS,
	baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
	target = DEFAULT_PROJECTION_TARGET,
	writer = writeProjection,
} = {}) {
	const pending = (await broker.listProjectionOutbox({ target, status: 'pending', now })) || [];
	if (pending.length === 0) {
		return { drained: 0, written: false, delivered: [], retried: [], dead: [] };
	}

	const model = await broker.loadProjectionModel();

	let write;
	try {
		write = writer({ model, projectionDir, projectRoot });
	} catch (error) {
		const retried = [];
		const dead = [];
		for (const entry of pending) {
			const attempts = (entry.attempts || 0) + 1;
			if (attempts >= maxAttempts) {
				await broker.deadLetterProjection({
					outbox_id: entry.id,
					target,
					error: error.message,
					payload_json: JSON.stringify({ event_id: entry.event_id, attempts }),
					now,
				});
				dead.push(entry.id);
			} else {
				await broker.recordProjectionFailure({
					id: entry.id,
					attempts,
					next_attempt_at: computeBackoff(now, attempts, baseBackoffMs),
					error: error.message,
					now,
				});
				retried.push(entry.id);
			}
		}
		return { drained: pending.length, written: false, error: error.message, delivered: [], retried, dead };
	}

	const delivered = pending.map(entry => entry.id);
	await broker.markProjectionDelivered(delivered, { now });

	return { drained: pending.length, written: true, write, delivered, retried: [], dead: [] };
}

module.exports = {
	DEFAULT_PROJECTION_DIR,
	DEFAULT_PROJECTION_TARGET,
	DEFAULT_MAX_ATTEMPTS,
	PROJECTION_FILE_ORDER,
	normalizeProjectionModel,
	buildProjectionSnapshot,
	serializeProjection,
	importProjection,
	resolveProjectionDir,
	writeProjection,
	computeBackoff,
	runJsonlProjectionConsumer,
};
