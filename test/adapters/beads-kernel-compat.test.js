const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
	exportKernelToBeads,
	importBeadsSnapshot,
	loadBeadsSnapshotFromDirectory,
	rollbackBeadsExport,
	safeIdPart,
} = require('../../lib/adapters/beads-kernel-compat');
const {
	validateIssueTaxonomy,
	isValidIssueStatus,
	isTerminalStatus,
} = require('../../lib/kernel/taxonomy-validator');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'beads-kernel-adapter');
const LEGACY_BACKUP_DIR = path.join(__dirname, '..', 'fixtures', 'beads-migrate', 'legacy-backup');
const IMPORTED_AT = '2026-06-01T00:00:00.000Z';

function parseJsonl(content) {
	return content
		.trim()
		.split(/\r?\n/)
		.filter(Boolean)
		.map(line => JSON.parse(line));
}

function exportClosedKernelIssue() {
	return exportKernelToBeads({
		issues: [{
			id: 'forge-native',
			title: 'Native Kernel issue',
			body: 'Projected to Beads and imported back.',
			status: 'closed',
			priority: 'P1',
			type: 'task',
			entity_revision: 4,
			created_at: IMPORTED_AT,
			updated_at: IMPORTED_AT,
		}],
		dependencies: [],
		comments: [],
		events: [{
			entity_type: 'issue',
			entity_id: 'forge-native',
			event_type: 'beads.issue.closed',
			payload_json: JSON.stringify({
				closed_at: IMPORTED_AT,
				close_reason: 'Done',
			}),
			created_at: IMPORTED_AT,
		}],
	}, { dryRun: true });
}

