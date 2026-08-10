'use strict';

const { isLeaseExpired, isValidExpiresAt } = require('./lease-enforcer');
const { isTerminalStatus } = require('./taxonomy-validator');

// One authority definition for every user-facing lease projection. Null expiry is
// the compatibility form for a durable lease; malformed expiry cannot prove liveness.
function isLiveClaim(claim, issue, now) {
	if (!claim || !issue) return false;
	if (claim.state !== 'active') return false;
	if (isTerminalStatus(issue.status)) return false;
	if (!isValidExpiresAt(claim.expires_at)) return false;
	return !isLeaseExpired(claim, now);
}

function projectLiveClaims(claims, issues, now) {
	const claimRows = claims ?? [];
	const issueRows = issues ?? [];
	const issuesById = new Map(issueRows.map(issue => [issue.id, issue]));
	return claimRows.filter(claim => isLiveClaim(claim, issuesById.get(claim.issue_id), now));
}

module.exports = {
	isLiveClaim,
	projectLiveClaims,
};
