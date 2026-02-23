const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const forgePath = path.join(__dirname, '..', 'bin', 'forge.js');
const lefthookPath = path.join(__dirname, '..', 'lefthook.yml');
const mcpPath = path.join(__dirname, '..', '.mcp.json.example');

const forgeSource = fs.readFileSync(forgePath, 'utf8');
const lefthookSource = fs.readFileSync(lefthookPath, 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// forge-k6p: autoInstallLefthook must use PKG_MANAGER, not hardcoded bun
// ─────────────────────────────────────────────────────────────────────────────
describe('forge-k6p: autoInstallLefthook cross-platform', () => {
  test('should NOT hardcode bun in autoInstallLefthook', () => {
    // The old broken code: execFileSync('bun', ['add', '-d', 'lefthook'])
    assert.ok(
      !forgeSource.includes("execFileSync('bun', ['add', '-d', 'lefthook']"),
      'autoInstallLefthook must not hardcode bun — use PKG_MANAGER instead'
    );
  });

  test('should use PKG_MANAGER in autoInstallLefthook', () => {
    // Find the autoInstallLefthook function body
    const fnStart = forgeSource.indexOf('function autoInstallLefthook()');
    const fnEnd = forgeSource.indexOf('\n}', fnStart) + 2;
    const fnBody = forgeSource.slice(fnStart, fnEnd);

    assert.ok(
      fnBody.includes('PKG_MANAGER'),
      'autoInstallLefthook must use PKG_MANAGER for cross-platform support'
    );
  });

  test('should have correct install flags per package manager in autoInstallLefthook', () => {
    const fnStart = forgeSource.indexOf('function autoInstallLefthook()');
    const fnEnd = forgeSource.indexOf('\n}', fnStart) + 2;
    const fnBody = forgeSource.slice(fnStart, fnEnd);

    // Must handle bun/pnpm 'add' vs npm/yarn 'install'
    assert.ok(
      fnBody.includes("'add'") || fnBody.includes('"add"'),
      'autoInstallLefthook must handle bun/pnpm add flag'
    );
    assert.ok(
      fnBody.includes("'install'") || fnBody.includes('"install"'),
      'autoInstallLefthook must handle npm/yarn install flag'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// forge-63c: Windows Beads install must use PowerShell, not npm
// ─────────────────────────────────────────────────────────────────────────────
describe('forge-63c: Windows Beads install via PowerShell', () => {
  test('autoSetupBeadsInQuickMode should detect Windows and use PowerShell', () => {
    const fnStart = forgeSource.indexOf('function autoSetupBeadsInQuickMode()');
    const fnEnd = forgeSource.indexOf('\n}', fnStart) + 2;
    const fnBody = forgeSource.slice(fnStart, fnEnd);

    assert.ok(
      fnBody.includes("process.platform === 'win32'") || fnBody.includes('isWindows'),
      'autoSetupBeadsInQuickMode must detect Windows platform'
    );
  });

  test('autoSetupBeadsInQuickMode should use powershell for Windows beads install', () => {
    const fnStart = forgeSource.indexOf('function autoSetupBeadsInQuickMode()');
    const fnEnd = forgeSource.indexOf('\n}', fnStart) + 2;
    const fnBody = forgeSource.slice(fnStart, fnEnd);

    assert.ok(
      fnBody.includes('powershell') || fnBody.includes('install.ps1'),
      'Windows beads install must use PowerShell installer (install.ps1)'
    );
  });

  test('installBeadsWithMethod should use PowerShell on Windows for global install', () => {
    const fnStart = forgeSource.indexOf('function installBeadsWithMethod(');
    const fnEnd = forgeSource.indexOf('\n}', fnStart) + 2;
    const fnBody = forgeSource.slice(fnStart, fnEnd);

    assert.ok(
      fnBody.includes('win32') || fnBody.includes('powershell') || fnBody.includes('install.ps1'),
      'installBeadsWithMethod must have Windows-specific path using PowerShell'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// forge-jxb: Error messages must use PKG_MANAGER not hardcoded bun
// ─────────────────────────────────────────────────────────────────────────────
describe('forge-jxb: Error messages use PKG_MANAGER', () => {
  test('Beads install failure message should not hardcode bun add -g', () => {
    assert.ok(
      !forgeSource.includes("'  Run manually: bun add -g @beads/bd && bd init'"),
      'Beads error message must not hardcode bun — use PKG_MANAGER'
    );
  });

  test('OpenSpec install message should not hardcode bun add -g', () => {
    assert.ok(
      !forgeSource.includes("'  Run manually: bun add -g @fission-ai/openspec && openspec init'"),
      'OpenSpec error message must not hardcode bun — use PKG_MANAGER'
    );
  });

  test('lefthook install message should not hardcode bun add -d', () => {
    assert.ok(
      !forgeSource.includes("'  Run manually: bun add -d lefthook'"),
      'lefthook error message must not hardcode bun — use PKG_MANAGER'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// forge-92t: OpenSpec and Skills should show message when not installed
// ─────────────────────────────────────────────────────────────────────────────
describe('forge-92t: OpenSpec/Skills show message when not installed', () => {
  test('autoSetupToolsInQuickMode should log when OpenSpec is not installed', () => {
    const fnStart = forgeSource.indexOf('function autoSetupToolsInQuickMode()');
    const fnEnd = forgeSource.indexOf('\n}', fnStart) + 2;
    const fnBody = forgeSource.slice(fnStart, fnEnd);

    // Should have an else branch that logs when openspec not found
    assert.ok(
      fnBody.includes('openspec') && (fnBody.includes('not found') || fnBody.includes('not installed') || fnBody.includes('install')),
      'autoSetupToolsInQuickMode must show message when OpenSpec is not installed'
    );
  });

  test('autoSetupToolsInQuickMode should log when Skills is not installed', () => {
    const fnStart = forgeSource.indexOf('function autoSetupToolsInQuickMode()');
    const fnEnd = forgeSource.indexOf('\n}', fnStart) + 2;
    const fnBody = forgeSource.slice(fnStart, fnEnd);

    assert.ok(
      fnBody.includes('skills') || fnBody.includes('Skills'),
      'autoSetupToolsInQuickMode must handle Skills not installed case'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// forge-4zz: Post-install verification for Beads
// ─────────────────────────────────────────────────────────────────────────────
describe('forge-4zz: Post-install verification', () => {
  test('should verify Beads after install by running bd version', () => {
    // After install, should call safeExec or secureExecFileSync with bd version
    assert.ok(
      forgeSource.includes("'bd', ['version']") ||
      forgeSource.includes('"bd", ["version"]') ||
      forgeSource.includes("safeExec('bd version')") ||
      forgeSource.includes('verifyBeadsInstall') ||
      forgeSource.includes('bd version'),
      'Beads post-install verification must call bd version'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// forge-0xb: lefthook.yml must use npx, not bunx
// ─────────────────────────────────────────────────────────────────────────────
describe('forge-0xb: lefthook.yml uses npx not bunx', () => {
  test('lefthook.yml commit-msg should not use bunx', () => {
    assert.ok(
      !lefthookSource.includes('bunx commitlint'),
      'commit-msg hook must not use bunx — use npx for cross-platform support'
    );
  });

  test('lefthook.yml pre-push lint should not use bunx', () => {
    assert.ok(
      !lefthookSource.includes('bunx eslint'),
      'pre-push lint hook must not use bunx — use npx for cross-platform support'
    );
  });

  test('lefthook.yml commit-msg should use npx', () => {
    assert.ok(
      lefthookSource.includes('npx') && lefthookSource.includes('commitlint'),
      'commit-msg hook must use npx commitlint'
    );
  });

  test('lefthook.yml pre-push lint should delegate to scripts/lint.js', () => {
    assert.ok(
      lefthookSource.includes('node scripts/lint.js'),
      'pre-push lint hook must delegate to node scripts/lint.js (cross-platform)'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// forge-cvr: pre-push hooks must not use bash-only syntax
// ─────────────────────────────────────────────────────────────────────────────
describe('forge-cvr: pre-push hooks cross-platform', () => {
  test('lefthook.yml pre-push lint should not use bash if [ $? syntax', () => {
    assert.ok(
      !lefthookSource.includes('if [ $?'),
      'pre-push hooks must not use bash-only if [ $? ] syntax'
    );
  });

  test('lefthook.yml test detection should not use bash command -v syntax', () => {
    assert.ok(
      !lefthookSource.includes('command -v bun'),
      'pre-push test detection must not use bash-only command -v syntax'
    );
  });

  test('scripts/lint.js should exist for cross-platform lint', () => {
    const lintScriptPath = path.join(__dirname, '..', 'scripts', 'lint.js');
    assert.ok(
      fs.existsSync(lintScriptPath),
      'scripts/lint.js must exist for cross-platform ESLint execution'
    );
  });

  test('scripts/test.js should exist for cross-platform test runner', () => {
    const testScriptPath = path.join(__dirname, '..', 'scripts', 'test.js');
    assert.ok(
      fs.existsSync(testScriptPath),
      'scripts/test.js must exist for cross-platform test execution'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// forge-6q4: MCP server versions must be pinned
// ─────────────────────────────────────────────────────────────────────────────
describe('forge-6q4: MCP server versions pinned', () => {
  test('.mcp.json.example should not use @latest for context7', () => {
    const mcpSource = fs.readFileSync(mcpPath, 'utf8');
    assert.ok(
      !mcpSource.includes('@upstash/context7-mcp@latest'),
      'context7 MCP must not use @latest — pin to specific version'
    );
  });

  test('.mcp.json.example context7 should have pinned version', () => {
    const mcpSource = fs.readFileSync(mcpPath, 'utf8');
    assert.ok(
      mcpSource.includes('context7-mcp@') && !mcpSource.includes('@latest'),
      'context7 MCP must have a pinned semver version'
    );
  });
});
