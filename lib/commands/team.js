const { existsSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Resolve bash binary from fixed, known locations only (no PATH search).
// SonarCloud S4036: PATH must not be searched for OS commands.
function _resolveBash() {
  if (process.platform === 'win32') {
    // Fixed locations for Git Bash on Windows (no PATH search)
    const candidates = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
      `${process.env.LOCALAPPDATA || ''}\\Programs\\Git\\bin\\bash.exe`,
    ];
    for (const p of candidates) {
      if (p && existsSync(p)) return p;
    }
    // Fallback: assume Git Bash is in PATH (less secure but functional)
    return 'bash';
  }
  return '/usr/bin/bash';
}

function handleTeam(args) {
  const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'forge-team', 'index.sh');
  const bashPath = _resolveBash();

  execFileSync(bashPath, [scriptPath, ...args], {
    stdio: 'inherit',
  });
}

module.exports = {
  name: 'team',
  description: 'Team orchestration — assignment sync, workload views',
  handler: async (args, _flags, _projectRoot) => {
    return handleTeam(args);
  },
  handleTeam,
};
