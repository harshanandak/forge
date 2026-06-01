'use strict';

const {
	IssueAdapter,
	decideIssueAuthority,
	normalizeIssueStatus,
} = require('../issue-adapter.js');

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

	list(args = [], context = {}) {
		return this.run('list', args, context);
	}

	ready(args = [], context = {}) {
		return this.run('ready', args, context);
	}

	read(args = [], context = {}) {
		return this.run('show', args, context);
	}

	show(args = [], context = {}) {
		return this.read(args, context);
	}

	create(args = [], context = {}) {
		return this.run('create', args, context);
	}

	update(args = [], context = {}) {
		return this.run('update', args, context);
	}

	claim(args = [], context = {}) {
		return this.run('claim', args, context);
	}

	close(args = [], context = {}) {
		return this.run('close', args, context);
	}

	comment(args = [], context = {}) {
		return this.run('comment', args, context);
	}

	mapStatus(status, context = {}) {
		return normalizeIssueStatus(status, context);
	}

	decideAuthority(change = {}, context = {}) {
		return decideIssueAuthority(change, context);
	}
}

module.exports = {
	KernelIssueAdapter,
};
