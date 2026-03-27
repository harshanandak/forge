const { execFileSync } = require('node:child_process');
const path = require('node:path');

function handleTeam(args) {
  const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'forge-team', 'index.sh');
  const isWindows = process.platform === 'win32';

  try {
    execFileSync('bash', [scriptPath, ...args], {
      stdio: 'inherit',
      shell: isWindows,
    });
  } catch (err) {
    process.exit(err.status || 1);
  }
}

module.exports = { handleTeam };
