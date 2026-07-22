'use strict';

const {
	STAGE_LABELS,
	getStageWorkflow,
	getWorkflowPath,
} = require('../workflow/stages');

const DEFAULT_SECTION_LIMIT = 5;

// One-line "why you are at this stage", keyed by the LAST completed stage. Lets the
// one-glance view answer "why here?" without the agent re-deriving it from raw state.
const WHY_BY_LAST_COMPLETED = Object.freeze({
	plan: 'planning is done; implementation not started.',
	dev: 'implementation landed; not yet validated.',
	validate: 'validation passed; PR not yet created.',
	ship: 'PR is open; review not yet complete.',
	review: 'review addressed; awaiting merge/verify.',
	verify: 'post-merge verification complete.',
});

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

// Shared Run-now / Next-after-this lines. Owned here so BOTH the one-glance
// "You are here" block and status.js's authoritative stage format render them
// identically. `noneWhenMissing` prints an explicit "none" for terminal stages
// (the one-glance view wants it; the authoritative format omits it, as before).
function formatRunNextLines(workflowResult, { noneWhenMissing = false } = {}) {
	const lines = [`Run now: /${workflowResult.runCommand}`];
	if (workflowResult.nextCommand) {
		lines.push(`Next after this: /${workflowResult.nextCommand}`);
	} else if (noneWhenMissing) {
		lines.push('Next after this: none');
	}
	return lines;
}

// Canonical "Stage N of M — Label (classification workflow)" heading. N/M come from
// the per-classification path in lib/workflow/stages.js, so non-stages (Research,
// Merge, pre-merge, "Fresh Start") never get a number.
function formatStageHeading(workflowResult) {
	const classification = workflowResult.workflowState?.workflowDecisions?.classification || null;
	const stageId = workflowResult.stageId;
	const label = STAGE_LABELS[stageId] || workflowResult.stageName || stageId;
	const workflow = getStageWorkflow(stageId, classification);
	const path = getWorkflowPath(classification);

	if (workflow && path.length > 0) {
		return `Stage ${workflow.order} of ${path.length} — ${label} (${classification} workflow)`;
	}
	return `Stage — ${label}${classification ? ` (${classification} workflow)` : ''}`;
}

function deriveWhy(workflowResult) {
	const completed = workflowResult.workflowState?.completedStages || [];
	const last = completed.length > 0 ? completed[completed.length - 1] : null;
	return (last && WHY_BY_LAST_COMPLETED[last]) || 'just getting started.';
}

// The "You are here" block: the first thing a user or agent reads. When there is no
// active workflow, fall back to a STATE-AWARE next step rather than a dead end.
function buildYouAreHere(workflowResult, snapshot) {
	const lines = ['You are here'];

	if (!workflowResult) {
		const topReady = (snapshot.ready || [])[0];
		if (topReady) {
			lines.push(`  No active workflow. Next: forge claim ${topReady.id}, then /plan (or /dev for a small fix).`);
		} else {
			lines.push('  No active workflow and no ready issues. Next: /plan "<describe the feature>" to start one.');
		}
		return lines;
	}

	lines.push(`  ${formatStageHeading(workflowResult)}`);
	for (const line of formatRunNextLines(workflowResult, { noneWhenMissing: true })) {
		lines.push(`  ${line}`);
	}
	lines.push(`  Why: ${deriveWhy(workflowResult)}`);
	return lines;
}

// Zero-arg `forge status`: a top-down one-glance view. Order matters — orientation
// first (You are here), then Context, then your work. Blocked/Stale/Recent
// completions are detail, shown only with `--full`.
function formatZeroArgStatus({ context, snapshot, workflowResult = null, full = false }) {
	const worktree = context.inWorktree ? 'worktree' : 'main';
	const contextLine = `${context.branch} — ${worktree}, ${context.workingTree.summary}`;

	const activeIssues = snapshot.activeAssigned || [];
	const readyCount = (snapshot.ready || []).length;
	const workLines = [];
	if (activeIssues.length > 0) {
		for (const issue of activeIssues) {
			workLines.push(`Active: ${formatIssue(issue, { includeStatus: true })}`);
		}
	} else {
		workLines.push('Active: none');
	}
	workLines.push(readyCount > 0 ? `Ready: ${readyCount} more (forge issue ready)` : 'Ready: none');

	const blocks = [
		buildYouAreHere(workflowResult, snapshot).join('\n'),
		['Context', `  ${contextLine}`].join('\n'),
		['Your work', ...workLines.map(line => `  ${line}`)].join('\n'),
		'New here? forge docs setup | forge --help',
	];

	if (full) {
		blocks.push(
			buildSection('Blocked', (snapshot.blocked || []).map(issue => formatIssue(issue, { includeStatus: true })), { limit: DEFAULT_SECTION_LIMIT }).join('\n').trim(),
			buildSection('Stale', (snapshot.stale || []).map(issue => formatIssue(issue, { includeStatus: true })), { limit: DEFAULT_SECTION_LIMIT }).join('\n').trim(),
			buildSection('Parked', (snapshot.parked || []).map(issue => formatIssue(issue, { includeStatus: true })), { limit: DEFAULT_SECTION_LIMIT }).join('\n').trim(),
			buildSection('Recent Completions', (snapshot.recentCompleted || []).map(issue => formatIssue(issue)), { limit: DEFAULT_SECTION_LIMIT }).join('\n').trim(),
		);
	}

	return blocks.join('\n\n');
}

function buildPersonalStatusJson({ context, snapshot, workflowResult = null }) {
	return {
		context,
		personal: {
			activeAssigned: (snapshot.activeAssigned || []).map(toIssueSummary),
			ready: (snapshot.ready || []).map(toIssueSummary),
			blocked: (snapshot.blocked || []).map(toIssueSummary),
			stale: (snapshot.stale || []).map(toIssueSummary),
			parked: (snapshot.parked || []).map(toIssueSummary),
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

module.exports = {
	buildPersonalStatusJson,
	formatRunNextLines,
	formatZeroArgStatus,
	toIssueSummary,
};
