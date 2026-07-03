'use strict';

const path = require('node:path');
const {
	runJsonlProjectionConsumer,
	readProjection,
	resolveProjectionDir,
	writeProjection,
	DEFAULT_PROJECTION_TARGET,
} = require('../kernel/projection-jsonl-writer');

// Full set the consumer may call — including the retry (recordProjectionFailure)
// and dead-letter (deadLetterProjection) paths — so a partially-implemented
// broker is skipped cleanly instead of failing mid-run.
const PROJECTION_BROKER_METHODS = [
	'listProjectionOutbox',
	'loadProjectionModel',
	'markProjectionDelivered',
	'recordProjectionFailure',
	'deadLetterProjection',
];

/**
 * Parse `forge export` options from positional args (and a parsed flags object
 * as a fallback). Supported: --import, --dry-run, --json, --dir=<path> / --dir <path>.
 */
function parseExportOptions(args = [], flags = {}) {
	const options = {
		import: Boolean(flags.import),
		dryRun: Boolean(flags['dry-run'] || flags.dryRun),
		json: Boolean(flags.json),
		dir: flags.dir,
	};

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === '--import') options.import = true;
		else if (arg === '--dry-run') options.dryRun = true;
		else if (arg === '--json') options.json = true;
		else if (arg.startsWith('--dir=')) options.dir = arg.slice('--dir='.length);
		else if (arg === '--dir') {
			// only consume the next token when it is a real value, not another flag
			const next = args[i + 1];
			if (next && !next.startsWith('--')) {
				options.dir = next;
				i += 1;
			}
		}
	}

	return options;
}

function brokerSupportsProjection(broker) {
	return Boolean(broker) && PROJECTION_BROKER_METHODS.every(method => typeof broker[method] === 'function');
}

function resolveDirArg(dirArg, projectRoot) {
	if (!dirArg) return undefined;
	return path.resolve(projectRoot || process.cwd(), dirArg);
}

function renderHuman(payload) {
	if (payload.error) return `forge export failed: ${payload.error}`;
	if (payload.imported === true) {
		const { issues, comments, dependencies } = payload.counts;
		const skipped = issues.skipped + comments.skipped + dependencies.skipped;
		// Report "Imported N" ONLY for records actually written; a re-import that
		// applies nothing (everything already present) must not claim it imported them.
		if (payload.applied === 0) {
			return `Kernel projection at ${payload.dir} is already hydrated — nothing new imported`
				+ ` (${skipped} record${skipped === 1 ? '' : 's'} already present)`;
		}
		return `Imported Kernel projection from ${payload.dir}`
			+ ` (${issues.inserted} issues, ${comments.inserted} comments, ${dependencies.inserted} dependencies`
			+ (skipped ? `; ${skipped} already present` : '') + ')';
	}
	if (payload.imported === false) return payload.message;
	if (payload.dryRun) return `${payload.pending} pending projection entr${payload.pending === 1 ? 'y' : 'ies'} → ${payload.dir} (dry run, nothing written)`;
	if (payload.skipped) return payload.message;
	if (payload.exported) return `Exported Kernel projection to ${payload.dir} (drained ${payload.drained})`;
	return payload.message || 'Nothing to export';
}

function finalize(options, payload) {
	const output = options.json ? JSON.stringify(payload, null, 2) : renderHuman(payload);
	return { ...payload, output, json: Boolean(options.json) };
}

/**
 * Forge Export Command (D16 — Kernel JSONL portability projection).
 *
 * Explicit, Kernel-owned projection of issues/comments/dependencies to
 * deterministic git-tracked JSONL under `.forge/kernel/`. This is NOT auto-run on
 * mutation/push (D16 forbids that); it is an on-demand portability/bootstrap
 * surface. The `--import` path reads a committed snapshot back from disk (no
 * broker required) and verifies its manifest integrity.
 *
 * @module commands/export
 */
