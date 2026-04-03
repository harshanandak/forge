const { describe, expect, test } = require('bun:test');

const {
	STAGE_IDS,
	STAGE_MODEL,
} = require('../../lib/workflow/stages.js');

const {
	normalizeOverrideRecord,
	readWorkflowState,
	serializeWorkflowState,
	writeWorkflowState,
} = require('../../lib/workflow/state.js');

describe('workflow state layer', () => {
	test('exports canonical stage ids for all seven workflow stages', () => {
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
	});

	test('rejects invalid workflow transitions', () => {
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
				userOverride: false,
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

	test('normalizes override records before persistence', () => {
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
});