describe('Beads Kernel compatibility adapter', () => {
	test('normalizes generated identifier parts without regex backtracking', () => {
		expect(safeIdPart('  Forge CHILD :: Closed!!! ')).toBe('forge-child-closed');
		expect(safeIdPart('---')).toBe('unknown');
	});

	test('imports Beads JSONL into Kernel records with fidelity diagnostics', () => {
		const snapshot = loadBeadsSnapshotFromDirectory(FIXTURE_DIR);
		const result = importBeadsSnapshot(snapshot, { importedAt: IMPORTED_AT });

		expect(result.authority).toBe('forge-kernel');
		expect(result.source).toBe('beads');
		expect(result.kernel.issues).toHaveLength(3);
		expect(result.kernel.issues.find(issue => issue.id === 'forge-child')).toMatchObject({
			id: 'forge-child',
			title: 'Beads adapter slice',
			body: 'Import and export Beads state without making Beads authority.',
			type: 'task',
			status: 'done',
			priority: 'P1',
			priority_rank: 1,
			created_at: '2026-05-29T10:30:00Z',
			updated_at: '2026-05-29T11:30:00Z',
			entity_revision: 0,
		});
		const importedChild = result.kernel.issues.find(issue => issue.id === 'forge-child');
		expect(JSON.parse(importedChild.labels)).toEqual(['0.0.20', 'adapter']);
		expect(importedChild.acceptance_criteria).toBeNull();
		// Full-fidelity import: the beads author is carried onto the Kernel created_by column.
		expect(importedChild.created_by).toBe('Harsha Nanda');
		// forge-child carries no issue-level metadata, so the Kernel metadata column stays null.
		expect(importedChild.metadata).toBeNull();
		expect(result.kernel.dependencies).toEqual(expect.arrayContaining([
			expect.objectContaining({
				issue_id: 'forge-child',
				blocks_issue_id: 'forge-parent',
				dependency_type: 'parent-child',
				created_at: '2026-05-29T10:31:00Z',
			}),
			expect.objectContaining({
				issue_id: 'forge-child',
				blocks_issue_id: 'forge-blocker',
				dependency_type: 'blocks',
				created_at: '2026-05-29T10:32:00Z',
			}),
		]));
		expect(result.kernel.comments).toEqual(expect.arrayContaining([
			expect.objectContaining({
				id: 'comment-forge-child-1',
				issue_id: 'forge-child',
				actor: 'Harsha Nanda',
				body: 'Plan complete; preserve this comment.',
				created_at: '2026-05-29T10:40:00Z',
			}),
			expect.objectContaining({
				id: 'comment-forge-child-2',
				issue_id: 'forge-child',
				actor: 'Worker C',
				body: 'Validation passed before export.',
				created_at: '2026-05-29T11:40:00Z',
			}),
		]));

		const closeEvent = result.kernel.events.find(event => event.event_type === 'beads.issue.closed');
		expect(closeEvent).toMatchObject({
			entity_type: 'issue',
			entity_id: 'forge-child',
			actor: 'Harsha Nanda',
			origin: 'beads_import',
			expected_revision: 0,
			created_at: '2026-05-29T11:45:00Z',
		});
		expect(JSON.parse(closeEvent.payload_json)).toMatchObject({
			close_reason: 'Merged and verified on master (PR #195)',
			closed_at: '2026-05-29T11:45:00Z',
		});

		expect(result.report.summary).toEqual({
			issues: 3,
			dependencies: 2,
			comments: 2,
			closeEvents: 1,
			// This fixture carries no events.jsonl/interactions.jsonl sidecars.
			events: 0,
			interactions: 0,
			activityEvents: 0,
			// Only the dependency creator remains unmapped (no kernel_dependencies.created_by
			// column); owner/assignee/design and the empty "{}" dependency metadata are resolved.
			unsupportedFields: 1,
		});
		expect(result.report.preservedFields).toEqual(expect.arrayContaining([
			'issues.id',
			'issues.priority',
			'issues.labels',
			'issues.acceptance_criteria',
			'dependencies.parent-child',
			'dependencies.blocks',
			'comments.body',
			'events.close_reason',
		]));
		// The dependency creator is the only remaining unmapped field (no dedicated column).
		expect(result.report.gaps).toEqual(expect.arrayContaining([
			expect.objectContaining({ field: 'dependencies.created_by', reason: 'no Kernel dependency creator column in schema v1' }),
		]));
		const gapFields = result.report.gaps.map(gap => gap.field);
		expect(gapFields).not.toContain('issues.labels');
		expect(gapFields).not.toContain('issues.acceptance_criteria');
		// created_by and issue metadata are now carried onto the Kernel record, not dropped.
		expect(gapFields).not.toContain('issues.created_by');
		expect(gapFields).not.toContain('issues.metadata');
		// owner (→ assignee/metadata) and the empty "{}" dependency metadata are no longer gaps.
		expect(gapFields).not.toContain('issues.owner');
		expect(gapFields).not.toContain('dependencies.metadata');
		expect(result.rollback).toMatchObject({
			available: true,
			mode: 'import-only',
			reason: 'Import did not mutate Beads files; discard imported Kernel records to roll back.',
		});
	});

	test('carries beads issue created_by and metadata onto the Kernel record', () => {
		const snapshot = {
			issues: [{
				id: 'forge-md',
				title: 'Issue with author and metadata',
				status: 'open',
				priority: 2,
				issue_type: 'task',
				owner: 'harsha@example.com',
				created_by: 'Harsha Nanda',
				metadata: JSON.stringify({ team: 'kernel', sprint: 3 }),
				created_at: IMPORTED_AT,
				updated_at: IMPORTED_AT,
			}],
		};

		const result = importBeadsSnapshot(snapshot, { importedAt: IMPORTED_AT });
		const [imported] = result.kernel.issues;

		expect(imported.created_by).toBe('Harsha Nanda');
		expect(JSON.parse(imported.metadata)).toEqual({ team: 'kernel', sprint: 3 });

		const gapFields = result.report.gaps.map(gap => gap.field);
		expect(gapFields).not.toContain('issues.created_by');
		expect(gapFields).not.toContain('issues.metadata');
	});

	test('falls back to the beads owner for Kernel created_by when no author is recorded', () => {
		const result = importBeadsSnapshot({
			issues: [{ id: 'forge-owned', title: 'Owner only', status: 'open', owner: 'owner@example.com' }],
		}, { importedAt: IMPORTED_AT });

		expect(result.kernel.issues[0].created_by).toBe('owner@example.com');
	});

	test('folds beads external_ref and started_at into metadata instead of dropping them', () => {
		// Mirrors the real corpus: external_ref links (e.g. gh-88) and a started_at timestamp have
		// no dedicated Kernel column and MUST NOT be silently dropped — they fold into metadata.
		const result = importBeadsSnapshot({
			issues: [{
				id: 'forge-6wy',
				title: 'Linked to GitHub',
				status: 'open',
				owner: 'harsha@example.com',
				created_by: 'Harsha Nanda',
				external_ref: 'gh-88',
				started_at: '2026-04-26T18:00:32Z',
			}],
		}, { importedAt: IMPORTED_AT });

		const [imported] = result.kernel.issues;
		const metadata = JSON.parse(imported.metadata);
		expect(metadata.beads_external_ref).toBe('gh-88');
		expect(metadata.beads_started_at).toBe('2026-04-26T18:00:32Z');
		// Folded, not gapped — and not silently dropped.
		const gapFields = result.report.gaps.map(gap => gap.field);
		expect(gapFields).not.toContain('issues.external_ref');
		expect(gapFields).not.toContain('issues.started_at');
	});

	test('does not double-store owner in metadata when it already maps to assignee', () => {
		const result = importBeadsSnapshot({
			issues: [{
				id: 'forge-owned2',
				title: 'Owner equals assignee',
				status: 'open',
				owner: '  harsha@example.com  ',
				assignee: 'harsha@example.com',
			}],
		}, { importedAt: IMPORTED_AT });

		// A padded owner that matches the (trimmed) assignee is captured, so metadata stays null.
		expect(result.kernel.issues[0].metadata).toBeNull();
	});

	test('reads a split .beads layout — events under backup/, interactions in the parent dir', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beads-split-'));
		try {
			const beadsDir = path.join(tmp, '.beads');
			const backupDir = path.join(beadsDir, 'backup');
			fs.mkdirSync(backupDir, { recursive: true });
			// The backup export holds issues + events; the live interactions/memory log sits in .beads.
			fs.writeFileSync(path.join(backupDir, 'issues.jsonl'), '{"id":"forge-aa1","title":"A","status":"open"}\n');
			fs.writeFileSync(path.join(backupDir, 'events.jsonl'), '{"id":"ev-1","event_type":"created","issue_id":"forge-aa1","actor":"Harsha"}\n');
			fs.writeFileSync(path.join(beadsDir, 'interactions.jsonl'), '{"id":"int-1","kind":"note","issue_id":"forge-aa1","actor":"Harsha","extra":{"note":"hi"}}\n');

			// Pointing at .beads/backup still finds the parent's interactions (memory not missed).
			const fromBackup = loadBeadsSnapshotFromDirectory(backupDir);
			expect(fromBackup.events).toHaveLength(1);
			expect(fromBackup.interactions).toHaveLength(1);

			// Pointing at .beads still finds events under backup/ AND the sibling interactions.
			const fromBeads = loadBeadsSnapshotFromDirectory(beadsDir);
			expect(fromBeads.issues).toHaveLength(1);
			expect(fromBeads.events).toHaveLength(1);
			expect(fromBeads.interactions).toHaveLength(1);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	test('strips the internal forge_projection marker from carried Kernel metadata', () => {
		const snapshot = {
			issues: [{
				id: 'forge-proj',
				title: 'Projection marker only',
				status: 'open',
				priority: 2,
				issue_type: 'task',
				metadata: JSON.stringify({
					forge_projection: { source: 'forge-kernel', target: 'beads' },
				}),
				created_at: IMPORTED_AT,
				updated_at: IMPORTED_AT,
			}],
		};

		const result = importBeadsSnapshot(snapshot, { importedAt: IMPORTED_AT });
		const [imported] = result.kernel.issues;

		// forge_projection is an internal Forge->Beads marker, not user metadata, so it is stripped.
		expect(imported.metadata).toBeNull();
		expect(result.report.gaps.map(gap => gap.field)).not.toContain('issues.metadata');
	});

	test('falls back to revision zero for malformed Beads close-event revisions', () => {
		const snapshot = JSON.parse(JSON.stringify(loadBeadsSnapshotFromDirectory(FIXTURE_DIR)));
		const closedIssue = snapshot.issues.find(issue => issue.id === 'forge-child');
		closedIssue.entity_revision = 'abc';

		const result = importBeadsSnapshot(snapshot, { importedAt: IMPORTED_AT });
		const closeEvent = result.kernel.events.find(event => event.event_type === 'beads.issue.closed');

		expect(closeEvent.expected_revision).toBe(0);
	});

	test('exports Kernel records to Beads JSONL as a dry-run without mutating files', () => {
		const importResult = importBeadsSnapshot(loadBeadsSnapshotFromDirectory(FIXTURE_DIR), { importedAt: IMPORTED_AT });
		const exportResult = exportKernelToBeads(importResult.kernel, { dryRun: true });

		expect(exportResult.dryRun).toBe(true);
		expect(exportResult.writes.map(write => write.file)).toEqual([
			'issues.jsonl',
			'comments.jsonl',
			'dependencies.jsonl',
		]);
		expect(exportResult.rollback).toMatchObject({
			available: false,
			reason: 'Dry-run did not write Beads files.',
		});

		const exportedIssues = parseJsonl(exportResult.files['issues.jsonl']);
		const child = exportedIssues.find(issue => issue.id === 'forge-child');
		expect(child).toMatchObject({
			id: 'forge-child',
			title: 'Beads adapter slice',
			status: 'closed',
			priority: 1,
			issue_type: 'task',
			closed_at: '2026-05-29T11:45:00Z',
			close_reason: 'Merged and verified on master (PR #195)',
			dependency_count: 1,
		});
		expect(child.labels).toEqual(['0.0.20', 'adapter']);
		expect(child.dependencies).toEqual(expect.arrayContaining([
			expect.objectContaining({
				issue_id: 'forge-child',
				depends_on_id: 'forge-parent',
				type: 'parent-child',
			}),
			expect.objectContaining({
				issue_id: 'forge-child',
				depends_on_id: 'forge-blocker',
				type: 'blocks',
			}),
		]));
		expect(parseJsonl(exportResult.files['dependencies.jsonl'])).toEqual(expect.arrayContaining([
			expect.objectContaining({
				issue_id: 'forge-child',
				depends_on_id: 'forge-blocker',
			}),
		]));
		expect(exportedIssues.find(issue => issue.id === 'forge-blocker')).toMatchObject({
			dependent_count: 1,
		});
		expect(exportedIssues.find(issue => issue.id === 'forge-parent')).toMatchObject({
			dependent_count: 0,
		});
		expect(exportResult.report.summary).toMatchObject({
			issues: 3,
			dependencies: 2,
			comments: 2,
			closeEvents: 1,
		});
	});

	test('does not invent Beads issue creators for Kernel-origin exports', () => {
		const exportResult = exportKernelToBeads({
			issues: [{
				id: 'forge-native',
				title: 'Native Kernel issue',
				body: 'Created in Kernel, not imported from Beads.',
				status: 'open',
				priority: 'P2',
				type: 'task',
				created_at: IMPORTED_AT,
				updated_at: IMPORTED_AT,
			}],
			dependencies: [],
			comments: [],
			events: [],
		}, { dryRun: true });

		const [issue] = parseJsonl(exportResult.files['issues.jsonl']);
		expect(issue.created_by).toBeUndefined();
	});

	test('round-trips Forge projection provenance through Beads export and import', () => {
		const exportResult = exportClosedKernelIssue();

		const [exportedIssue] = parseJsonl(exportResult.files['issues.jsonl']);
		expect(JSON.parse(exportedIssue.metadata).forge_projection).toMatchObject({
			source: 'forge-kernel',
			target: 'beads',
			entity_type: 'issue',
			entity_id: 'forge-native',
			entity_revision: 4,
		});

		const importResult = importBeadsSnapshot({
			issues: [exportedIssue],
			comments: [],
			dependencies: [],
		}, { importedAt: IMPORTED_AT });
		const [closeEvent] = importResult.kernel.events;

		expect(closeEvent).toMatchObject({
			entity_type: 'issue',
			entity_id: 'forge-native',
			origin: 'beads_import',
			expected_revision: 4,
		});
		expect(JSON.parse(closeEvent.payload_json).projection_origin).toMatchObject({
			source: 'forge-kernel',
			target: 'beads',
			entity_type: 'issue',
			entity_id: 'forge-native',
			entity_revision: 4,
		});
	});

	test('ignores malformed Forge projection provenance without dropping issue metadata', () => {
		const exportResult = exportClosedKernelIssue();

		const [exportedIssue] = parseJsonl(exportResult.files['issues.jsonl']);
		exportedIssue.metadata = JSON.stringify({
			forge_projection: {
				source: 'forge-kernel',
				target: 'beads',
				entity_type: 'issue',
				entity_id: 'forge-native',
				entity_revision: null,
				payload_hash: JSON.stringify({
					closed_at: IMPORTED_AT,
					close_reason: 'Done',
				}),
			},
		});

		const importResult = importBeadsSnapshot({
			issues: [exportedIssue],
			comments: [],
			dependencies: [],
		}, { importedAt: IMPORTED_AT });
		const [closeEvent] = importResult.kernel.events;

		// Metadata is now carried (not reported as an unsupported gap); the forge_projection marker
		// is stripped, so the only key here leaves an empty Kernel metadata column.
		const gapFields = importResult.report.gaps.map(gap => gap.field);
		expect(gapFields).not.toContain('issues.metadata');
		expect(importResult.kernel.issues[0].metadata).toBeNull();
		// A malformed projection still grants no provenance to the close event.
		expect(JSON.parse(closeEvent.payload_json).projection_origin).toBeUndefined();
	});

	test('does not apply projection origin when close actor drifts after export', () => {
		const exportResult = exportClosedKernelIssue();
		const [exportedIssue] = parseJsonl(exportResult.files['issues.jsonl']);
		exportedIssue.closed_by = 'External Beads User';

		const importResult = importBeadsSnapshot({
			issues: [exportedIssue],
			comments: [],
			dependencies: [],
		}, { importedAt: IMPORTED_AT });
		const [closeEvent] = importResult.kernel.events;

		expect(closeEvent.actor).toBe('External Beads User');
		expect(JSON.parse(closeEvent.payload_json).projection_origin).toBeUndefined();
	});

	test('counts only blocking dependency edges on Beads export', () => {
		const exportResult = exportKernelToBeads({
			issues: [
				{ id: 'forge-work', title: 'Work', status: 'open', priority: 'P2', type: 'task' },
				{ id: 'forge-blocker', title: 'Blocker', status: 'open', priority: 'P2', type: 'task' },
				{ id: 'forge-related', title: 'Related', status: 'open', priority: 'P2', type: 'task' },
				{ id: 'forge-parent', title: 'Parent', status: 'open', priority: 'P2', type: 'task' },
			],
			dependencies: [
				{ issue_id: 'forge-work', blocks_issue_id: 'forge-blocker', dependency_type: 'blocks' },
				{ issue_id: 'forge-work', blocks_issue_id: 'forge-related', dependency_type: 'related' },
				{ issue_id: 'forge-work', blocks_issue_id: 'forge-parent', dependency_type: 'parent-child' },
			],
			comments: [],
			events: [],
		}, { dryRun: true });

		const exportedIssues = parseJsonl(exportResult.files['issues.jsonl']);
		expect(exportedIssues.find(issue => issue.id === 'forge-work')).toMatchObject({
			dependency_count: 1,
		});
		expect(exportedIssues.find(issue => issue.id === 'forge-blocker')).toMatchObject({
			dependent_count: 1,
		});
		expect(exportedIssues.find(issue => issue.id === 'forge-related')).toMatchObject({
			dependent_count: 0,
		});
		expect(exportedIssues.find(issue => issue.id === 'forge-parent')).toMatchObject({
			dependent_count: 0,
		});
	});

	test('lands legacy Beads activity events in the Kernel activity log without gaps', () => {
		const snapshot = loadBeadsSnapshotFromDirectory(LEGACY_BACKUP_DIR);
		const result = importBeadsSnapshot(snapshot, { importedAt: IMPORTED_AT });

		expect(snapshot.events).toHaveLength(3);
		// The event sidecar is no longer a data-loss gap — every event maps into activityEvents.
		expect(result.report.gaps.map(gap => gap.field)).not.toContain('events.jsonl');
		const created = result.kernel.activityEvents.find(
			event => event.event_type === 'beads.event.created' && event.entity_id === 'forge-aa1',
		);
		expect(created).toMatchObject({
			entity_type: 'issue',
			entity_id: 'forge-aa1',
			actor: 'Harsha Nanda',
			origin: 'beads_import',
			expected_revision: 0,
		});
		expect(JSON.parse(created.payload_json)).toMatchObject({ kind: 'created' });
		// The dependency_added event's new_value survives verbatim in the payload.
		const depAdded = result.kernel.activityEvents.find(event => event.event_type === 'beads.event.dependency_added');
		expect(JSON.parse(depAdded.payload_json)).toMatchObject({ kind: 'dependency_added', new_value: 'forge-aa1' });
	});

	test('lands legacy Beads interaction records in the Kernel activity log without gaps', () => {
		const result = importBeadsSnapshot({
			issues: [],
			interactions: [{
				id: 'interaction-1',
				kind: 'field_change',
				actor: 'Harsha Nanda',
				issue_id: 'forge-xyz',
				extra: { field: 'status', new_value: 'closed' },
			}],
		}, { importedAt: IMPORTED_AT });

		expect(result.report.gaps.map(gap => gap.field)).not.toContain('interactions.jsonl');
		expect(result.kernel.activityEvents).toHaveLength(1);
		const [interaction] = result.kernel.activityEvents;
		expect(interaction.id).toMatch(/^beads-interaction-/);
		expect(interaction).toMatchObject({
			entity_type: 'issue',
			entity_id: 'forge-xyz',
			event_type: 'beads.interaction.field_change',
			idempotency_key: 'beads-interaction:interaction-1',
			actor: 'Harsha Nanda',
			origin: 'beads_import',
		});
		expect(JSON.parse(interaction.payload_json)).toMatchObject({
			kind: 'field_change',
			field: 'status',
			new_value: 'closed',
		});
	});

	test('surfaces an unmigrated Beads sidecar (config.jsonl) as an honest gap', () => {
		const snapshot = loadBeadsSnapshotFromDirectory(LEGACY_BACKUP_DIR);
		const result = importBeadsSnapshot(snapshot, { importedAt: IMPORTED_AT });

		// config.jsonl is present in the store but has no Kernel target. It must be
		// reported honestly, never silently dropped — that unread-sidecar data loss is
		// exactly the class this migrator exists to close.
		expect(snapshot.unmigratedSidecars).toContain('config.jsonl');
		const gap = result.report.gaps.find(entry => entry.field === 'sidecar.config.jsonl');
		expect(gap).toBeDefined();
		expect(gap.reason).toMatch(/no Kernel target|not migrated/i);
		// Handled sidecars are never falsely reported as unmigrated.
		expect(snapshot.unmigratedSidecars).not.toContain('issues.jsonl');
		expect(snapshot.unmigratedSidecars).not.toContain('interactions.jsonl');
	});

	test('surfaces a real sidecar-scan failure (ENOTDIR) as an honest gap, not a silent skip', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beads-scan-fail-'));
		const beadsDir = path.join(tmpDir, '.beads');
		fs.mkdirSync(beadsDir);
		fs.writeFileSync(path.join(beadsDir, 'issues.jsonl'), '');
		// Make the `backup/` scan CANDIDATE a FILE — readdirSync throws ENOTDIR, a real
		// scan failure that could hide sidecars. A missing candidate (ENOENT) is fine to
		// swallow; a real error must be surfaced, never silently treated as "no sidecars".
		fs.writeFileSync(path.join(beadsDir, 'backup'), 'not a directory');
		try {
			const snapshot = loadBeadsSnapshotFromDirectory(beadsDir);
			const result = importBeadsSnapshot(snapshot, { importedAt: IMPORTED_AT });

			const scanGap = result.report.gaps.find(entry => entry.field.startsWith('sidecar-scan.'));
			expect(scanGap).toBeDefined();
			expect(scanGap.reason).toMatch(/could not scan|ENOTDIR/i);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test('imports label sidecars and issue notes with explicit fidelity coverage', () => {
		const snapshot = {
			issues: [{
				id: 'forge-aa1',
				title: 'Legacy issue one',
				description: 'Migrate the oldest active issue into Dolt without changing its id.',
				notes: 'Preserve this issue during migration.',
				design: 'Use the legacy Beads migration design.',
				acceptance_criteria: ['Imported issue keeps migration context visible.'],
				assignee: 'harsha@example.com',
				status: 'open',
				priority: 1,
				issue_type: 'feature',
				created_at: '2026-04-01T09:00:00Z',
				created_by: 'Harsha Nanda',
				updated_at: '2026-04-01T09:00:00Z',
			}],
			labels: [{ issue_id: 'forge-aa1', label: 'migration' }],
		};

		const result = importBeadsSnapshot(snapshot, { importedAt: IMPORTED_AT });

		expect(result.kernel.comments).toEqual(expect.arrayContaining([
			expect.objectContaining({
				issue_id: 'forge-aa1',
				body: 'Preserve this issue during migration.',
				actor: 'Harsha Nanda',
			}),
		]));
		const importedIssue = result.kernel.issues.find(issue => issue.id === 'forge-aa1');
		expect(importedIssue.type).toBe('task');
		expect(JSON.parse(importedIssue.labels)).toEqual(expect.arrayContaining(['migration', 'feature']));
		expect(importedIssue.acceptance_criteria).toBe(JSON.stringify(['Imported issue keeps migration context visible.']));
		// The beads author is carried; "{}" metadata holds no user data, so the column stays null.
		expect(importedIssue.created_by).toBe('Harsha Nanda');
		expect(importedIssue.metadata).toBeNull();
		// assignee and design now land on their dedicated Kernel columns (migration 004), not gaps.
		expect(importedIssue.assignee).toBe('harsha@example.com');
		expect(importedIssue.design).toBe('Use the legacy Beads migration design.');
		const aa1GapFields = result.report.gaps.map(gap => gap.field);
		expect(aa1GapFields).not.toContain('issues.labels');
		expect(aa1GapFields).not.toContain('issues.acceptance_criteria');
		// created_by/assignee/design are now carried onto the Kernel record, no longer gaps.
		expect(aa1GapFields).not.toContain('issues.created_by');
		expect(aa1GapFields).not.toContain('issues.assignee');
		expect(aa1GapFields).not.toContain('issues.design');
	});

	test('imports dependency rows with non-lossy generated ids', () => {
		const result = importBeadsSnapshot({
			issues: [
				{ id: 'forge-2agy.2.3', title: 'Dotted', status: 'open' },
				{ id: 'forge-2agy-2-3', title: 'Dashed', status: 'open' },
				{ id: 'forge-blocker', title: 'Blocker', status: 'open' },
			],
			dependencies: [
				{ issue_id: 'forge-2agy.2.3', depends_on_id: 'forge-blocker', type: 'blocks' },
				{ issue_id: 'forge-2agy-2-3', depends_on_id: 'forge-blocker', type: 'blocks' },
			],
		}, { importedAt: IMPORTED_AT });

		expect(result.kernel.dependencies).toHaveLength(2);
		expect(new Set(result.kernel.dependencies.map(dependency => dependency.id)).size).toBe(2);
		expect(new Set(result.kernel.priorityEvents.map(event => event.id)).size).toBe(3);
		expect(result.kernel.dependencies.map(dependency => dependency.issue_id)).toEqual([
			'forge-2agy.2.3',
			'forge-2agy-2-3',
		]);
	});

	test('imports issue-derived event ids without punctuation collisions', () => {
		const result = importBeadsSnapshot({
			issues: [
				{
					id: 'forge-2agy.2.3',
					title: 'Dotted',
					status: 'closed',
					closed_at: '2026-06-01T01:00:00.000Z',
				},
				{
					id: 'forge-2agy-2-3',
					title: 'Dashed',
					status: 'closed',
					closed_at: '2026-06-01T02:00:00.000Z',
				},
			],
		}, { importedAt: IMPORTED_AT });

		expect(result.kernel.priorityEvents).toHaveLength(2);
		expect(result.kernel.events).toHaveLength(2);
		expect(new Set(result.kernel.priorityEvents.map(event => event.id)).size).toBe(2);
		expect(new Set(result.kernel.events.map(event => event.id)).size).toBe(2);
	});

	test('writes Beads exports with an explicit rollback snapshot', () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-beads-export-'));
		try {
			fs.writeFileSync(path.join(tempDir, 'issues.jsonl'), '{"id":"old"}\n');
			fs.writeFileSync(path.join(tempDir, 'comments.jsonl'), '{"id":"old-comment"}\n');
			fs.writeFileSync(path.join(tempDir, 'dependencies.jsonl'), '{"issue_id":"old"}\n');

			const importResult = importBeadsSnapshot(loadBeadsSnapshotFromDirectory(FIXTURE_DIR), { importedAt: IMPORTED_AT });
			const exportResult = exportKernelToBeads(importResult.kernel, {
				beadsDir: tempDir,
				dryRun: false,
			});

			expect(exportResult.dryRun).toBe(false);
			expect(exportResult.rollback).toMatchObject({
				available: true,
				files: ['issues.jsonl', 'comments.jsonl', 'dependencies.jsonl'],
			});
			expect(fs.readFileSync(path.join(tempDir, 'issues.jsonl'), 'utf8')).toContain('forge-child');

			rollbackBeadsExport(exportResult.rollback);

			expect(fs.readFileSync(path.join(tempDir, 'issues.jsonl'), 'utf8')).toBe('{"id":"old"}\n');
			expect(fs.readFileSync(path.join(tempDir, 'comments.jsonl'), 'utf8')).toBe('{"id":"old-comment"}\n');
			expect(fs.readFileSync(path.join(tempDir, 'dependencies.jsonl'), 'utf8')).toBe('{"issue_id":"old"}\n');
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('restores rollback snapshot when an export write fails', () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-beads-export-fail-'));
		const originalWriteFileSync = fs.writeFileSync;
		try {
			fs.writeFileSync(path.join(tempDir, 'issues.jsonl'), '{"id":"old"}\n');
			fs.writeFileSync(path.join(tempDir, 'comments.jsonl'), '{"id":"old-comment"}\n');
			fs.writeFileSync(path.join(tempDir, 'dependencies.jsonl'), '{"issue_id":"old"}\n');
			fs.writeFileSync = (filePath, content, ...args) => {
				if (String(filePath).endsWith('dependencies.jsonl') && String(content).includes('forge-child')) {
					throw new Error('simulated dependency export failure');
				}
				return originalWriteFileSync.call(fs, filePath, content, ...args);
			};

			const importResult = importBeadsSnapshot(loadBeadsSnapshotFromDirectory(FIXTURE_DIR), { importedAt: IMPORTED_AT });

			expect(() => exportKernelToBeads(importResult.kernel, {
				beadsDir: tempDir,
				dryRun: false,
			})).toThrow('simulated dependency export failure');
			expect(fs.readFileSync(path.join(tempDir, 'issues.jsonl'), 'utf8')).toBe('{"id":"old"}\n');
			expect(fs.readFileSync(path.join(tempDir, 'comments.jsonl'), 'utf8')).toBe('{"id":"old-comment"}\n');
			expect(fs.readFileSync(path.join(tempDir, 'dependencies.jsonl'), 'utf8')).toBe('{"issue_id":"old"}\n');
		} finally {
			fs.writeFileSync = originalWriteFileSync;
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('normalizes legacy issue types and closed status so imports pass D18 validation', () => {
		const snapshot = {
			issues: [
				{
					id: 'legacy-feature',
					title: 'Feature work',
					status: 'closed',
					issue_type: 'feature',
					priority: 1,
					labels: ['frontend'],
					closed_at: '2026-05-01T00:00:00Z',
					close_reason: 'Shipped and verified',
					created_at: '2026-04-01T00:00:00Z',
					updated_at: '2026-05-01T00:00:00Z',
				},
				{ id: 'legacy-story', title: 'Story work', status: 'open', issue_type: 'story', priority: 2 },
				{ id: 'legacy-chore', title: 'Chore work', status: 'in_progress', issue_type: 'chore', priority: 3 },
				{
					id: 'legacy-spike',
					title: 'Spike work',
					status: 'closed',
					issue_type: 'spike',
					priority: 2,
					close_reason: 'Cancelled — superseded by a follow-up spike',
				},
			],
		};

		const result = importBeadsSnapshot(snapshot, { importedAt: IMPORTED_AT });

		// Item 2 property: every imported legacy issue passes the real D18 validation layer.
		for (const issue of result.kernel.issues) {
			expect(validateIssueTaxonomy(issue)).toEqual({ valid: true, errors: [] });
			expect(isValidIssueStatus(issue.status)).toBe(true);
		}

		const byId = Object.fromEntries(result.kernel.issues.map(issue => [issue.id, issue]));
		expect(byId['legacy-feature']).toMatchObject({ type: 'task', status: 'done' });
		expect(JSON.parse(byId['legacy-feature'].labels)).toEqual(expect.arrayContaining(['frontend', 'feature']));
		expect(byId['legacy-story']).toMatchObject({ type: 'task', status: 'open' });
		expect(JSON.parse(byId['legacy-story'].labels)).toContain('story');
		expect(byId['legacy-chore']).toMatchObject({ type: 'task', status: 'in_progress' });
		expect(byId['legacy-spike']).toMatchObject({ type: 'task', status: 'cancelled' });
		expect(isTerminalStatus(byId['legacy-spike'].status)).toBe(true);
	});

	test('round-trips labels and acceptance criteria through the Kernel columns', () => {
		const snapshot = {
			issues: [{
				id: 'forge-rt',
				title: 'Round-trip issue',
				status: 'open',
				priority: 2,
				issue_type: 'task',
				labels: ['alpha', 'beta'],
				acceptance_criteria: 'Given X, when Y, then Z.',
				created_at: IMPORTED_AT,
				updated_at: IMPORTED_AT,
			}],
		};

		const importResult = importBeadsSnapshot(snapshot, { importedAt: IMPORTED_AT });
		const [imported] = importResult.kernel.issues;
		expect(JSON.parse(imported.labels)).toEqual(['alpha', 'beta']);
		expect(imported.acceptance_criteria).toBe('Given X, when Y, then Z.');
		expect(importResult.report.gaps.map(gap => gap.field)).not.toContain('issues.labels');

		const exportResult = exportKernelToBeads(importResult.kernel, { dryRun: true });
		const [exported] = parseJsonl(exportResult.files['issues.jsonl']);
		expect(exported.labels).toEqual(['alpha', 'beta']);
		expect(exported.acceptance_criteria).toBe('Given X, when Y, then Z.');
	});

	test('maps terminal Kernel statuses back to the Beads closed vocabulary on export', () => {
		const exportResult = exportKernelToBeads({
			issues: [
				{ id: 'k-done', title: 'Done', status: 'done', priority: 'P2', type: 'task', created_at: IMPORTED_AT, updated_at: IMPORTED_AT },
				{ id: 'k-cancelled', title: 'Cancelled', status: 'cancelled', priority: 'P2', type: 'task', created_at: IMPORTED_AT, updated_at: IMPORTED_AT },
				{ id: 'k-open', title: 'Open', status: 'open', priority: 'P2', type: 'task', created_at: IMPORTED_AT, updated_at: IMPORTED_AT },
			],
			dependencies: [],
			comments: [],
			events: [],
		}, { dryRun: true });

		const issues = parseJsonl(exportResult.files['issues.jsonl']);
		expect(issues.find(issue => issue.id === 'k-done').status).toBe('closed');
		expect(issues.find(issue => issue.id === 'k-cancelled').status).toBe('closed');
		expect(issues.find(issue => issue.id === 'k-open').status).toBe('open');
	});

	test('round-trips structured acceptance_criteria as an array, not a JSON string', () => {
		const criteria = ['Given a legacy issue', 'When imported', 'Then criteria survive'];
		const snapshot = {
			issues: [{
				id: 'forge-ac',
				title: 'Structured AC',
				status: 'open',
				priority: 2,
				issue_type: 'task',
				acceptance_criteria: criteria,
				created_at: IMPORTED_AT,
				updated_at: IMPORTED_AT,
			}],
		};

		const importResult = importBeadsSnapshot(snapshot, { importedAt: IMPORTED_AT });
		const [imported] = importResult.kernel.issues;
		// Stored as a JSON array string in the Kernel TEXT column.
		expect(imported.acceptance_criteria).toBe(JSON.stringify(criteria));

		const exportResult = exportKernelToBeads(importResult.kernel, { dryRun: true });
		const [exported] = parseJsonl(exportResult.files['issues.jsonl']);
		// Export restores the original array shape rather than the verbatim JSON string.
		expect(exported.acceptance_criteria).toEqual(criteria);
	});

	test('preserves a cancelled Kernel status and revision provenance across a Beads round trip', () => {
		const exportResult = exportKernelToBeads({
			issues: [{
				id: 'k-cancelled-native',
				title: 'Abandoned work',
				status: 'cancelled',
				priority: 'P2',
				type: 'task',
				entity_revision: 7,
				created_at: IMPORTED_AT,
				updated_at: IMPORTED_AT,
			}],
			dependencies: [],
			comments: [],
			events: [],
		}, { dryRun: true });

		const [exported] = parseJsonl(exportResult.files['issues.jsonl']);
		expect(exported.status).toBe('closed');
		// Cancellation is recorded so it survives re-import rather than defaulting to done.
		expect(exported.close_reason).toMatch(/cancel/i);

		const importResult = importBeadsSnapshot(
			{ issues: [exported], comments: [], dependencies: [] },
			{ importedAt: IMPORTED_AT },
		);
		expect(importResult.kernel.issues[0].status).toBe('cancelled');
		// Projection metadata is built over the final close_reason, so revision provenance survives:
		// the close event keeps the original entity_revision rather than falling back to 0.
		const [closeEvent] = importResult.kernel.events;
		expect(closeEvent.expected_revision).toBe(7);
		expect(JSON.parse(closeEvent.payload_json).projection_origin).toMatchObject({ entity_revision: 7 });
	});
});
