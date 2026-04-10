'use strict';

function buildSection(title, items) {
	const lines = ['', title];
	if (!items || items.length === 0) {
		lines.push('  none', '');
		return lines;
	}

	lines.push(...items.map(item => `  ${item}`), '');
	return lines;
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
		...buildSection('Ready', (snapshot.ready || []).map(issue => formatIssue(issue))),
		...buildSection('Recent Completions', (snapshot.recentCompleted || []).map(issue => formatIssue(issue))),
		...buildSection('Workflow', formatWorkflow(workflowResult)),
	].join('\n');
}

module.exports = {
	formatZeroArgStatus,
};
