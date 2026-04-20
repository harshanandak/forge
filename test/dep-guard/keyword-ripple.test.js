'use strict';

const { describe, test, expect } = require('bun:test');

const {
  collectSharedTerms,
  parseActiveIssueLines,
  renderKeywordRippleReport,
  tokenizeMeaningfulTerms,
} = require('../../lib/dep-guard/keyword-ripple.js');

describe('lib/dep-guard/keyword-ripple.js', () => {
  test('tokenizeMeaningfulTerms removes stop words, duplicates, and short terms', () => {
    expect(tokenizeMeaningfulTerms('Add the dependency guard to the plan workflow and plan review')).toEqual([
      'dependency',
      'guard',
      'plan',
      'review',
      'workflow',
    ]);
  });

  test('collectSharedTerms detects meaningful overlap between source and candidate titles', () => {
    const shared = collectSharedTerms(
      tokenizeMeaningfulTerms('Pre-change dependency guard for plan workflow'),
      tokenizeMeaningfulTerms('Logic-level dependency detection in plan workflow'),
    );

    expect(shared).toEqual(['dependency', 'plan', 'workflow']);
  });

  test('parseActiveIssueLines extracts id, status, priority, and title from bd list text', () => {
    expect(parseActiveIssueLines([
      '◐ forge-alpha [● P1] [feature] - Alpha title',
      '○ forge-beta [● P2] [task] - Beta title',
    ].join('\n'))).toEqual([
      { id: 'forge-alpha', status: 'in_progress', priority: 'P1', title: 'Alpha title' },
      { id: 'forge-beta', status: 'open', priority: 'P2', title: 'Beta title' },
    ]);
  });

  test('renderKeywordRippleReport returns actionable overlap output when two or more terms match', () => {
    const report = renderKeywordRippleReport({
      issueId: 'forge-src',
      sourceTitle: 'Pre-change dependency guard for plan workflow',
      activeIssues: [
        { id: 'forge-src', priority: 'P2', status: 'in_progress', title: 'Pre-change dependency guard for plan workflow' },
        { id: 'forge-other', priority: 'P1', status: 'open', title: 'Logic-level dependency detection in plan workflow' },
      ],
    });

    expect(report.overlapCount).toBe(1);
    expect(report.output).toContain('Potential overlap');
    expect(report.output).toContain('forge-other');
    expect(report.output).toContain('bd dep add forge-src forge-other');
    expect(report.output).toContain('Confidence: LOW');
  });

  test('renderKeywordRippleReport returns no-conflict output when overlap is too weak', () => {
    const report = renderKeywordRippleReport({
      issueId: 'forge-aaa',
      sourceTitle: 'Add the widget to sidebar',
      activeIssues: [
        { id: 'forge-aaa', priority: 'P2', status: 'open', title: 'Add the widget to sidebar' },
        { id: 'forge-bbb', priority: 'P2', status: 'open', title: 'Fix the button in footer' },
      ],
    });

    expect(report.overlapCount).toBe(0);
    expect(report.output.trim()).toBe('No conflicts detected');
  });
});
