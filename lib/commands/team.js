const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Resolve bash binary to a fixed path (SonarCloud security hotspot: PATH)
function _resolveBash() {
  if (process.platform === 'win32') {
    // Git Bash on Windows: use execFileSync to safely locate bash
    try {
      const result = execFileSync('where', ['bash'], { encoding: 'utf-8' });
      return result.split('\n')[0].trim();
    } catch { return 'bash'; }
  }
  return '/usr/bin/bash';
}

function handleTeam(args) {
  const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'forge-team', 'index.sh');
  const bashPath = _resolveBash();

  try {
    execFileSync(bashPath, [scriptPath, ...args], {
      stdio: 'inherit',
    });
  } catch (err) {
    process.exit(err.status || 1);
  }
}

module.exports = { handleTeam };
