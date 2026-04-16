const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test, expect, setDefaultTimeout } = require('bun:test');

const { cleanupTmpDir, createMockBd, daysAgo, runSmartStatus } = require('./smart-status.helpers');

setDefaultTimeout(20000);

describe('smart-status.sh', () => {
  describe('session detection', () => {
    function createMockGit(porcelainOutput) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-status-git-'));
      const mockScript = path.join(tmpDir, 'git');
      const scriptContent = `#!/usr/bin/env bash
# Mock git: handles worktree and rev-parse
if [ "$1" = "worktree" ]; then
  cat <<'PORCELAINEOF'
${porcelainOutput}
PORCELAINEOF
  exit 0
elif [ "$1" = "rev-parse" ]; then
  if [ "$3" = "master" ]; then exit 0; fi
  exit 1
elif [ "$1" = "diff" ]; then
  echo ""
  exit 0
fi
exit 0
`;
      fs.writeFileSync(mockScript, scriptContent, { mode: 0o755 });
      return { tmpDir, mockScript };
    }

    test('ACTIVE SESSIONS section appears when multiple worktrees exist', () => {
      const porcelain = [
        'worktree /repo',
        'HEAD abc123',
        'branch refs/heads/master',
        '',
        'worktree /repo/.worktrees/my-feature',
        'HEAD def456',
        'branch refs/heads/feat/my-feature',
        '',
      ].join('\n');
      const mockData = {
        issues: [
          { id: 'forge-abc', title: 'My feature work', priority: 'P2', type: 'feature', status: 'in_progress', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir: gitDir, mockScript: gitScript } = createMockGit(porcelain);
      const { tmpDir: bdDir, mockScript: bdScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: bdScript, GIT_CMD: gitScript, NO_COLOR: '1' });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('ACTIVE SESSIONS');
      } finally {
        cleanupTmpDir(gitDir);
        cleanupTmpDir(bdDir);
      }
    });

    test('ACTIVE SESSIONS appears before grouped output', () => {
      const porcelain = [
        'worktree /repo',
        'HEAD abc123',
        'branch refs/heads/master',
        '',
        'worktree /repo/.worktrees/workflow-intelligence',
        'HEAD def456',
        'branch refs/heads/feat/workflow-intelligence',
        '',
      ].join('\n');
      const mockData = {
        issues: [
          { id: 'forge-68oj', title: 'Workflow intelligence', priority: 'P1', type: 'feature', status: 'in_progress', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir: gitDir, mockScript: gitScript } = createMockGit(porcelain);
      const { tmpDir: bdDir, mockScript: bdScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: bdScript, GIT_CMD: gitScript, NO_COLOR: '1' });
        expect(result.status).toBe(0);
        const sessionsIdx = result.stdout.indexOf('ACTIVE SESSIONS');
        const resumeIdx = result.stdout.indexOf('RESUME');
        expect(sessionsIdx).not.toBe(-1);
        expect(resumeIdx).not.toBe(-1);
        expect(sessionsIdx).toBeLessThan(resumeIdx);
      } finally {
        cleanupTmpDir(gitDir);
        cleanupTmpDir(bdDir);
      }
    });

    test('branch-to-issue matching via slug', () => {
      const porcelain = [
        'worktree /repo',
        'HEAD abc123',
        'branch refs/heads/master',
        '',
        'worktree /repo/.worktrees/p2-bug-fixes',
        'HEAD def456',
        'branch refs/heads/feat/p2-bug-fixes',
        '',
      ].join('\n');
      const mockData = {
        issues: [
          { id: 'forge-iv1p', title: 'P2 bug fixes batch 1', priority: 'P2', type: 'bug', status: 'in_progress', dependent_count: 0, updated_at: daysAgo(1) },
          { id: 'forge-cpnj', title: 'P2 bug fixes batch 2', priority: 'P2', type: 'bug', status: 'in_progress', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir: gitDir, mockScript: gitScript } = createMockGit(porcelain);
      const { tmpDir: bdDir, mockScript: bdScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: bdScript, GIT_CMD: gitScript, NO_COLOR: '1' });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('feat/p2-bug-fixes');
        expect(result.stdout).toContain('forge-iv1p');
        expect(result.stdout).toContain('forge-cpnj');
      } finally {
        cleanupTmpDir(gitDir);
        cleanupTmpDir(bdDir);
      }
    });

    test('no session section when only main worktree exists', () => {
      const porcelain = [
        'worktree /repo',
        'HEAD abc123',
        'branch refs/heads/master',
        '',
      ].join('\n');
      const mockData = {
        issues: [
          { id: 'forge-abc', title: 'Some issue', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir: gitDir, mockScript: gitScript } = createMockGit(porcelain);
      const { tmpDir: bdDir, mockScript: bdScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: bdScript, GIT_CMD: gitScript, NO_COLOR: '1' });
        expect(result.status).toBe(0);
        expect(result.stdout).not.toContain('ACTIVE SESSIONS');
      } finally {
        cleanupTmpDir(gitDir);
        cleanupTmpDir(bdDir);
      }
    });

    test('orphan branch with no matching issue shows as untracked', () => {
      const porcelain = [
        'worktree /repo',
        'HEAD abc123',
        'branch refs/heads/master',
        '',
        'worktree /repo/.worktrees/orphan-branch',
        'HEAD def456',
        'branch refs/heads/feat/orphan-branch',
        '',
      ].join('\n');
      const mockData = {
        issues: [
          { id: 'forge-abc', title: 'Some issue', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir: gitDir, mockScript: gitScript } = createMockGit(porcelain);
      const { tmpDir: bdDir, mockScript: bdScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: bdScript, GIT_CMD: gitScript, NO_COLOR: '1' });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('untracked');
      } finally {
        cleanupTmpDir(gitDir);
        cleanupTmpDir(bdDir);
      }
    });
  });
});
