const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
  if [[ "$3" == "master" ]]; then exit 0; fi
  exit 1
elif [[ "$1" == "--version" ]]; then
  echo "git version 2.42.0"
  exit 0
elif [[ "$1" == "diff" ]]; then
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

module.exports = {
  createMockGitTier2,
  createMockGitWithDiff,
  twoBranchPorcelain,
};
