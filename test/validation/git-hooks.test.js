/**
 * Git Hooks Validation Tests (RED Phase)
 *
 * Tests for lefthook configuration and TDD enforcement hooks
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

describe('Git Hooks - Lefthook Configuration', () => {
  const lefthookPath = path.join(__dirname, '../../lefthook.yml');

  test('lefthook.yml exists', () => {
    assert.strictEqual(fs.existsSync(lefthookPath), true, 'lefthook.yml should exist');
  });

  test('lefthook.yml is valid YAML syntax', () => {
    const content = fs.readFileSync(lefthookPath, 'utf8');

    // Basic YAML validation: no tabs, valid structure
    assert.strictEqual(content.includes('\t'), false, 'YAML should not contain tabs');
    assert.ok(content.trim().length > 0, 'YAML should not be empty');
  });

  test('lefthook.yml defines pre-commit hook', () => {
    const content = fs.readFileSync(lefthookPath, 'utf8');

    assert.ok(content.includes('pre-commit:'), 'Should define pre-commit hook');
    assert.ok(content.includes('commands:'), 'Should have commands section');
  });

  test('pre-commit hook runs tdd-check command', () => {
    const content = fs.readFileSync(lefthookPath, 'utf8');

    assert.ok(content.includes('check-tdd'), 'Should reference check-tdd script');
    assert.ok(content.includes('run:'), 'Should have run command');
  });

  test('lefthook.yml defines pre-push hook', () => {
    const content = fs.readFileSync(lefthookPath, 'utf8');

    assert.ok(content.includes('pre-push:'), 'Should define pre-push hook');
  });

  test('pre-push hook runs test command', () => {
    const content = fs.readFileSync(lefthookPath, 'utf8');

    // Should reference npm test or similar
    const hasTestCommand = /npm test|npm run test|test/.test(content);
    assert.ok(hasTestCommand, 'Should reference test command');
  });
});

describe('Git Hooks - TDD Check Script', () => {
  const checkTddPath = path.join(__dirname, '../../.forge/hooks/check-tdd.js');

  test('check-tdd.js exists', () => {
    assert.strictEqual(fs.existsSync(checkTddPath), true, 'check-tdd.js should exist');
  });

  test('check-tdd.js is executable (has shebang)', () => {
    const content = fs.readFileSync(checkTddPath, 'utf8');
    assert.ok(content.startsWith('#!/usr/bin/env node'), 'Should have node shebang');
  });

  test('check-tdd.js detects source changes without tests', () => {
    const content = fs.readFileSync(checkTddPath, 'utf8');

    // Should have logic to detect staged files
    assert.ok(content.includes('git'), 'Should use git commands');
    assert.ok(content.includes('diff'), 'Should check git diff');
    assert.ok(content.includes('--cached'), 'Should check staged files');

    // Should check for test files
    const hasTestCheck = content.includes('.test.') || content.includes('.spec.');
    assert.ok(hasTestCheck, 'Should check for test files');
  });

  test('check-tdd.js offers guided recovery options', () => {
    const content = fs.readFileSync(checkTddPath, 'utf8');

    // Should provide helpful prompts
    assert.ok(content.includes('What would you like to do?'), 'Should ask user for action');

    // Should offer multiple options
    const hasOptions = content.includes('unstage') || content.includes('continue');
    assert.ok(hasOptions, 'Should offer recovery options');
  });

  test('check-tdd.js allows --no-verify override', () => {
    const content = fs.readFileSync(checkTddPath, 'utf8');

    // Should mention override mechanism
    const hasOverride = content.includes('--no-verify') || content.includes('SKIP');
    assert.ok(hasOverride, 'Should mention override option');
  });

  test('check-tdd.js has conversational error messages', () => {
    const content = fs.readFileSync(checkTddPath, 'utf8');

    // Should have user-friendly messages
    const hasConversational = /looks like|seems like|noticed|found/i.test(content);
    assert.ok(hasConversational, 'Should have conversational messages');
  });

  test('check-tdd.js uses execFileSync not execSync (security)', () => {
    const content = fs.readFileSync(checkTddPath, 'utf8');

    // Should use execFileSync for security
    if (content.includes('child_process')) {
      assert.ok(content.includes('execFileSync'), 'Should use execFileSync');
      // Should NOT use execSync which allows shell injection
      assert.ok(!content.includes('execSync('), 'Should not use execSync');
    }
  });
});

describe('Git Hooks - Integration', () => {
  test('lefthook references correct script path', () => {
    const lefthookContent = fs.readFileSync(
      path.join(__dirname, '../../lefthook.yml'),
      'utf8'
    );

    // Should reference .forge/hooks/check-tdd.js
    assert.ok(
      lefthookContent.includes('.forge/hooks/check-tdd'),
      'Should reference correct hook path'
    );
  });

  test('hooks are user-friendly (skippable in emergencies)', () => {
    const lefthookContent = fs.readFileSync(
      path.join(__dirname, '../../lefthook.yml'),
      'utf8'
    );

    // Should allow skipping via LEFTHOOK environment variable
    const isSkippable = /LEFTHOOK|skip/i.test(lefthookContent);
    assert.ok(isSkippable, 'Should allow skipping hooks');
  });
});
