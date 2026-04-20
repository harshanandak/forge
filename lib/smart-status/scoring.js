'use strict';

function roundToTwo(value) {
	return Math.round(value * 100) / 100;
}

function normalizePriorityNumber(priority) {
	if (priority === undefined || priority === null) {
		return 2;
	}

	if (typeof priority === 'string') {
		switch (priority) {
			case 'P0':
				return 0;
			case 'P1':
				return 1;
			case 'P2':
				return 2;
			case 'P3':
				return 3;
			case 'P4':
				return 4;
			default:
				return 5;
		}
	}

	return priority;
}

function getPriorityWeight(priority) {
	switch (normalizePriorityNumber(priority)) {
		case 0:
			return 5;
		case 1:
			return 4;
		case 2:
			return 3;
		case 3:
			return 2;
		case 4:
			return 1;
		default:
			return 1;
	}
}

function getTypeWeight(type) {
	const normalized = type ?? 'task';
	if (normalized === 'bug') {
		return 1.2;
	}
	if (normalized === 'feature') {
		return 1.0;
	}
	if (normalized === 'task') {
		return 0.8;
	}
	return 1.0;
}

function getStatusBoost(status) {
	if (status === 'in_progress') {
		return 1.5;
	}
	if (status === 'open') {
		return 1.0;
	}
	return 1.0;
}

function parseUpdatedAtLikeShell(updatedAt) {
	if (!updatedAt) {
		return null;
	}

	const normalized = `${String(updatedAt).slice(0, 19)}Z`;
	const timestamp = Date.parse(normalized);
	return Number.isFinite(timestamp) ? timestamp : null;
}

function getStalenessBoost(updatedAt, now = Date.now()) {
	const timestamp = parseUpdatedAtLikeShell(updatedAt);
	if (timestamp === null) {
		return 1.0;
	}

	const days = (now - timestamp) / 86400000;
	if (days >= 30) {
		return 1.5;
	}
	if (days >= 14) {
		return 1.2;
	}
	if (days >= 7) {
		return 1.1;
	}
	return 1.0;
}

function buildDependentsMap(issues) {
	const dependentsMap = new Map();

	for (const issue of issues) {
		for (const dependency of issue.dependencies ?? []) {
			const dependencyId = dependency?.depends_on_id;
			if (!dependencyId) {
				continue;
			}
			if (!dependentsMap.has(dependencyId)) {
				dependentsMap.set(dependencyId, []);
			}
			dependentsMap.get(dependencyId).push(issue.id);
		}
	}

	return dependentsMap;
}

function getEpicProximity(issue, epicStats) {
	if (!issue.parent_id || !epicStats?.[issue.parent_id]) {
		return 1.0;
	}

	const stats = epicStats[issue.parent_id];
	if (!(stats.total > 0)) {
		return 1.0;
	}

	return 1.0 + ((stats.closed / stats.total) * 0.5);
}

function scoreIssues(issues, options = {}) {
	const epicStats = options.epicStats ?? {};
	const now = options.now ?? Date.now();
	const dependentsMap = buildDependentsMap(issues);

	return [...issues]
		.map((issue) => {
			const priorityWeight = getPriorityWeight(issue.priority);
			const unblockChain = Math.max((issue.dependent_count ?? 0) + 1, 1);
			const typeWeight = getTypeWeight(issue.type);
			const statusBoost = getStatusBoost(issue.status);
			const epicProximity = getEpicProximity(issue, epicStats);
			const stalenessBoost = getStalenessBoost(issue.updated_at, now);
			const dependents = dependentsMap.get(issue.id) ?? [];
			const score = priorityWeight
				* unblockChain
				* typeWeight
				* statusBoost
				* epicProximity
				* stalenessBoost;

			return {
				...issue,
				score: roundToTwo(score),
				priority_weight: priorityWeight,
				unblock_chain: unblockChain,
				type_weight: typeWeight,
				status_boost: statusBoost,
				epic_proximity: roundToTwo(epicProximity),
				staleness_boost: stalenessBoost,
				dependents,
			};
		})
		.sort((left, right) => right.score - left.score);
}

module.exports = {
	getPriorityWeight,
	getStalenessBoost,
	getStatusBoost,
	getTypeWeight,
	scoreIssues,
};
