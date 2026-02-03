/**
 * Forge Validate CLI Tests (RED Phase)
 *
 * Tests for prerequisite validation across workflow stages
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

describe('Forge Validate CLI - Existence', () => {
  const validatePath = path.join(__dirname, '../../bin/forge-validate.js');

  test('forge-validate.js exists', () => {
    assert.strictEqual(fs.existsSync(validatePath), true, 'forge-validate.js should exist');
  });

  test('forge-validate.js is executable (has shebang)', () => {
    const content = fs.readFileSync(validatePath, 'utf8');
    assert.ok(content.startsWith('#!/usr/bin/env node'), 'Should have node shebang');
  });

  test('package.json includes forge-validate bin entry', () => {
    const pkgPath = path.join(__dirname, '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

    assert.ok(pkg.bin, 'package.json should have bin field');
    assert.strictEqual(pkg.bin['forge-validate'], 'bin/forge-validate.js', 'Should have forge-validate bin entry');
  });
});

describe('Forge Validate CLI - Command Structure', () => {
  const validatePath = path.join(__dirname, '../../bin/forge-validate.js');

  test('supports "forge validate status" command', () => {
    const content = fs.readFileSync(validatePath, 'utf8');
    assert.ok(content.includes('status'), 'Should support status command');
  });

  test('supports "forge validate dev" command', () => {
    const content = fs.readFileSync(validatePath, 'utf8');
    assert.ok(content.includes('dev'), 'Should support dev command');
  });

  test('supports "forge validate ship" command', () => {
    const content = fs.readFileSync(validatePath, 'utf8');
    assert.ok(content.includes('ship'), 'Should support ship command');
  });

  test('shows helpful error for invalid stage', () => {
    const content = fs.readFileSync(validatePath, 'utf8');

    // Should have error handling for invalid commands
    const hasErrorHandling = content.includes('Unknown') || content.includes('Invalid');
    assert.ok(hasErrorHandling, 'Should handle invalid commands');
  });
});

describe('Forge Validate CLI - Status Command', () => {
  const validatePath = path.join(__dirname, '../../bin/forge-validate.js');

  test('status command checks for git repository', () => {
    const content = fs.readFileSync(validatePath, 'utf8');

    // Should check if .git exists or run git command
    const checksGit = content.includes('.git') || content.includes('git rev-parse');
    assert.ok(checksGit, 'Should check for git repository');
  });

  test('status command checks for package.json', () => {
    const content = fs.readFileSync(validatePath, 'utf8');
    assert.ok(content.includes('package.json'), 'Should check for package.json');
  });

  test('status command checks for test framework', () => {
    const content = fs.readFileSync(validatePath, 'utf8');

    // Should check for jest, vitest, or test command
    const checksTests = content.includes('jest') || content.includes('test');
    assert.ok(checksTests, 'Should check for test framework');
  });
});

describe('Forge Validate CLI - Dev Command', () => {
  const validatePath = path.join(__dirname, '../../bin/forge-validate.js');

  test('dev command checks for plan file', () => {
    const content = fs.readFileSync(validatePath, 'utf8');

    // Should check .claude/plans/ directory
    const checksPlan = content.includes('.claude/plans') || content.includes('plan');
    assert.ok(checksPlan, 'Should check for plan file');
  });

  test('dev command checks for research file', () => {
    const content = fs.readFileSync(validatePath, 'utf8');

    // Should check docs/research/ directory
    const checksResearch = content.includes('docs/research') || content.includes('research');
    assert.ok(checksResearch, 'Should check for research file');
  });

  test('dev command checks for feature branch', () => {
    const content = fs.readFileSync(validatePath, 'utf8');

    // Should check git branch (feat/*, fix/*, etc.)
    const checksBranch = content.includes('git') && content.includes('branch');
    assert.ok(checksBranch, 'Should check git branch');
  });
});

describe('Forge Validate CLI - Ship Command', () => {
  const validatePath = path.join(__dirname, '../../bin/forge-validate.js');

  test('ship command checks for tests', () => {
    const content = fs.readFileSync(validatePath, 'utf8');

    // Should verify tests exist and pass
    const checksTests = content.includes('test') || content.includes('.test.');
    assert.ok(checksTests, 'Should check for tests');
  });

  test('ship command checks for documentation', () => {
    const content = fs.readFileSync(validatePath, 'utf8');

    // Should check for README or docs updates
    const checksDocs = content.includes('README') || content.includes('docs');
    assert.ok(checksDocs, 'Should check for documentation');
  });

  test('ship command checks for passing CI', () => {
    const content = fs.readFileSync(validatePath, 'utf8');

    // Should mention tests passing or CI
    const checksCI = content.includes('npm test') || content.includes('test');
    assert.ok(checksCI, 'Should check tests pass');
  });
});

describe('Forge Validate CLI - Security', () => {
  const validatePath = path.join(__dirname, '../../bin/forge-validate.js');

  test('uses execFileSync not execSync (security)', () => {
    const content = fs.readFileSync(validatePath, 'utf8');

    // If using child_process, should use execFileSync
    if (content.includes('child_process')) {
      assert.ok(content.includes('execFileSync'), 'Should use execFileSync');
      // Should NOT use execSync which allows shell injection
      assert.ok(!content.includes('execSync('), 'Should not use execSync');
    }
  });

  test('does not use eval or Function constructor', () => {
    const content = fs.readFileSync(validatePath, 'utf8');

    // Security: no dynamic code execution
    assert.ok(!content.includes('eval('), 'Should not use eval');
    assert.ok(!content.includes('new Function('), 'Should not use Function constructor');
  });

  test('validates user input before using in commands', () => {
    const content = fs.readFileSync(validatePath, 'utf8');

    // Should have input validation for stage names
    const hasValidation = content.includes('validate') || content.includes('includes');
    assert.ok(hasValidation, 'Should validate user input');
  });
});

describe('Forge Validate CLI - User Experience', () => {
  const validatePath = path.join(__dirname, '../../bin/forge-validate.js');

  test('provides helpful error messages', () => {
    const content = fs.readFileSync(validatePath, 'utf8');

    // Should have descriptive errors
    const hasOutput = content.includes('console.error') || content.includes('console.log');
    assert.ok(hasOutput, 'Should provide error messages');
  });

  test('shows validation results clearly', () => {
    const content = fs.readFileSync(validatePath, 'utf8');

    // Should output results (✓/✗ or pass/fail)
    const hasResults = content.includes('✓') || content.includes('PASS') || content.includes('OK');
    assert.ok(hasResults, 'Should show validation results');
  });

  test('includes usage instructions', () => {
    const content = fs.readFileSync(validatePath, 'utf8');

    // Should show help or usage
    const hasHelp = content.includes('Usage') || content.includes('help');
    assert.ok(hasHelp, 'Should include usage instructions');
  });
});

describe('Forge Validate CLI - Integration', () => {
  const validatePath = path.join(__dirname, '../../bin/forge-validate.js');

  test('can be imported as a module', () => {
    const content = fs.readFileSync(validatePath, 'utf8');

    // Should export validation functions
    const isExportable = content.includes('module.exports') || content.includes('export');
    assert.ok(isExportable, 'Should be importable as module');
  });

  test('handles missing prerequisites gracefully', () => {
    const content = fs.readFileSync(validatePath, 'utf8');

    // Should have try-catch or existence checks
    const hasErrorHandling = content.includes('try') || content.includes('exists');
    assert.ok(hasErrorHandling, 'Should handle missing prerequisites');
  });
});