module.exports = {
	name: 'export',
	description: 'Export the Kernel backlog to deterministic git-tracked JSONL (D16 portability projection)',
	usage: 'forge export [--dir <path>] [--dry-run] [--json] [--import]',
	flags: {},

	/**
	 * @param {string[]} args - Positional arguments / flags
	 * @param {object} flags - Parsed CLI flags (fallback source)
	 * @param {string} projectRoot - Project root path
	 * @param {object} [opts] - Dependency injection: _broker, _writer, _now, _fs
	 */
	async handler(args = [], flags = {}, projectRoot, opts = {}) {
		const options = parseExportOptions(args, flags || {});
		const now = opts._now || new Date().toISOString();
		const writer = opts._writer || writeProjection;
		const fsImpl = opts._fs;
		const projectionDir = resolveDirArg(options.dir, projectRoot);

		// --- Import / hydrate (read committed JSONL → write kernel.sqlite) ---
		// readProjection verifies snapshot integrity (sha256, per-file kind, manifest
		// counts, and schema_version compatibility) and throws on any mismatch, so an
		// incompatible/tampered snapshot never reaches the kernel writer.
		if (options.import) {
			try {
				const snapshot = readProjection({ projectionDir, projectRoot, fsImpl });
				if (!snapshot) {
					return finalize(options, {
						success: true,
						imported: false,
						dir: resolveProjectionDir(projectionDir, projectRoot),
						message: 'No projection snapshot found to import',
					});
				}

				const read = {
					issues: snapshot.model.issues.length,
					comments: snapshot.model.comments.length,
					dependencies: snapshot.model.dependencies.length,
				};

				// Hydration requires a projection-capable Kernel broker (importIssues).
				// The CLI injects one for `export` (a Kernel-tool command); without it we
				// validated the snapshot but cannot write — say so instead of claiming an
				// import happened.
				const importBroker = opts._broker || null;
				if (!importBroker || typeof importBroker.importIssues !== 'function') {
					return finalize(options, {
						success: true,
						imported: false,
						dir: snapshot.dir,
						read,
						message: `Read ${read.issues} issues from ${snapshot.dir} but no Kernel broker is `
							+ 'available to import into — nothing was written',
					});
				}

				// importIssues requires the schema/migrations to exist; the CLI broker is
				// pre-initialized, but initialize() is idempotent so calling it is safe.
				if (typeof importBroker.initialize === 'function') {
					await importBroker.initialize();
				}

				// Idempotent + transactional upsert-by-id (ON CONFLICT DO NOTHING).
				const summary = await importBroker.importIssues(snapshot.model, { now });
				const applied = summary.issues.inserted + summary.comments.inserted + summary.dependencies.inserted;

				return finalize(options, {
					success: true,
					imported: true,
					dir: snapshot.dir,
					counts: summary,
					applied,
				});
			} catch (error) {
				return finalize(options, { success: false, imported: false, error: error.message });
			}
		}

		// --- Export (requires a projection-capable Kernel broker) ------------
		const broker = opts._broker || null;
		if (!brokerSupportsProjection(broker)) {
			return finalize(options, {
				success: true,
				exported: false,
				skipped: true,
				message: 'No Kernel broker available — nothing to export',
			});
		}

		if (options.dryRun) {
			const pending = (await broker.listProjectionOutbox({
				target: DEFAULT_PROJECTION_TARGET,
				status: 'pending',
				now,
			})) || [];
			return finalize(options, {
				success: true,
				exported: false,
				dryRun: true,
				pending: pending.length,
				dir: resolveProjectionDir(projectionDir, projectRoot),
			});
		}

		try {
			const run = await runJsonlProjectionConsumer({ broker, projectionDir, projectRoot, now, writer });

			// A write failure leaves entries retried/dead-lettered without a snapshot;
			// surface it as a failure rather than silently reporting success.
			if (!run.written && run.error) {
				return finalize(options, {
					success: false,
					exported: false,
					error: run.error,
					drained: run.drained,
					retried: run.retried,
					dead: run.dead,
					dir: resolveProjectionDir(projectionDir, projectRoot),
				});
			}

			return finalize(options, {
				success: true,
				exported: run.written,
				drained: run.drained,
				delivered: run.delivered,
				retried: run.retried,
				dead: run.dead,
				dir: run.write ? run.write.dir : resolveProjectionDir(projectionDir, projectRoot),
				files: run.write ? run.write.files : [],
			});
		} catch (error) {
			return finalize(options, { success: false, exported: false, error: error.message });
		}
	},
};
