'use strict';

const { execFileSync } = require('node:child_process');
const { ReviewAdapter } = require('../review-adapter');

function getReviewThreadNodes(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  return payload?.data?.repository?.pullRequest?.reviewThreads?.nodes
    || payload?.repository?.pullRequest?.reviewThreads?.nodes
    || payload?.reviewThreads?.nodes
    || payload?.nodes
    || [];
}

function getFirstComment(thread) {
  return thread?.comments?.nodes?.[0] || {};
}

class GreptileReviewAdapter extends ReviewAdapter {
  constructor(options = {}) {
    super({
      id: options.id || 'greptile',
      kind: 'review',
      name: options.name || 'Greptile Review Adapter',
      version: options.version,
    });
    this.authorPrefix = options.authorPrefix || 'greptile-apps';
    this.github = options.github;
  }

  async fetchThreads(context = {}) {
    if (this.github && typeof this.github.fetchThreads === 'function') {
      return this.github.fetchThreads(context);
    }
    throw new Error('greptile.fetchThreads requires a GitHub client');
  }

  parse(payload, options = {}) {
    const includeResolved = options.includeResolved === true;
    const authorPrefix = options.authorPrefix || this.authorPrefix;

    return getReviewThreadNodes(payload)
      .filter((thread) => includeResolved || thread?.isResolved === false)
      .map((thread) => {
        const comment = getFirstComment(thread);
        return {
          id: thread.id,
          commentId: comment.databaseId || comment.id,
          file: comment.path,
          line: comment.line || 0,
          body: comment.body || '',
          author: comment.author?.login || 'unknown',
          isResolved: Boolean(thread.isResolved),
          raw: thread,
        };
      })
      .filter((thread) => thread.author.startsWith(authorPrefix))
      .filter((thread) => Boolean(thread.file));
  }

  async reply(context = {}) {
    if (this.github && typeof this.github.reply === 'function') {
      return this.github.reply(context);
    }
    throw new Error('greptile.reply requires a GitHub client');
  }

  async resolve(context = {}) {
    if (this.github && typeof this.github.resolve === 'function') {
      return this.github.resolve(context);
    }
    throw new Error('greptile.resolve requires a GitHub client');
  }

  score(threads, context = {}) {
    return matchThreadsToCommitsWithGit(threads, context.projectRoot || process.cwd(), context);
  }
}

function matchThreadsToCommitsWithGit(threads, projectRoot, opts = {}) {
  if (!threads || threads.length === 0) {
    return [];
  }

  const exec = opts._exec || ((cmd, args) => {
    return execFileSync(cmd, args, { encoding: 'utf8' });
  });

  let sinceCommit = opts.sinceCommit;
  if (!sinceCommit) {
    try {
      sinceCommit = exec('git', ['-C', projectRoot, 'merge-base', 'HEAD', 'main']).trim();
    } catch (_e) { // NOSONAR S2486
      try {
        sinceCommit = exec('git', ['-C', projectRoot, 'merge-base', 'HEAD', 'master']).trim();
      } catch (_e2) { // NOSONAR S2486
        sinceCommit = null;
      }
    }
  }

  return threads.map((thread) => {
    const { file, line } = thread;

    try {
      const logArgs = [
        '-C', projectRoot,
        'log',
        '--oneline',
        '--follow',
      ];
      if (sinceCommit) {
        logArgs.push(`${sinceCommit}..HEAD`);
      }
      logArgs.push('--', file);

      const output = exec('git', logArgs);
      const trimmed = (output || '').trim();

      if (!trimmed) {
        return { file, line, resolved: false, reason: 'no matching commit' };
      }

      const firstLine = trimmed.split('\n')[0];
      const sha = firstLine.split(' ')[0];

      return { file, line, resolved: true, sha };
    } catch (_err) { // NOSONAR S2486
      return { file, line, resolved: false, reason: 'no matching commit' };
    }
  });
}

module.exports = {
  GreptileReviewAdapter,
  getReviewThreadNodes,
  matchThreadsToCommitsWithGit,
};
