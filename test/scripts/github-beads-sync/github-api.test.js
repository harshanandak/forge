import { describe, test, expect } from 'bun:test';
import {
  buildFindCommentsArgs,
  parseFindSyncComment,
  buildCreateCommentArgs,
  buildEditCommentArgs,
  buildCloseIssueArgs,
} from '../../../scripts/github-beads-sync/github-api.mjs';

describe('github-api', () => {
  describe('buildFindCommentsArgs', () => {
    test('returns correct gh api args for listing issue comments', () => {
      const args = buildFindCommentsArgs('myorg', 'myrepo', 42);
      expect(args).toEqual([
        'api',
        'repos/myorg/myrepo/issues/42/comments',
        '--paginate',
      ]);
    });

    test('coerces issueNumber to string in URL path', () => {
      const args = buildFindCommentsArgs('o', 'r', 7);
      expect(args[1]).toBe('repos/o/r/issues/7/comments');
    });
  });

  describe('parseFindSyncComment', () => {
    test('returns null when no comments exist', () => {
      expect(parseFindSyncComment([])).toBeNull();
    });

    test('returns null when no sync comment marker found', () => {
      const comments = [
        { id: 1, body: 'just a normal comment' },
        { id: 2, body: 'another one' },
      ];
      expect(parseFindSyncComment(comments)).toBeNull();
    });

    test('finds comment with beads-sync marker', () => {
      const comments = [
        { id: 10, body: 'irrelevant' },
        { id: 20, body: '<!-- beads-sync: status -->\n**Beads Status**: open' },
        { id: 30, body: 'also irrelevant' },
      ];
      const result = parseFindSyncComment(comments);
      expect(result).toEqual({
        id: 20,
        body: '<!-- beads-sync: status -->\n**Beads Status**: open',
      });
    });

    test('returns first matching sync comment if multiple exist', () => {
      const comments = [
        { id: 1, body: '<!-- beads-sync: first -->' },
        { id: 2, body: '<!-- beads-sync: second -->' },
      ];
      const result = parseFindSyncComment(comments);
      expect(result.id).toBe(1);
    });
  });

  describe('buildCreateCommentArgs', () => {
    test('returns correct gh api args for creating a comment', () => {
      const args = buildCreateCommentArgs('own', 'rep', 5, 'hello world');
      expect(args).toEqual([
        'api',
        'repos/own/rep/issues/5/comments',
        '-f',
        'body=hello world',
      ]);
    });
  });

  describe('buildEditCommentArgs', () => {
    test('returns correct gh api args for editing a comment', () => {
      const args = buildEditCommentArgs('own', 'rep', 999, 'updated body');
      expect(args).toEqual([
        'api',
        'repos/own/rep/issues/comments/999',
        '-X',
        'PATCH',
        '-f',
        'body=updated body',
      ]);
    });
  });

  describe('buildCloseIssueArgs', () => {
    test('returns correct gh api args for closing an issue', () => {
      const args = buildCloseIssueArgs('own', 'rep', 12);
      expect(args).toEqual([
        'api',
        'repos/own/rep/issues/12',
        '-X',
        'PATCH',
        '-f',
        'state=closed',
      ]);
    });
  });
});
