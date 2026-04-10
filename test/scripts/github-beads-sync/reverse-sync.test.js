import { describe, test, expect } from 'bun:test';

import {
  detectClosedIssues,
  extractGitHubUrl,
  handleBeadsClosed,
} from '../../../scripts/github-beads-sync/reverse-sync.mjs';

// --- detectClosedIssues ---

describe('detectClosedIssues', () => {
  test('detects issue that transitioned from open to closed', () => {
    const oldLines = [
      '{"id":"forge-abc","status":"open","description":"https://github.com/owner/repo/issues/42"}',
    ];
    const newLines = [
      '{"id":"forge-abc","status":"closed","description":"https://github.com/owner/repo/issues/42"}',
    ];
    const result = detectClosedIssues(oldLines, newLines);
    expect(result).toEqual([
      { id: 'forge-abc', description: 'https://github.com/owner/repo/issues/42' },
    ]);
  });

  test('ignores issues that were already closed', () => {
    const oldLines = [
      '{"id":"forge-abc","status":"closed","description":"https://github.com/owner/repo/issues/42"}',
    ];
    const newLines = [
      '{"id":"forge-abc","status":"closed","description":"https://github.com/owner/repo/issues/42"}',
    ];
    const result = detectClosedIssues(oldLines, newLines);
    expect(result).toEqual([]);
  });

  test('ignores issues that are still open', () => {
    const oldLines = [
      '{"id":"forge-abc","status":"open","description":"https://github.com/owner/repo/issues/42"}',
    ];
    const newLines = [
      '{"id":"forge-abc","status":"open","description":"https://github.com/owner/repo/issues/42"}',
    ];
    const result = detectClosedIssues(oldLines, newLines);
    expect(result).toEqual([]);
  });

  test('detects multiple closed issues', () => {
    const oldLines = [
      '{"id":"forge-a","status":"open","description":"https://github.com/o/r/issues/1"}',
      '{"id":"forge-b","status":"open","description":"https://github.com/o/r/issues/2"}',
      '{"id":"forge-c","status":"open","description":"https://github.com/o/r/issues/3"}',
    ];
    const newLines = [
      '{"id":"forge-a","status":"closed","description":"https://github.com/o/r/issues/1"}',
      '{"id":"forge-b","status":"open","description":"https://github.com/o/r/issues/2"}',
      '{"id":"forge-c","status":"closed","description":"https://github.com/o/r/issues/3"}',
    ];
    const result = detectClosedIssues(oldLines, newLines);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('forge-a');
    expect(result[1].id).toBe('forge-c');
  });

  test('handles newly added closed issue (not in old)', () => {
    const oldLines = [];
    const newLines = [
      '{"id":"forge-new","status":"closed","description":"https://github.com/o/r/issues/5"}',
    ];
    // New issue that appears already closed — no transition, skip it
    const result = detectClosedIssues(oldLines, newLines);
    expect(result).toEqual([]);
  });

  test('handles empty lines and malformed JSON gracefully', () => {
    const oldLines = ['', 'not-json', '{"id":"forge-a","status":"open","description":"url"}'];
    const newLines = ['', 'not-json', '{"id":"forge-a","status":"closed","description":"url"}'];
    const result = detectClosedIssues(oldLines, newLines);
    expect(result).toEqual([{ id: 'forge-a', description: 'url' }]);
  });

  test('handles tombstone status — not treated as closure', () => {
    const oldLines = [
      '{"id":"forge-t","status":"open","description":"https://github.com/o/r/issues/9"}',
    ];
    const newLines = [
      '{"id":"forge-t","status":"tombstone","description":"https://github.com/o/r/issues/9"}',
    ];
    const result = detectClosedIssues(oldLines, newLines);
    expect(result).toEqual([]);
  });
});

// --- extractGitHubUrl ---

describe('extractGitHubUrl', () => {
  test('extracts owner, repo, and issue number from standard URL', () => {
    const result = extractGitHubUrl('https://github.com/myorg/myrepo/issues/42');
    expect(result).toEqual({ owner: 'myorg', repo: 'myrepo', issueNumber: 42 });
  });

  test('extracts from URL embedded in longer description', () => {
    const desc = 'Linked: https://github.com/foo/bar/issues/7 — see above';
    const result = extractGitHubUrl(desc);
    expect(result).toEqual({ owner: 'foo', repo: 'bar', issueNumber: 7 });
  });

  test('returns null for non-GitHub URL', () => {
    expect(extractGitHubUrl('https://gitlab.com/o/r/issues/1')).toBeNull();
  });

  test('returns null for empty or undefined description', () => {
    expect(extractGitHubUrl('')).toBeNull();
    expect(extractGitHubUrl(undefined)).toBeNull();
    expect(extractGitHubUrl(null)).toBeNull();
  });

  test('returns null for GitHub URL without issues path', () => {
    expect(extractGitHubUrl('https://github.com/o/r/pull/5')).toBeNull();
  });

  test('handles URL with trailing slash', () => {
    const result = extractGitHubUrl('https://github.com/a/b/issues/99/');
    expect(result).toEqual({ owner: 'a', repo: 'b', issueNumber: 99 });
  });
});

