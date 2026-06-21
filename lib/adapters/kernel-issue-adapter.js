'use strict';

const {
	IssueAdapter,
	decideIssueAuthority,
	normalizeIssueStatus,
} = require('../issue-adapter.js');

const KERNEL_ISSUE_OPERATIONS = Object.freeze({
	list: 'list',
	ready: 'ready',
	search: 'search',
	stats: 'stats',
	blocked: 'blocked',
	stale: 'stale',
	orphans: 'orphans',
	lint: 'lint',
	read: 'show',
	show: 'show',
	create: 'create',
	update: 'update',
	claim: 'claim',
	release: 'release',
	close: 'close',
	comment: 'comment',
	depAdd: 'dep.add',
	depRemove: 'dep.remove',
});

class KernelIssueAdapter extends IssueAdapter {
	constructor(options = {}) {
		super({
			id: options.id || 'kernel-local',
			kind: 'issue',
			name: options.name || 'Forge Kernel Local Issue Adapter',
			version: options.version || '0.1.0',
		});
		this.broker = options.broker;
	}

	run(operation, args = [], context = {}) {
		if (!this.broker || typeof this.broker.runIssueOperation !== 'function') {
			throw new TypeError('KernelIssueAdapter requires a broker with runIssueOperation()');
		}

		return this.broker.runIssueOperation(operation, args, context);
	}

	mapStatus(status, context = {}) {
		return normalizeIssueStatus(status, context);
	}

	decideAuthority(change = {}, context = {}) {
		return decideIssueAuthority(change, context);
	}
}

for (const [methodName, operation] of Object.entries(KERNEL_ISSUE_OPERATIONS)) {
	KernelIssueAdapter.prototype[methodName] = function issueOperation(args = [], context = {}) {
		return this.run(operation, args, context);
	};
}

module.exports = {
	KERNEL_ISSUE_OPERATIONS,
	KernelIssueAdapter,
};
