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
	children: 'children',
	owns: 'owns',
	read: 'show',
	show: 'show',
	create: 'create',
	update: 'update',
	claim: 'claim',
	release: 'release',
	close: 'close',
	comment: 'comment',
	dep: 'dep',
	depAdd: 'dep.add',
	depRemove: 'dep.remove',
});

// The CLI dep surface is `forge issue dep <add|remove> <ids...>`. The adapter
// exposes one `dep` operation that the de-beaded _issue.js routes to via a single
// runIssueOperation('dep', ...) call; the leading action selects the broker's
// guarded dep.add / dep.remove mutation.
const DEP_ACTION_OPERATIONS = Object.freeze({
	add: 'dep.add',
	remove: 'dep.remove',
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

	// Dispatch `forge issue dep <add|remove> <ids...>`: the leading positional is the
	// action, the remaining args are the endpoint ids passed straight to the broker's
	// dep.add / dep.remove guarded mutation. An unknown action returns a contract-shaped
	// failure without touching the broker.
	dep(args = [], context = {}) {
		const [action, ...rest] = args;
		const operation = DEP_ACTION_OPERATIONS[action];
		if (!operation) {
			return Promise.resolve({
				success: false,
				error: `Unsupported dependency action: ${action || '(missing)'}. Usage: forge issue dep <add|remove> <issue-id> <blocks-issue-id>`,
			});
		}
		return this.run(operation, rest, context);
	}

	mapStatus(status, context = {}) {
		return normalizeIssueStatus(status, context);
	}

	decideAuthority(change = {}, context = {}) {
		return decideIssueAuthority(change, context);
	}
}

for (const [methodName, operation] of Object.entries(KERNEL_ISSUE_OPERATIONS)) {
	// `dep` has a hand-written dispatcher above (it parses a leading action); the
	// generic 1:1 passthrough would clobber it, so skip it here.
	if (methodName === 'dep') {
		continue;
	}
	KernelIssueAdapter.prototype[methodName] = function issueOperation(args = [], context = {}) {
		return this.run(operation, args, context);
	};
}

module.exports = {
	KERNEL_ISSUE_OPERATIONS,
	KernelIssueAdapter,
};
