const { existsSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { getPackageRoot, isCompiledBinary } = require('../package-root');

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

function handleTeam(args, projectRoot = process.cwd(), deps = {}) {
  // Route through the asset root so `forge team` finds the script in BOTH channels:
  // the on-disk package (npm/npx) and a compiled binary (extracted embed dir).
  const packageRoot = getPackageRoot();
  const scriptPath = path.join(packageRoot, 'scripts', 'forge-team', 'index.sh');
  const bashPath = _resolveBash();
  const runFile = deps.execFileSync || execFileSync;
  const options = { stdio: 'inherit' };
  if (deps.githubContext?.bound) {
    // Bash also runs Git/Forge/helpers. Only the re-entering gh bridge may resolve credentials.
    const compiled = (deps.isCompiledBinary || isCompiledBinary)();
    options.cwd = projectRoot;
    options.env = {
      ...process.env,
      GH_CMD: path.join(packageRoot, 'scripts', 'github-context-bridge.sh').replace(/\\/g, '/'),
      FORGE_GITHUB_RUNTIME: process.execPath.replace(/\\/g, '/'),
      FORGE_GITHUB_ENTRY: compiled ? '' : path.join(packageRoot, 'bin', 'forge.js').replace(/\\/g, '/'),
    };
  }

  try {
    runFile(bashPath, [scriptPath, ...args], options);
  } catch (err) {
    process.exit(err.status || 1);
  }
}

async function handler(args = [], _flags, projectRoot, deps = {}) {
  handleTeam(args, projectRoot, deps);
  return { success: true };
}

module.exports = {
  name: 'team',
  githubAuth: (args = []) => ['add', 'verify', 'sync', 'claim'].includes(args[0])
    || (args[0] === 'workload' && args.slice(1).some(arg => arg.replace(/\r$/, '') === '--me')),
  description: 'Team coordination workflows and sync utilities',
  handler,
  handleTeam
};