// --- handleBeadsClosed ---

describe('handleBeadsClosed', () => {
  test('closes GitHub issue for each newly-closed beads issue', () => {
    const closedCalls = [];
    const mockCloseGitHubIssue = (owner, repo, num) => closedCalls.push({ owner, repo, num });

    const oldContent = '{"id":"forge-x","status":"open","description":"https://github.com/org/proj/issues/10"}';
    const newContent = '{"id":"forge-x","status":"closed","description":"https://github.com/org/proj/issues/10"}';

    const result = handleBeadsClosed(oldContent, newContent, {
      closeGitHubIssue: mockCloseGitHubIssue,
    });

    expect(closedCalls).toHaveLength(1);
    expect(closedCalls[0]).toEqual({ owner: 'org', repo: 'proj', num: 10 });
    expect(result.closed).toHaveLength(1);
    expect(result.closed[0].beadsId).toBe('forge-x');
  });

  test('skips issues without valid GitHub URL in description', () => {
    const closedCalls = [];
    const mockCloseGitHubIssue = (owner, repo, num) => closedCalls.push({ owner, repo, num });

    const oldContent = '{"id":"forge-y","status":"open","description":"no-url-here"}';
    const newContent = '{"id":"forge-y","status":"closed","description":"no-url-here"}';

    const result = handleBeadsClosed(oldContent, newContent, {
      closeGitHubIssue: mockCloseGitHubIssue,
    });

    expect(closedCalls).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('no GitHub URL');
  });

  test('returns empty results when no transitions detected', () => {
    const closedCalls = [];
    const mockCloseGitHubIssue = (owner, repo, num) => closedCalls.push({ owner, repo, num });

    const content = '{"id":"forge-z","status":"open","description":"https://github.com/o/r/issues/1"}';

    const result = handleBeadsClosed(content, content, {
      closeGitHubIssue: mockCloseGitHubIssue,
    });

    expect(closedCalls).toHaveLength(0);
    expect(result.closed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  test('handles multi-line JSONL content', () => {
    const closedCalls = [];
    const mockCloseGitHubIssue = (owner, repo, num) => closedCalls.push({ owner, repo, num });

    const oldContent = [
      '{"id":"forge-a","status":"open","description":"https://github.com/o/r/issues/1"}',
      '{"id":"forge-b","status":"open","description":"https://github.com/o/r/issues/2"}',
    ].join('\n');
    const newContent = [
      '{"id":"forge-a","status":"closed","description":"https://github.com/o/r/issues/1"}',
      '{"id":"forge-b","status":"closed","description":"https://github.com/o/r/issues/2"}',
    ].join('\n');

    const result = handleBeadsClosed(oldContent, newContent, {
      closeGitHubIssue: mockCloseGitHubIssue,
    });

    expect(closedCalls).toHaveLength(2);
    expect(result.closed).toHaveLength(2);
  });

  test('reports errors without throwing when closeGitHubIssue fails', () => {
    const mockCloseGitHubIssue = () => {
      throw new Error('API failure');
    };

    const oldContent = '{"id":"forge-e","status":"open","description":"https://github.com/o/r/issues/3"}';
    const newContent = '{"id":"forge-e","status":"closed","description":"https://github.com/o/r/issues/3"}';

    const result = handleBeadsClosed(oldContent, newContent, {
      closeGitHubIssue: mockCloseGitHubIssue,
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].beadsId).toBe('forge-e');
    expect(result.errors[0].error).toBe('API failure');
  });
});

// --- Loop guard (validated against actual workflow YAML) ---

describe('loop guard', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const workflowPath = path.resolve(__dirname, '../../../.github/workflows/beads-to-github.yml');
  const workflowContent = fs.readFileSync(workflowPath, 'utf-8');

  test('workflow YAML contains chore(beads): loop guard pattern', () => {
    expect(workflowContent).toContain('chore\\(beads\\):');
  });

  test('workflow skips execution when SKIP is true', () => {
    expect(workflowContent).toContain("if: env.SKIP != 'true'");
  });

  test('workflow uses github.event.before for pre-push comparison', () => {
    expect(workflowContent).toContain('github.event.before');
  });

  test('workflow compares exported backup snapshots instead of live issues.jsonl', () => {
    expect(workflowContent).toContain('.github/beads-snapshots/issues.jsonl');
    expect(workflowContent).not.toContain('NEW_CONTENT=$(cat .beads/issues.jsonl');
  });
});
