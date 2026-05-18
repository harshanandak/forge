'use strict';

const {
  IssueAdapter,
  decideIssueAuthority,
  normalizeIssueStatus,
} = require('../issue-adapter.js');

class BeadsIssueAdapter extends IssueAdapter {
  constructor(options = {}) {
    super({
      id: options.id || 'beads',
      kind: 'issue',
      name: options.name || 'Beads Issue Adapter',
      version: options.version || '0.1.0',
    });
    this.runBeadsOperation = options.runBeadsOperation;
  }

  run(operation, args = [], context = {}) {
    if (typeof this.runBeadsOperation !== 'function') {
      throw new TypeError('runBeadsOperation is not configured on this adapter');
    }

    return this.runBeadsOperation(operation, args, context, context.deps || {});
  }

  list(args = [], context = {}) {
    return this.run('list', args, context);
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
  BeadsIssueAdapter,
};
