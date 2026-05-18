'use strict';

const DEFAULT_SECTION_LIMIT = 5;

function buildSection(title, items, options = {}) {
	const lines = ['', title];
	if (!items || items.length === 0) {
		lines.push('  none', '');
		return lines;
	}

	const limit = options.limit ?? null;
	const visibleItems = limit ? items.slice(0, limit) : items;
	lines.push(...visibleItems.map(item => `  ${item}`));

	if (limit && items.length > limit) {
		lines.push(`  ...and ${items.length - limit} more`);
	}

	lines.push('');
	return lines;
}

function toIssueSummary(issue) {
	return {
		id: issue.id,
		title: issue.title || '(untitled)',
		status: issue.status || null,
		owner: issue.owner || null,
		dependency_count: Number(issue.dependency_count || 0),
		updated_at: issue.updated_at || null,
	};
}

function formatIssue(issue, options = {}) {
	const status = options.includeStatus && issue.status ? ` [${issue.status}]` : '';
	return `${issue.id} ${issue.title || '(untitled)'}${status}`;
}

function formatWorkflow(workflowResult) {
	if (!workflowResult) {
		return ['No active workflow state detected.'];
	}

	return [
		`${workflowResult.stageName} (${workflowResult.stageId})`,
		`Run now: /${workflowResult.runCommand}`,
		workflowResult.nextCommand ? `Next after this: /${workflowResult.nextCommand}` : 'Next after this: none',
	];
}

function formatZeroArgStatus({ context, snapshot, workflowResult = null }) {
	const contextLines = [
		`Branch: ${context.branch}`,
		`Worktree: ${context.inWorktree ? 'linked' : 'main'}`,
		`Path: ${context.worktreePath}`,
	];

	if (context.inWorktree && context.mainWorktree) {
		contextLines.push(`Main worktree: ${context.mainWorktree}`);
	}

	contextLines.push(`Working tree: ${context.workingTree.summary}`);

	return [
		...buildSection('Context', contextLines),
		...buildSection('Active Issues', (snapshot.activeAssigned || []).map(issue => formatIssue(issue, { includeStatus: true }))),
		...buildSection('Ready', (snapshot.ready || []).map(issue => formatIssue(issue)), { limit: DEFAULT_SECTION_LIMIT }),
		...buildSection('Blocked', (snapshot.blocked || []).map(issue => formatIssue(issue, { includeStatus: true })), { limit: DEFAULT_SECTION_LIMIT }),
		...buildSection('Stale', (snapshot.stale || []).map(issue => formatIssue(issue, { includeStatus: true })), { limit: DEFAULT_SECTION_LIMIT }),
		...buildSection('Recent Completions', (snapshot.recentCompleted || []).map(issue => formatIssue(issue)), { limit: DEFAULT_SECTION_LIMIT }),
		...buildSection('Workflow', formatWorkflow(workflowResult)),
	].join('\n');
}

function buildPersonalStatusJson({ context, snapshot, workflowResult = null }) {
	return {
		context,
		personal: {
			activeAssigned: (snapshot.activeAssigned || []).map(toIssueSummary),
			ready: (snapshot.ready || []).map(toIssueSummary),
			blocked: (snapshot.blocked || []).map(toIssueSummary),
			stale: (snapshot.stale || []).map(toIssueSummary),
			recentCompleted: (snapshot.recentCompleted || []).map(toIssueSummary),
		},
		workflow: workflowResult ? {
			stageId: workflowResult.stageId,
			stageName: workflowResult.stageName,
			runCommand: workflowResult.runCommand,
			nextCommand: workflowResult.nextCommand,
			nextStages: workflowResult.nextStages,
		} : null,
		limits: snapshot.limits || [],
	};
}

function formatBoard({ context, snapshot }) {
	return [
		'',
		'Team Runtime Board',
		`Source: local Beads runtime state`,
		`Branch: ${context.branch}`,
		`Working tree: ${context.workingTree.summary}`,
		'',
		...buildSection('Active', (snapshot.active || []).map(issue => formatIssue(issue, { includeStatus: true })), { limit: DEFAULT_SECTION_LIMIT }),
		...buildSection('Ready', (snapshot.ready || []).map(issue => formatIssue(issue)), { limit: DEFAULT_SECTION_LIMIT }),
		...buildSection('Blocked', (snapshot.blocked || []).map(issue => formatIssue(issue, { includeStatus: true })), { limit: DEFAULT_SECTION_LIMIT }),
		...buildSection('Stale', (snapshot.stale || []).map(issue => formatIssue(issue, { includeStatus: true })), { limit: DEFAULT_SECTION_LIMIT }),
		...buildSection('Recent Completions', (snapshot.recentCompleted || []).map(issue => formatIssue(issue)), { limit: DEFAULT_SECTION_LIMIT }),
		...buildSection('Limits', snapshot.limits || []),
	].join('\n');
}

function buildBoardJson({ context, snapshot }) {
	return {
		context,
		board: {
			active: (snapshot.active || []).map(toIssueSummary),
			ready: (snapshot.ready || []).map(toIssueSummary),
			blocked: (snapshot.blocked || []).map(toIssueSummary),
			stale: (snapshot.stale || []).map(toIssueSummary),
			recentCompleted: (snapshot.recentCompleted || []).map(toIssueSummary),
		},
		limits: snapshot.limits || [],
	};
}

module.exports = {
	buildBoardJson,
	buildPersonalStatusJson,
	formatBoard,
	formatZeroArgStatus,
	toIssueSummary,
};
