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
			unsupportedFields: 4,
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
		expect(result.report.gaps).toEqual(expect.arrayContaining([
			expect.objectContaining({ field: 'issues.created_by', reason: 'no Kernel issue creator column in schema v1' }),
			expect.objectContaining({ field: 'issues.owner', reason: 'no Kernel issue owner column in schema v1' }),
			expect.objectContaining({ field: 'dependencies.created_by', reason: 'no Kernel dependency creator column in schema v1' }),
			expect.objectContaining({ field: 'dependencies.metadata', reason: 'no Kernel dependency metadata column in schema v1' }),
		]));
		const gapFields = result.report.gaps.map(gap => gap.field);
		expect(gapFields).not.toContain('issues.labels');
		expect(gapFields).not.toContain('issues.acceptance_criteria');
		expect(result.rollback).toMatchObject({
			available: true,
			mode: 'import-only',
			reason: 'Import did not mutate Beads files; discard imported Kernel records to roll back.',
		});
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

	test('reports malformed Forge projection metadata as unsupported', () => {
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

		expect(importResult.report.gaps).toEqual(expect.arrayContaining([
			expect.objectContaining({ field: 'issues.metadata' }),
		]));
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

	test('reports unsupported legacy Beads event sidecars', () => {
		const snapshot = loadBeadsSnapshotFromDirectory(LEGACY_BACKUP_DIR);
		const result = importBeadsSnapshot(snapshot, { importedAt: IMPORTED_AT });

		expect(snapshot.events).toHaveLength(3);
		expect(result.report.gaps).toEqual(expect.arrayContaining([
			expect.objectContaining({
				field: 'events.jsonl',
				reason: 'legacy Beads event sidecar is not represented in Kernel schema v1',
			}),
		]));
	});

	test('reports unsupported legacy Beads interaction sidecars', () => {
		const result = importBeadsSnapshot({
			issues: [],
			interactions: [{ id: 'interaction-1', event_type: 'field_changed' }],
		}, { importedAt: IMPORTED_AT });

		expect(result.report.gaps).toEqual(expect.arrayContaining([
			expect.objectContaining({
				field: 'interactions.jsonl',
				reason: 'legacy Beads interaction sidecar is not represented in Kernel schema v1',
			}),
		]));
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
		expect(result.report.gaps).toEqual(expect.arrayContaining([
			expect.objectContaining({ field: 'issues.assignee' }),
			expect.objectContaining({ field: 'issues.created_by' }),
			expect.objectContaining({ field: 'issues.design' }),
		]));
		const aa1GapFields = result.report.gaps.map(gap => gap.field);
		expect(aa1GapFields).not.toContain('issues.labels');
		expect(aa1GapFields).not.toContain('issues.acceptance_criteria');
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

	test('preserves a cancelled Kernel status across a Beads round trip', () => {
		const exportResult = exportKernelToBeads({
			issues: [{
				id: 'k-cancelled-native',
				title: 'Abandoned work',
				status: 'cancelled',
				priority: 'P2',
				type: 'task',
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
	});
});
