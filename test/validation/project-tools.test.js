/**
 * Project Tools Setup Tests (RED Phase)
 *
 * Tests for Beads and OpenSpec auto-installation and initialization
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

describe('Project Tools - Helper Functions', () => {
  const forgePath = path.join(__dirname, '../../bin/forge.js');
  const forgeContent = fs.readFileSync(forgePath, 'utf8');

  test('checkForBeads() function exists', () => {
    assert.ok(forgeContent.includes('function checkForBeads()'), 'Should have checkForBeads function');
  });

  test('checkForBeads() checks global installation', () => {
    const hasGlobalCheck = forgeContent.includes("execFileSync('bd', ['version']");
    assert.ok(hasGlobalCheck, 'Should check for global bd installation');
  });

  test('checkForBeads() checks bunx capability', () => {
    const hasBunxCheck = forgeContent.includes("execFileSync('bunx', ['@beads/bd', 'version']");
    assert.ok(hasBunxCheck, 'Should check for bunx @beads/bd');
  });

  test('checkForOpenSpec() function exists', () => {
    assert.ok(forgeContent.includes('function checkForOpenSpec()'), 'Should have checkForOpenSpec function');
  });

  test('isBeadsInitialized() function exists', () => {
    assert.ok(forgeContent.includes('function isBeadsInitialized()'), 'Should have isBeadsInitialized function');
  });

  test('isBeadsInitialized() checks for .beads directory', () => {
    const hasBeadsCheck = forgeContent.includes('.beads');
    assert.ok(hasBeadsCheck, 'Should check for .beads directory');
  });

  test('isOpenSpecInitialized() function exists', () => {
    assert.ok(forgeContent.includes('function isOpenSpecInitialized()'), 'Should have isOpenSpecInitialized function');
  });

  test('initializeBeads() function exists', () => {
    assert.ok(forgeContent.includes('function initializeBeads('), 'Should have initializeBeads function');
  });

  test('initializeBeads() uses execFileSync for security', () => {
    const initBeadsStart = forgeContent.indexOf('function initializeBeads(');
    const nextFunctionStart = forgeContent.indexOf('function ', initBeadsStart + 10);
    const initBeadsCode = forgeContent.substring(initBeadsStart, nextFunctionStart);

    assert.ok(initBeadsCode.includes('execFileSync'), 'Should use execFileSync');
  });

  test('initializeOpenSpec() function exists', () => {
    assert.ok(forgeContent.includes('function initializeOpenSpec('), 'Should have initializeOpenSpec function');
  });
});

describe('Project Tools - Security', () => {
  const forgePath = path.join(__dirname, '../../bin/forge.js');
  const forgeContent = fs.readFileSync(forgePath, 'utf8');

  test('No hardcoded user input in commands', () => {
    const hasHardcodedBeads = forgeContent.includes("'@beads/bd'");
    const hasHardcodedOpenSpec = forgeContent.includes("'@fission-ai/openspec'");

    assert.ok(hasHardcodedBeads, 'Should have hardcoded @beads/bd package name');
    assert.ok(hasHardcodedOpenSpec, 'Should have hardcoded @fission-ai/openspec package name');
  });
});

describe('Project Tools - Quick Setup Integration', () => {
  const forgePath = path.join(__dirname, '../../bin/forge.js');
  const forgeContent = fs.readFileSync(forgePath, 'utf8');

  test('quickSetup() checks for Beads installation', () => {
    const quickSetupStart = forgeContent.indexOf('async function quickSetup(');
    const quickSetupEnd = forgeContent.indexOf('\nasync function', quickSetupStart + 10);
    const quickSetupCode = forgeContent.substring(quickSetupStart, quickSetupEnd);

    assert.ok(quickSetupCode.includes('checkForBeads()'), 'Should check for Beads installation');
  });

  test('quickSetup() checks if Beads is initialized', () => {
    const quickSetupStart = forgeContent.indexOf('async function quickSetup(');
    const quickSetupEnd = forgeContent.indexOf('\nasync function', quickSetupStart + 10);
    const quickSetupCode = forgeContent.substring(quickSetupStart, quickSetupEnd);

    assert.ok(quickSetupCode.includes('isBeadsInitialized()'), 'Should check if Beads is initialized');
  });

  test('quickSetup() initializes Beads if installed but not initialized', () => {
    const quickSetupStart = forgeContent.indexOf('async function quickSetup(');
    const quickSetupEnd = forgeContent.indexOf('\nasync function', quickSetupStart + 10);
    const quickSetupCode = forgeContent.substring(quickSetupStart, quickSetupEnd);

    assert.ok(quickSetupCode.includes('initializeBeads'), 'Should initialize Beads if installed');
  });

  test('quickSetup() auto-installs Beads globally if not installed', () => {
    const quickSetupStart = forgeContent.indexOf('async function quickSetup(');
    const quickSetupEnd = forgeContent.indexOf('\nasync function', quickSetupStart + 10);
    const quickSetupCode = forgeContent.substring(quickSetupStart, quickSetupEnd);

    // Should install @beads/bd globally
    assert.ok(quickSetupCode.includes('@beads/bd'), 'Should install @beads/bd package');
    assert.ok(quickSetupCode.includes('-g'), 'Should install globally');
  });

  test('quickSetup() handles OpenSpec if already installed', () => {
    const quickSetupStart = forgeContent.indexOf('async function quickSetup(');
    const quickSetupEnd = forgeContent.indexOf('\nasync function', quickSetupStart + 10);
    const quickSetupCode = forgeContent.substring(quickSetupStart, quickSetupEnd);

    assert.ok(quickSetupCode.includes('checkForOpenSpec()'), 'Should check for OpenSpec');
    assert.ok(quickSetupCode.includes('isOpenSpecInitialized()'), 'Should check if initialized');
  });

  test('quickSetup() does NOT auto-install OpenSpec (optional tool)', () => {
    const quickSetupStart = forgeContent.indexOf('async function quickSetup(');
    const quickSetupEnd = forgeContent.indexOf('\nasync function', quickSetupStart + 10);
    const quickSetupCode = forgeContent.substring(quickSetupStart, quickSetupEnd);

    // OpenSpec auto-install should be in a conditional that checks if it already exists
    // Should NOT have unconditional install of @fission-ai/openspec
    const lines = quickSetupCode.split('\n');
    const openspecInstallLines = lines.filter(line =>
      line.includes('@fission-ai/openspec') &&
      line.includes('install') &&
      !line.includes('if')
    );

    // Should not have unconditional OpenSpec install in quick mode
    assert.ok(openspecInstallLines.length === 0, 'Should NOT unconditionally install OpenSpec in quick mode');
  });
});

describe('Project Tools - Interactive Setup', () => {
  const forgePath = path.join(__dirname, '../../bin/forge.js');
  const forgeContent = fs.readFileSync(forgePath, 'utf8');

  test('setupProjectTools() function exists', () => {
    assert.ok(forgeContent.includes('async function setupProjectTools('), 'Should have setupProjectTools function');
  });

  test('setupProjectTools() is an async function', () => {
    const hasAsync = forgeContent.includes('async function setupProjectTools(');
    assert.ok(hasAsync, 'Should be an async function');
  });

  test('setupProjectTools() takes rl and question parameters', () => {
    const hasBothParams = forgeContent.includes('async function setupProjectTools(rl, question)');
    assert.ok(hasBothParams, 'Should take rl and question as parameters');
  });

  test('setupProjectTools() checks Beads initialization status', () => {
    const setupStart = forgeContent.indexOf('async function setupProjectTools(');
    if (setupStart === -1) return; // Function not implemented yet

    const nextFunctionStart = forgeContent.indexOf('\nasync function', setupStart + 10);
    const setupCode = forgeContent.substring(setupStart, nextFunctionStart !== -1 ? nextFunctionStart : forgeContent.length);

    assert.ok(setupCode.includes('isBeadsInitialized()'), 'Should check if Beads is initialized');
  });

  test('setupProjectTools() checks OpenSpec initialization status', () => {
    const setupStart = forgeContent.indexOf('async function setupProjectTools(');
    if (setupStart === -1) return; // Function not implemented yet

    const nextFunctionStart = forgeContent.indexOf('\nasync function', setupStart + 10);
    const setupCode = forgeContent.substring(setupStart, nextFunctionStart !== -1 ? nextFunctionStart : forgeContent.length);

    assert.ok(setupCode.includes('isOpenSpecInitialized()'), 'Should check if OpenSpec is initialized');
  });

  test('setupProjectTools() provides descriptive prompts', () => {
    const setupStart = forgeContent.indexOf('async function setupProjectTools(');
    if (setupStart === -1) return; // Function not implemented yet

    const nextFunctionStart = forgeContent.indexOf('\nasync function', setupStart + 10);
    const setupCode = forgeContent.substring(setupStart, nextFunctionStart !== -1 ? nextFunctionStart : forgeContent.length);

    // Should have descriptive text about what Beads and OpenSpec do
    const hasDescription = setupCode.includes('Beads') || setupCode.includes('issue') || setupCode.includes('tracking');
    assert.ok(hasDescription, 'Should provide descriptive prompts for tools');
  });

  test('setupProjectTools() offers installation method choices', () => {
    const setupStart = forgeContent.indexOf('async function setupProjectTools(');
    if (setupStart === -1) return; // Function not implemented yet

    const nextFunctionStart = forgeContent.indexOf('\nasync function', setupStart + 10);
    const setupCode = forgeContent.substring(setupStart, nextFunctionStart !== -1 ? nextFunctionStart : forgeContent.length);

    // Should offer global, local, or bunx installation methods
    const hasMethodChoice = setupCode.includes('global') || setupCode.includes('local') || setupCode.includes('bunx');
    assert.ok(hasMethodChoice, 'Should offer installation method choices');
  });

  test('setupProjectTools() uses execFileSync for installation (security)', () => {
    const setupStart = forgeContent.indexOf('async function setupProjectTools(');
    if (setupStart === -1) return; // Function not implemented yet

    const nextFunctionStart = forgeContent.indexOf('\nasync function', setupStart + 10);
    const setupCode = forgeContent.substring(setupStart, nextFunctionStart !== -1 ? nextFunctionStart : forgeContent.length);

    // Should use execFileSync (not execSync) for security
    if (setupCode.includes('child_process') || setupCode.includes('exec')) {
      assert.ok(setupCode.includes('execFileSync'), 'Should use execFileSync for security');
    }
  });
});
