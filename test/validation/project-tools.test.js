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
