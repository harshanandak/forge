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

  search(args = [], context = {}) {
    return this.run('search', args, context);
  }

  stats(args = [], context = {}) {
    return this.run('stats', args, context);
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

  depAdd(args = [], context = {}) {
    return this.run('dep.add', args, context);
  }

  depRemove(args = [], context = {}) {
    return this.run('dep.remove', args, context);
  }

  // De-bead parity: claim/release and the KAP-7/KAP-12 derived reads now route
  // through the backend abstraction (the translations moved out of _issue.js). The
  // beads layer maps claim -> `update <id> --claim`; release has no bd equivalent
  // and returns the Kernel-only contract error (handled in runBeadsOperation).
  claim(args = [], context = {}) {
    return this.run('claim', args, context);
  }

  release(args = [], context = {}) {
    return this.run('release', args, context);
  }

  blocked(args = [], context = {}) {
    return this.run('blocked', args, context);
  }

  stale(args = [], context = {}) {
    return this.run('stale', args, context);
  }

  orphans(args = [], context = {}) {
    return this.run('orphans', args, context);
  }

  lint(args = [], context = {}) {
    return this.run('lint', args, context);
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
