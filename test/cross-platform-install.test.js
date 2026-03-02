const { describe, test, expect } = require('bun:test');
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
    expect(!forgeSource.includes("execFileSync('bun', ['add', '-d', 'lefthook']")).toBeTruthy();
  });

  test('should use PKG_MANAGER in autoInstallLefthook', () => {
    // Find the autoInstallLefthook function body
    const fnStart = forgeSource.indexOf('function autoInstallLefthook()');
    const fnEnd = forgeSource.indexOf('\n}', fnStart) + 2;
    const fnBody = forgeSource.slice(fnStart, fnEnd);

    expect(fnBody.includes('PKG_MANAGER')).toBeTruthy();
  });

  test('should have correct install flags per package manager in autoInstallLefthook', () => {
    const fnStart = forgeSource.indexOf('function autoInstallLefthook()');
    const fnEnd = forgeSource.indexOf('\n}', fnStart) + 2;
    const fnBody = forgeSource.slice(fnStart, fnEnd);

    // Must handle bun/pnpm 'add' vs npm/yarn 'install'
    expect(fnBody.includes("'add'") || fnBody.includes('"add"')).toBeTruthy();
    expect(fnBody.includes("'install'") || fnBody.includes('"install"')).toBeTruthy();
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

    expect(fnBody.includes("process.platform === 'win32'") || fnBody.includes('isWindows')).toBeTruthy();
  });

  test('autoSetupBeadsInQuickMode should use powershell for Windows beads install', () => {
    const fnStart = forgeSource.indexOf('function autoSetupBeadsInQuickMode()');
    const fnEnd = forgeSource.indexOf('\n}', fnStart) + 2;
    const fnBody = forgeSource.slice(fnStart, fnEnd);

    // Accepts either direct powershell/install.ps1 reference OR delegation to installBeadsOnWindows()
    // (the latter is preferred as it centralises the URL via BEADS_INSTALL_PS1_URL constant)
    expect(fnBody.includes('powershell') || fnBody.includes('install.ps1') || fnBody.includes('installBeadsOnWindows')).toBeTruthy();
  });

  test('installBeadsWithMethod should use PowerShell on Windows for global install', () => {
    const fnStart = forgeSource.indexOf('function installBeadsWithMethod(');
    const fnEnd = forgeSource.indexOf('\n}', fnStart) + 2;
    const fnBody = forgeSource.slice(fnStart, fnEnd);

    expect(fnBody.includes('win32') || fnBody.includes('powershell') || fnBody.includes('install.ps1')).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// forge-jxb: Error messages must use PKG_MANAGER not hardcoded bun
// ─────────────────────────────────────────────────────────────────────────────
describe('forge-jxb: Error messages use PKG_MANAGER', () => {
  test('Beads install failure message should not hardcode bun add -g', () => {
    expect(!forgeSource.includes("'  Run manually: bun add -g @beads/bd && bd init'")).toBeTruthy();
  });

  test('OpenSpec install message should not hardcode bun add -g', () => {
    expect(!forgeSource.includes("'  Run manually: bun add -g @fission-ai/openspec && openspec init'")).toBeTruthy();
  });

  test('lefthook install message should not hardcode bun add -d', () => {
    expect(!forgeSource.includes("'  Run manually: bun add -d lefthook'")).toBeTruthy();
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
    expect(fnBody.includes('openspec') && (fnBody.includes('not found') || fnBody.includes('not installed') || fnBody.includes('install'))).toBeTruthy();
  });

  test('autoSetupToolsInQuickMode should log when Skills is not installed', () => {
    const fnStart = forgeSource.indexOf('function autoSetupToolsInQuickMode()');
    const fnEnd = forgeSource.indexOf('\n}', fnStart) + 2;
    const fnBody = forgeSource.slice(fnStart, fnEnd);

    expect(fnBody.includes('skills') || fnBody.includes('Skills')).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// forge-4zz: Post-install verification for Beads
// ─────────────────────────────────────────────────────────────────────────────
describe('forge-4zz: Post-install verification', () => {
  test('should verify Beads after install by running bd version', () => {
    // After install, should call safeExec or secureExecFileSync with bd version
    expect(forgeSource.includes("'bd', ['version']") ||
      forgeSource.includes('"bd", ["version"]') ||
      forgeSource.includes("safeExec('bd version')") ||
      forgeSource.includes('verifyBeadsInstall') ||
      forgeSource.includes('bd version')).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// forge-0xb: lefthook.yml must use npx, not bunx
// ─────────────────────────────────────────────────────────────────────────────
describe('forge-0xb: lefthook.yml uses npx not bunx', () => {
  test('lefthook.yml commit-msg should not use bunx', () => {
    expect(!lefthookSource.includes('bunx commitlint')).toBeTruthy();
  });

  test('lefthook.yml pre-push lint should not use bunx', () => {
    expect(!lefthookSource.includes('bunx eslint')).toBeTruthy();
  });

  test('lefthook.yml commit-msg should delegate to scripts/commitlint.js', () => {
    expect(lefthookSource.includes('node scripts/commitlint.js')).toBeTruthy();
  });

  test('lefthook.yml pre-push lint should delegate to scripts/lint.js', () => {
    expect(lefthookSource.includes('node scripts/lint.js')).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// forge-cvr: pre-push hooks must not use bash-only syntax
// ─────────────────────────────────────────────────────────────────────────────
describe('forge-cvr: pre-push hooks cross-platform', () => {
  test('lefthook.yml pre-push lint should not use bash if [ $? syntax', () => {
    expect(!lefthookSource.includes('if [ $?')).toBeTruthy();
  });

  test('lefthook.yml test detection should not use bash command -v syntax', () => {
    expect(!lefthookSource.includes('command -v bun')).toBeTruthy();
  });

  test('scripts/lint.js should exist for cross-platform lint', () => {
    const lintScriptPath = path.join(__dirname, '..', 'scripts', 'lint.js');
    expect(fs.existsSync(lintScriptPath)).toBeTruthy();
  });

  test('scripts/test.js should exist for cross-platform test runner', () => {
    const testScriptPath = path.join(__dirname, '..', 'scripts', 'test.js');
    expect(fs.existsSync(testScriptPath)).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// forge-6q4: MCP server versions must be pinned
// ─────────────────────────────────────────────────────────────────────────────
describe('forge-6q4: MCP server versions pinned', () => {
  test('.mcp.json.example should not use @latest for context7', () => {
    const mcpSource = fs.readFileSync(mcpPath, 'utf8');
    expect(!mcpSource.includes('@upstash/context7-mcp@latest')).toBeTruthy();
  });

  test('.mcp.json.example context7 should have pinned version', () => {
    const mcpSource = fs.readFileSync(mcpPath, 'utf8');
    expect(mcpSource.includes('context7-mcp@') && !mcpSource.includes('@latest')).toBeTruthy();
  });
});
