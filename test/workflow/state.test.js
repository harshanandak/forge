const { describe, expect, test } = require('bun:test');

const {
	STAGE_IDS,
	STAGE_MODEL,
	WORKFLOW_STAGE_MATRIX,
	WORKFLOW_TERMINAL_STAGES,
	getWorkflowPath,
} = require('../../lib/workflow/stages.js');

const {
	normalizeOverrideRecord,
	readWorkflowState,
	serializeWorkflowState,
	writeWorkflowState,
} = require('../../lib/workflow/state.js');

describe('workflow state layer', () => {
	test('exports canonical stage ids and the documented workflow matrix', () => {
		expect(STAGE_IDS).toEqual([
			'plan',
			'dev',
			'validate',
			'ship',
			'review',
			'premerge',
			'verify',
		]);

		expect(Object.keys(STAGE_MODEL)).toEqual(STAGE_IDS);
		expect(getWorkflowPath('standard')).toEqual(['plan', 'dev', 'validate', 'ship', 'review', 'premerge']);
		expect(getWorkflowPath('critical')).toEqual(['plan', 'dev', 'validate', 'ship', 'review', 'premerge', 'verify']);
		expect(getWorkflowPath('refactor')).toEqual(['plan', 'dev', 'validate', 'ship', 'premerge']);
		expect(getWorkflowPath('simple')).toEqual(['dev', 'validate', 'ship']);
		expect(getWorkflowPath('hotfix')).toEqual(['dev', 'validate', 'ship']);
		expect(getWorkflowPath('docs')).toEqual(['verify', 'ship']);
		expect(WORKFLOW_STAGE_MATRIX.standard).toEqual(['plan', 'dev', 'validate', 'ship', 'review', 'premerge']);
		expect(WORKFLOW_TERMINAL_STAGES).toEqual({
			critical: 'verify',
			standard: 'premerge',
			refactor: 'premerge',
			simple: 'ship',
			hotfix: 'ship',
			docs: 'ship',
		});
		expect(STAGE_MODEL.plan.workflows.standard.nextStages).toEqual(['dev']);
		expect(STAGE_MODEL.verify.workflows.docs.nextStages).toEqual(['ship']);
		expect(STAGE_MODEL.ship.workflows.standard.terminal).toBe(false);
		expect(STAGE_MODEL.ship.workflows.simple.terminal).toBe(true);
	});

	test('rejects invalid workflow transitions but accepts classification-aware routes', () => {
		expect(() =>
			serializeWorkflowState({
				currentStage: 'ship',
				previousStage: 'plan',
				completedStages: ['plan'],
				skippedStages: [],
				workflowDecisions: {
					classification: 'standard',
					reason: 'Manual promotion',
					userOverride: false,
					overrides: [],
				},
				parallelTracks: [],
			}),
		).toThrow(/invalid workflow transition/i);

		expect(() =>
			serializeWorkflowState({
				currentStage: 'ship',
				previousStage: 'verify',
				completedStages: ['verify'],
				skippedStages: [],
				workflowDecisions: {
					classification: 'docs',
					reason: 'Docs workflow',
					userOverride: false,
					overrides: [],
				},
				parallelTracks: [],
			}),
		).not.toThrow();
	});

	test('serializes a valid transition into structured Beads metadata', () => {
		const payload = serializeWorkflowState({
			currentStage: 'dev',
			previousStage: 'plan',
			completedStages: ['plan'],
			skippedStages: [],
			workflowDecisions: {
				classification: 'standard',
				reason: 'Promoted after plan approval',
				userOverride: false,
				overrides: [
					{
						type: 'manual',
						fromStage: 'plan',
						toStage: 'dev',
						reason: '  promote after validation  ',
						actor: 'agent@host',
						userOverride: true,
						recordedAt: '2026-04-03T00:00:00.000Z',
					},
				],
			},
			parallelTracks: [
				{
					name: 'task-1',
					agent: 'codex',
					status: 'in_progress',
					worktree: {
						path: 'C:/Users/harsha_befach/Downloads/forge/.worktrees/task-1',
						branch: 'codex/task-1',
					},
				},
			],
		});

		expect(payload).toMatchObject({
			schemaVersion: 1,
			currentStage: 'dev',
			completedStages: ['plan'],
			skippedStages: [],
			workflowDecisions: {
				classification: 'standard',
				reason: 'Promoted after plan approval',
				userOverride: true,
			},
		});

		expect(payload.workflowDecisions.overrides).toEqual([
			{
				type: 'manual',
				fromStage: 'plan',
				toStage: 'dev',
				reason: 'promote after validation',
				actor: 'agent@host',
				userOverride: true,
				recordedAt: '2026-04-03T00:00:00.000Z',
			},
		]);

		expect(writeWorkflowState(payload)).toBe(JSON.stringify(payload, null, 2));
		expect(readWorkflowState(writeWorkflowState(payload))).toEqual(payload);
	});

	test('requires explicit structured overrides before persistence', () => {
		expect(() =>
			serializeWorkflowState({
				currentStage: 'dev',
				previousStage: 'plan',
				completedStages: ['plan'],
				skippedStages: [],
				workflowDecisions: {
					classification: 'standard',
					reason: 'Attempted manual promotion',
					userOverride: true,
					overrides: [],
				},
				parallelTracks: [],
			}),
		).toThrow(/override record/i);

		expect(() =>
			normalizeOverrideRecord({
				type: 'manual',
				fromStage: 'plan',
				toStage: 'dev',
				reason: '   ',
				actor: 'agent@host',
				recordedAt: '2026-04-03T00:00:00.000Z',
			}),
		).toThrow(/override record/i);

		const override = normalizeOverrideRecord({
			type: 'manual',
			fromStage: 'verify',
			toStage: 'premerge',
			reason: '  promote to final checks  ',
			actor: '  codex@worktree  ',
			userOverride: 1,
			recordedAt: '2026-04-03T00:00:00.000Z',
		});

		expect(override).toEqual({
			type: 'manual',
			fromStage: 'verify',
			toStage: 'premerge',
			reason: 'promote to final checks',
			actor: 'codex@worktree',
			userOverride: true,
			recordedAt: '2026-04-03T00:00:00.000Z',
		});
	});

	test('rejects stages that are outside the selected workflow classification', () => {
		expect(() =>
			serializeWorkflowState({
				currentStage: 'plan',
				completedStages: [],
				skippedStages: [],
				workflowDecisions: {
					classification: 'docs',
					reason: 'Docs-only change',
					userOverride: false,
					overrides: [],
				},
				parallelTracks: [],
			}),
		).toThrow(/not valid for docs workflow/i);

		expect(() =>
			serializeWorkflowState({
				currentStage: 'dev',
				previousStage: 'plan',
				completedStages: ['plan', 'verify'],
				skippedStages: [],
				workflowDecisions: {
					classification: 'standard',
					reason: 'Invalid completed stage list',
					userOverride: false,
					overrides: [],
				},
				parallelTracks: [],
			}),
		).toThrow(/completed stage verify is not valid for standard workflow/i);

		expect(() =>
			serializeWorkflowState({
				currentStage: 'dev',
				previousStage: 'plan',
				completedStages: ['plan'],
				skippedStages: ['verify'],
				workflowDecisions: {
					classification: 'standard',
					reason: 'Invalid skipped stage list',
					userOverride: false,
					overrides: [],
				},
				parallelTracks: [],
			}),
		).toThrow(/skipped stage verify is not valid for standard workflow/i);
	});
});
