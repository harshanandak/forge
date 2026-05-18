const { describe, test, expect } = require('bun:test');

const {
  ReviewAdapter,
  REQUIRED_REVIEW_ADAPTER_METHODS,
  validateReviewAdapter,
} = require('../lib/review-adapter');
const { GreptileReviewAdapter } = require('../lib/adapters/greptile-review-adapter');
const { matchThreadsToCommits } = require('../lib/greptile-match');

describe('ReviewAdapter SPI', () => {
  test('base adapter documents the required review lifecycle methods', () => {
    expect(REQUIRED_REVIEW_ADAPTER_METHODS).toEqual([
      'fetchThreads',
      'parse',
      'reply',
      'resolve',
      'score',
    ]);
  });

  test('validates a complete review adapter implementation', () => {
    const adapter = {
      id: 'review-test',
      kind: 'review',
      fetchThreads() {},
      parse() {},
      reply() {},
      resolve() {},
      score() {},
    };

    expect(validateReviewAdapter(adapter)).toEqual({ valid: true, errors: [] });
  });

  test('reports every missing required method', () => {
    const adapter = { id: 'broken', kind: 'review', parse() {} };

    expect(validateReviewAdapter(adapter)).toEqual({
      valid: false,
      errors: [
        'fetchThreads must be a function',
        'reply must be a function',
        'resolve must be a function',
        'score must be a function',
      ],
    });
  });

  test('base class throws for lifecycle methods that subclasses do not implement', async () => {
    const adapter = new ReviewAdapter({ id: 'base', kind: 'review' });

    await expect(adapter.fetchThreads()).rejects.toThrow(/fetchThreads/);
    expect(() => adapter.parse()).toThrow(/parse/);
    await expect(adapter.reply()).rejects.toThrow(/reply/);
    await expect(adapter.resolve()).rejects.toThrow(/resolve/);
    expect(() => adapter.score()).toThrow(/score/);
  });
});

describe('GreptileReviewAdapter', () => {
  const reviewThreadsResponse = {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: 'thread-1',
                isResolved: false,
                comments: {
                  nodes: [
                    {
                      id: 'comment-node-1',
                      databaseId: 101,
                      path: 'lib/example.js',
                      line: 12,
                      body: 'please fix this',
                      author: { login: 'greptile-apps[bot]' },
                    },
                  ],
                },
              },
              {
                id: 'thread-2',
                isResolved: false,
                comments: {
                  nodes: [
                    {
                      databaseId: 102,
                      path: 'lib/other.js',
                      line: 7,
                      author: { login: 'human-reviewer' },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  };

  test('parses unresolved Greptile review threads from GitHub GraphQL shape', () => {
    const adapter = new GreptileReviewAdapter();

    expect(adapter.parse(reviewThreadsResponse)).toEqual([
      {
        id: 'thread-1',
        commentId: 101,
        file: 'lib/example.js',
        line: 12,
        body: 'please fix this',
        author: 'greptile-apps[bot]',
        isResolved: false,
        raw: reviewThreadsResponse.data.repository.pullRequest.reviewThreads.nodes[0],
      },
    ]);
  });

  test('keeps matchThreadsToCommits public API behavior compatible', () => {
    const execCalls = [];
    const threads = [{ file: 'lib/example.js', line: 12 }];
    const result = matchThreadsToCommits(threads, '/repo', {
      _exec: (cmd, args) => {
        execCalls.push([cmd, args]);
        if (args.includes('merge-base')) {
          return 'base123\n';
        }
        return 'abc1234 fix adapter\n';
      },
    });

    expect(execCalls).toEqual([
      ['git', ['-C', '/repo', 'merge-base', 'HEAD', 'main']],
      ['git', ['-C', '/repo', 'log', '--oneline', '--follow', 'base123..HEAD', '--', 'lib/example.js']],
    ]);
    expect(result).toEqual([{ file: 'lib/example.js', line: 12, resolved: true, sha: 'abc1234' }]);
  });
});
