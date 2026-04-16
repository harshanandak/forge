const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test, expect, setDefaultTimeout } = require('bun:test');

const { cleanupTmpDir, createMockBd, daysAgo, runSmartStatus } = require('./smart-status.helpers');

setDefaultTimeout(20000);

describe('smart-status.sh', () => {
  describe('file-level conflict detection', () => {
    /**
     * Helper: create a mock git that handles both worktree list (porcelain)
     * and diff (for changed files per branch).
     * @param {string} porcelainOutput - worktree list --porcelain output
     * @param {Object<string, string[]>} branchFiles - map of branch name -> changed files
     */
    function createMockGitWithDiff(porcelainOutput, branchFiles) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-status-conflict-'));
      const mockScript = path.join(tmpDir, 'git');
      const diffCases = Object.entries(branchFiles).map(([branch, files]) => {
        if (files.length === 0) return `    "${branch}") echo "" ;;`;
        const fileList = files.join('\\n');
        return `    "${branch}") printf '${fileList}\\n' ;;`;
      }).join('\n');
      const scriptContent = `#!/usr/bin/env bash
if [[ "$1" == "worktree" ]]; then
  cat <<'PORCELAINEOF'
${porcelainOutput}
PORCELAINEOF
  exit 0
elif [[ "$1" == "rev-parse" ]]; then
  # Support DEFAULT_BRANCH auto-detection: say master exists
  if [[ "$3" == "master" ]]; then exit 0; fi
  exit 1
elif [[ "$1" == "--version" ]]; then
  echo "git version 2.42.0"
  exit 0
elif [[ "$1" == "diff" ]]; then
  # Extract branch: git diff <base>...<branch> --name-only --
  BRANCH="\${2#master...}"
  BRANCH="\${BRANCH#main...}"
  case "$BRANCH" in
${diffCases}
    *) echo "" ;;
  esac
  exit 0
elif [[ "$1" == "merge-tree" ]]; then
  exit 0
fi
command git "$@"
`;
      fs.writeFileSync(mockScript, scriptContent, { mode: 0o755 });
      return { tmpDir, mockScript };
    }

    test('shows Changed: line with files for each active session branch', () => {
      const porcelain = [
        'worktree /repo', 'HEAD abc123', 'branch refs/heads/master', '',
        'worktree /repo/.worktrees/alpha', 'HEAD def456', 'branch refs/heads/feat/alpha', '',
        'worktree /repo/.worktrees/beta', 'HEAD ghi789', 'branch refs/heads/feat/beta', '',
      ].join('\n');
      const branchFiles = {
        'feat/alpha': ['src/a.js', 'src/b.js'],
        'feat/beta': ['src/c.js'],
      };
      const mockBd = createMockBd({
        issues: [
          { id: 'i1', title: 'Alpha work', priority: 'P2', type: 'feature', status: 'in_progress', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      });
      const mockGit = createMockGitWithDiff(porcelain, branchFiles);
      try {
        const result = runSmartStatus([], {
          BD_CMD: mockBd.mockScript, GIT_CMD: mockGit.mockScript, NO_COLOR: '1',
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('ACTIVE SESSIONS');
        expect(result.stdout).toContain('feat/alpha');
        expect(result.stdout).toContain('Changed:');
        expect(result.stdout).toContain('src/a.js');
        expect(result.stdout).toContain('src/b.js');
        expect(result.stdout).toContain('feat/beta');
        expect(result.stdout).toContain('src/c.js');
      } finally {
        cleanupTmpDir(mockBd.tmpDir);
        cleanupTmpDir(mockGit.tmpDir);
      }
    });

    test('truncates to 3 files with +N more', () => {
      const porcelain = [
        'worktree /repo', 'HEAD abc123', 'branch refs/heads/master', '',
        'worktree /repo/.worktrees/big', 'HEAD def456', 'branch refs/heads/feat/big', '',
        'worktree /repo/.worktrees/other', 'HEAD ghi789', 'branch refs/heads/feat/other', '',
      ].join('\n');
      const branchFiles = {
        'feat/big': ['f1.js', 'f2.js', 'f3.js', 'f4.js', 'f5.js'],
        'feat/other': ['x.js'],
      };
      const mockBd = createMockBd({
        issues: [
          { id: 'i1', title: 'Big work', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      });
      const mockGit = createMockGitWithDiff(porcelain, branchFiles);
      try {
        const result = runSmartStatus([], {
          BD_CMD: mockBd.mockScript, GIT_CMD: mockGit.mockScript, NO_COLOR: '1',
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('f1.js');
        expect(result.stdout).toContain('f2.js');
        expect(result.stdout).toContain('f3.js');
        expect(result.stdout).toContain('+2 more');
        expect(result.stdout).not.toContain('f4.js');
        expect(result.stdout).not.toContain('f5.js');
      } finally {
        cleanupTmpDir(mockBd.tmpDir);
        cleanupTmpDir(mockGit.tmpDir);
      }
    });

    test('shows conflict risk when branches share files', () => {
      const porcelain = [
        'worktree /repo', 'HEAD abc123', 'branch refs/heads/master', '',
        'worktree /repo/.worktrees/alpha', 'HEAD def456', 'branch refs/heads/feat/alpha', '',
        'worktree /repo/.worktrees/beta', 'HEAD ghi789', 'branch refs/heads/feat/beta', '',
      ].join('\n');
      const branchFiles = {
        'feat/alpha': ['shared.js', 'alpha-only.js'],
        'feat/beta': ['shared.js', 'beta-only.js'],
      };
      const mockBd = createMockBd({
        issues: [
          { id: 'i1', title: 'Work', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      });
      const mockGit = createMockGitWithDiff(porcelain, branchFiles);
      try {
        const result = runSmartStatus([], {
          BD_CMD: mockBd.mockScript, GIT_CMD: mockGit.mockScript, NO_COLOR: '1',
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/[Cc]onflict risk/);
        expect(result.stdout).toContain('shared.js');
      } finally {
        cleanupTmpDir(mockBd.tmpDir);
        cleanupTmpDir(mockGit.tmpDir);
      }
    });

    test('no conflict risk when branches have no overlapping files', () => {
      const porcelain = [
        'worktree /repo', 'HEAD abc123', 'branch refs/heads/master', '',
        'worktree /repo/.worktrees/alpha', 'HEAD def456', 'branch refs/heads/feat/alpha', '',
        'worktree /repo/.worktrees/beta', 'HEAD ghi789', 'branch refs/heads/feat/beta', '',
      ].join('\n');
      const branchFiles = {
        'feat/alpha': ['alpha.js'],
        'feat/beta': ['beta.js'],
      };
      const mockBd = createMockBd({
        issues: [
          { id: 'i1', title: 'Work', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      });
      const mockGit = createMockGitWithDiff(porcelain, branchFiles);
      try {
        const result = runSmartStatus([], {
          BD_CMD: mockBd.mockScript, GIT_CMD: mockGit.mockScript, NO_COLOR: '1',
        });
        expect(result.status).toBe(0);
        expect(result.stdout).not.toMatch(/[Cc]onflict risk/);
      } finally {
        cleanupTmpDir(mockBd.tmpDir);
        cleanupTmpDir(mockGit.tmpDir);
      }
    });

    test('no Changed line for branch with no changed files', () => {
      const porcelain = [
        'worktree /repo', 'HEAD abc123', 'branch refs/heads/master', '',
        'worktree /repo/.worktrees/empty', 'HEAD def456', 'branch refs/heads/feat/empty', '',
        'worktree /repo/.worktrees/full', 'HEAD ghi789', 'branch refs/heads/feat/full', '',
      ].join('\n');
      const branchFiles = {
        'feat/empty': [],
        'feat/full': ['a.js'],
      };
      const mockBd = createMockBd({
        issues: [
          { id: 'i1', title: 'Work', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      });
      const mockGit = createMockGitWithDiff(porcelain, branchFiles);
      try {
        const result = runSmartStatus([], {
          BD_CMD: mockBd.mockScript, GIT_CMD: mockGit.mockScript, NO_COLOR: '1',
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('feat/full');
        expect(result.stdout).toContain('a.js');
      } finally {
        cleanupTmpDir(mockBd.tmpDir);
        cleanupTmpDir(mockGit.tmpDir);
      }
    });
  });

  describe('tier-2 merge-tree conflict detection', () => {
    /**
     * Helper: create a mock git that handles worktree, diff, --version, and merge-tree.
     * @param {string} porcelainOutput - worktree list --porcelain output
     * @param {Object<string, string[]>} branchFiles - map of branch name -> changed files
     * @param {string} gitVersion - git version string (e.g. "git version 2.45.0")
     * @param {Object<string, {exitCode: number, output: string}>} mergeTreeResults - map of "branch1 branch2" -> result
     */
    function createMockGitTier2(porcelainOutput, branchFiles, gitVersion, mergeTreeResults) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-status-tier2-'));
      const mockScript = path.join(tmpDir, 'git');
      const diffCases = Object.entries(branchFiles).map(([branch, files]) => {
        if (files.length === 0) return `    "${branch}") echo "" ;;`;
        const fileList = files.join('\\n');
        return `    "${branch}") printf '${fileList}\\n' ;;`;
      }).join('\n');
      const mergeCases = Object.entries(mergeTreeResults || {}).map(([pair, result]) => {
        const [b1, b2] = pair.split(' ');
        return `    if [ "$MTBRANCH1" = "${b1}" ] && [ "$MTBRANCH2" = "${b2}" ]; then
      echo "abc123def456abc123def456abc123def456abc1234"
      printf '%s\\n' '${result.output || ''}'
      exit ${result.exitCode}
    fi`;
      }).join('\n');
      const scriptContent = `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "${gitVersion}"
  exit 0
elif [ "$1" = "worktree" ]; then
  cat <<'PORCELAINEOF'
${porcelainOutput}
PORCELAINEOF
  exit 0
elif [ "$1" = "rev-parse" ]; then
  if [ "$3" = "master" ]; then exit 0; fi
  exit 1
elif [ "$1" = "diff" ]; then
  BRANCH="\${2#master...}"
  BRANCH="\${BRANCH#main...}"
  case "$BRANCH" in
${diffCases}
    *) echo "" ;;
  esac
  exit 0
elif [ "$1" = "merge-tree" ]; then
  shift
  MTBRANCH1=""
  MTBRANCH2=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --*) shift ;;
      *)
        if [ -z "$MTBRANCH1" ]; then
          MTBRANCH1="$1"
        else
          MTBRANCH2="$1"
        fi
        shift
        ;;
    esac
  done
${mergeCases}
  exit 0
fi
command git "$@"
`;
      fs.writeFileSync(mockScript, scriptContent, { mode: 0o755 });
      return { tmpDir, mockScript };
    }

    const twoBranchPorcelain = [
      'worktree /repo', 'HEAD abc123', 'branch refs/heads/master', '',
      'worktree /repo/.worktrees/alpha', 'HEAD def456', 'branch refs/heads/feat/alpha', '',
      'worktree /repo/.worktrees/beta', 'HEAD ghi789', 'branch refs/heads/feat/beta', '',
    ].join('\n');

    test('shows !! Merge conflict for real conflicts (exit 1)', () => {
      const branchFiles = {
        'feat/alpha': ['shared.js', 'alpha-only.js'],
        'feat/beta': ['shared.js', 'beta-only.js'],
      };
      const mergeTreeResults = {
        'feat/alpha feat/beta': { exitCode: 1, output: 'shared.js' },
      };
      const mockBd = createMockBd({
        issues: [
          { id: 'i1', title: 'Work', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      });
      const mockGit = createMockGitTier2(twoBranchPorcelain, branchFiles, 'git version 2.45.0', mergeTreeResults);
      try {
        const result = runSmartStatus([], {
          BD_CMD: mockBd.mockScript, GIT_CMD: mockGit.mockScript, NO_COLOR: '1',
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('!! Merge conflict');
        expect(result.stdout).toContain('shared.js');
      } finally {
        cleanupTmpDir(mockBd.tmpDir);
        cleanupTmpDir(mockGit.tmpDir);
      }
    });

    test('keeps ! Conflict risk for file-overlap-only (exit 0, no real conflict)', () => {
      const branchFiles = {
        'feat/alpha': ['shared.js', 'alpha-only.js'],
        'feat/beta': ['shared.js', 'beta-only.js'],
      };
      const mergeTreeResults = {
        'feat/alpha feat/beta': { exitCode: 0, output: '' },
      };
      const mockBd = createMockBd({
        issues: [
          { id: 'i1', title: 'Work', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      });
      const mockGit = createMockGitTier2(twoBranchPorcelain, branchFiles, 'git version 2.45.0', mergeTreeResults);
      try {
        const result = runSmartStatus([], {
          BD_CMD: mockBd.mockScript, GIT_CMD: mockGit.mockScript, NO_COLOR: '1',
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/! Conflict risk/);
        expect(result.stdout).not.toContain('!! Merge conflict');
      } finally {
        cleanupTmpDir(mockBd.tmpDir);
        cleanupTmpDir(mockGit.tmpDir);
      }
    });

    test('skips Tier 2 silently when git version < 2.38', () => {
      const branchFiles = {
        'feat/alpha': ['shared.js'],
        'feat/beta': ['shared.js'],
      };
      const mockBd = createMockBd({
        issues: [
          { id: 'i1', title: 'Work', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      });
      const mockGit = createMockGitTier2(twoBranchPorcelain, branchFiles, 'git version 2.37.1', {});
      try {
        const result = runSmartStatus([], {
          BD_CMD: mockBd.mockScript, GIT_CMD: mockGit.mockScript, NO_COLOR: '1',
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/! Conflict risk/);
        expect(result.stdout).not.toContain('!! Merge conflict');
      } finally {
        cleanupTmpDir(mockBd.tmpDir);
        cleanupTmpDir(mockGit.tmpDir);
      }
    });

    test('JSON output includes merge_conflicts field for real conflicts', () => {
      const branchFiles = {
        'feat/alpha': ['shared.js'],
        'feat/beta': ['shared.js'],
      };
      const mergeTreeResults = {
        'feat/alpha feat/beta': { exitCode: 1, output: 'shared.js' },
      };
      const mockBd = createMockBd({
        issues: [
          { id: 'i1', title: 'Work', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      });
      const mockGit = createMockGitTier2(twoBranchPorcelain, branchFiles, 'git version 2.45.0', mergeTreeResults);
      try {
        const result = runSmartStatus(['--json'], {
          BD_CMD: mockBd.mockScript, GIT_CMD: mockGit.mockScript, NO_COLOR: '1',
        });
        expect(result.status).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed).toHaveProperty('sessions');
        const allConflicts = parsed.sessions.flatMap(s => s.merge_conflicts || []);
        expect(allConflicts.length).toBeGreaterThan(0);
        expect(allConflicts[0]).toHaveProperty('branch');
        expect(allConflicts[0]).toHaveProperty('files');
        expect(allConflicts[0].files).toContain('shared.js');
      } finally {
        cleanupTmpDir(mockBd.tmpDir);
        cleanupTmpDir(mockGit.tmpDir);
      }
    });

    test('no merge_conflicts when git >= 2.38 but no real conflicts', () => {
      const branchFiles = {
        'feat/alpha': ['shared.js'],
        'feat/beta': ['shared.js'],
      };
      const mergeTreeResults = {
        'feat/alpha feat/beta': { exitCode: 0, output: '' },
      };
      const mockBd = createMockBd({
        issues: [
          { id: 'i1', title: 'Work', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      });
      const mockGit = createMockGitTier2(twoBranchPorcelain, branchFiles, 'git version 2.45.0', mergeTreeResults);
      try {
        const result = runSmartStatus(['--json'], {
          BD_CMD: mockBd.mockScript, GIT_CMD: mockGit.mockScript, NO_COLOR: '1',
        });
        expect(result.status).toBe(0);
        const parsed = JSON.parse(result.stdout);
        const allConflicts = parsed.sessions.flatMap(s => s.merge_conflicts || []);
        expect(allConflicts.length).toBe(0);
      } finally {
        cleanupTmpDir(mockBd.tmpDir);
        cleanupTmpDir(mockGit.tmpDir);
      }
    });
  });
});
