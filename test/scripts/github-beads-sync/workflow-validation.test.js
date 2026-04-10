/**
 * Validation tests for GitHub Actions workflow file.
 *
 * Tests workflow structure, security constraints, and best practices.
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const WORKFLOW_PATH = join(process.cwd(), '.github/workflows/github-to-beads.yml');

describe('GitHub → Beads Workflow Validation', () => {
  let workflowContent;

  beforeAll(() => {
    workflowContent = readFileSync(WORKFLOW_PATH, 'utf-8').replace(/\r\n/g, '\n');
  });

  describe('Security Constraints', () => {
    it('should NOT contain github.event.issue.title in run: blocks', () => {
      // Match dangerous patterns: ${{ github.event.issue.title }} in run: sections
      const dangerousPattern = /run:\s*\|?\s*[\s\S]*?\$\{\{\s*github\.event\.issue\.title\s*\}\}/;
      expect(workflowContent).not.toMatch(dangerousPattern);
    });

    it('should NOT contain github.event.issue.body in run: blocks', () => {
      const dangerousPattern = /run:\s*\|?\s*[\s\S]*?\$\{\{\s*github\.event\.issue\.body\s*\}\}/;
      expect(workflowContent).not.toMatch(dangerousPattern);
    });

    it('should pass all untrusted input via env: block', () => {
      // Check that a "Run sync" step uses env: with SYNC_ACTION
      const hasSyncActionEnv = /env:\s*[\s\S]*?SYNC_ACTION:\s*\$\{\{\s*github\.event\.action\s*\}\}/.test(
        workflowContent,
      );
      expect(hasSyncActionEnv).toBe(true);
    });

    it('should pass ISSUE_NUM via env: for commit message', () => {
      const hasIssueNumEnv = /env:\s*[\s\S]*?ISSUE_NUM:\s*\$\{\{\s*github\.event\.issue\.number\s*\}\}/.test(
        workflowContent,
      );
      expect(hasIssueNumEnv).toBe(true);
    });
  });

  describe('Concurrency and Loop Prevention', () => {
    it('should define concurrency group as "beads-sync"', () => {
      expect(workflowContent).toContain('group: beads-sync');
    });

    it('should disable cancel-in-progress for serialization', () => {
      expect(workflowContent).toContain('cancel-in-progress: false');
    });

    it('should skip runs by github-actions[bot] to prevent loops', () => {
      expect(workflowContent).toContain("github.actor != 'github-actions[bot]'");
    });
  });

  describe('Permissions', () => {
    it('should include contents: write permission', () => {
      expect(workflowContent).toContain('contents: write');
    });

    it('should include issues: write permission', () => {
      expect(workflowContent).toContain('issues: write');
    });

    it('should have permission comments', () => {
      expect(workflowContent).toContain('# push .beads/ and mapping file');
      expect(workflowContent).toContain('# post/edit bot comments');
    });
  });

  describe('Setup and Installation', () => {
    it('should use SHA-pinned oven-sh/setup-bun action', () => {
      expect(workflowContent).toContain('oven-sh/setup-bun@4bc047ad259df6fc24a6c9b0f9a0cb08cf17fbe5');
    });

    it('should use SHA-pinned actions/checkout action', () => {
      expect(workflowContent).toMatch(/actions\/checkout@[a-f0-9]{40}/);
    });

    it('should install Beads CLI via pinned binary download', () => {
      expect(workflowContent).toContain('Install Beads CLI (pinned to v1.0.0)');
      expect(workflowContent).toContain('BD_VERSION="1.0.0"');
      expect(workflowContent).not.toContain('BD_VERSION="0.49.1"');
    });

    it('should checkout with fetch-depth: 0 for push', () => {
      expect(workflowContent).toContain('fetch-depth: 0');
    });
  });

  describe('Sync Execution', () => {
    it('should call index.mjs with SYNC_ACTION argument', () => {
      expect(workflowContent).toContain('node scripts/github-beads-sync/index.mjs "$SYNC_ACTION"');
    });

    it('should pass GITHUB_EVENT_PATH environment variable', () => {
      expect(workflowContent).toContain('GITHUB_EVENT_PATH: ${{ github.event_path }}');
    });

    it('should pass GITHUB_REPOSITORY environment variable', () => {
      expect(workflowContent).toContain('GITHUB_REPOSITORY: ${{ github.repository }}');
    });

    it('should export a backup snapshot via bd backup --force', () => {
      expect(workflowContent).toContain('bd backup --force');
    });

    it('should copy the exported issue snapshot into a tracked workflow path', () => {
      expect(workflowContent).toContain('.github/beads-snapshots/issues.jsonl');
    });

    it('should not reference live .beads/issues.jsonl directly', () => {
      expect(workflowContent).not.toContain('.beads/issues.jsonl');
    });
  });

  describe('Push and Retry Logic', () => {
    it('should include retry loop for push operation', () => {
      const retryPattern = /for\s+i\s+in\s+1\s+2\s+3/;
      expect(workflowContent).toMatch(retryPattern);
    });

    it('should use git pull --rebase on retry', () => {
      expect(workflowContent).toContain('git pull --rebase');
    });

    it('should stage beads state, mapping, and the tracked issue snapshot', () => {
      expect(workflowContent).toContain('git add .beads/ .github/beads-mapping.json .github/beads-snapshots/issues.jsonl || true');
    });

    it('should check for staged changes before committing', () => {
      expect(workflowContent).toContain('git diff --cached --quiet');
    });
  });

  describe('Git Configuration', () => {
    it('should configure git user as github-actions[bot]', () => {
      expect(workflowContent).toContain('git config user.name "github-actions[bot]"');
      expect(workflowContent).toContain('git config user.email "github-actions[bot]@users.noreply.github.com"');
    });

    it('should use ISSUE_NUM in commit message', () => {
      expect(workflowContent).toContain('git commit -m "chore(beads): sync from GitHub issue #${ISSUE_NUM}"');
    });
  });

  describe('Trigger Configuration', () => {
    it('should trigger on issues opened event', () => {
      expect(workflowContent).toContain('types: [opened, closed]');
    });

    it('should be under "on: issues" trigger section', () => {
      expect(workflowContent).toContain('on:\n  issues:');
    });
  });

  describe('Workflow Metadata', () => {
    it('should have descriptive workflow name', () => {
      expect(workflowContent).toContain('name: GitHub Issue → Beads Sync');
    });

    it('should run on ubuntu-latest', () => {
      expect(workflowContent).toContain('runs-on: ubuntu-latest');
    });

    it('should have single job named "sync"', () => {
      expect(workflowContent).toContain('jobs:\n  sync:');
    });
  });
});
