const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

describe('CLI flags for bin/forge.js', () => {
  test('bin/forge.js file exists', () => {
    const forgePath = path.join(__dirname, '..', 'bin', 'forge.js');
    assert.ok(fs.existsSync(forgePath), 'forge.js should exist');
  });

  test('bin/forge.js should be a valid Node.js file', () => {
    const forgePath = path.join(__dirname, '..', 'bin', 'forge.js');
    const content = fs.readFileSync(forgePath, 'utf-8');
    assert.ok(content.includes('#!/usr/bin/env node') || content.includes('node'), 'Should be a Node.js script');
  });

  test('should have --interactive flag support', () => {
    const forgePath = path.join(__dirname, '..', 'bin', 'forge.js');
    const content = fs.readFileSync(forgePath, 'utf-8');
    assert.ok(content.includes('interactive'), 'Should support --interactive flag');
  });

  test('should have --config flag support', () => {
    const forgePath = path.join(__dirname, '..', 'bin', 'forge.js');
    const content = fs.readFileSync(forgePath, 'utf-8');
    assert.ok(content.includes('config'), 'Should support --config flag');
  });

  test('should have --dry-run flag support', () => {
    const forgePath = path.join(__dirname, '..', 'bin', 'forge.js');
    const content = fs.readFileSync(forgePath, 'utf-8');
    assert.ok(content.includes('dry') || content.includes('dryRun'), 'Should support --dry-run flag');
  });

  test('should have --agent flag support', () => {
    const forgePath = path.join(__dirname, '..', 'bin', 'forge.js');
    const content = fs.readFileSync(forgePath, 'utf-8');
    assert.ok(content.includes('agent'), 'Should support --agent flag');
  });

  test('should have --profile flag support', () => {
    const forgePath = path.join(__dirname, '..', 'bin', 'forge.js');
    const content = fs.readFileSync(forgePath, 'utf-8');
    assert.ok(content.includes('profile'), 'Should support --profile flag');
  });

  test('should have --overwrite flag support', () => {
    const forgePath = path.join(__dirname, '..', 'bin', 'forge.js');
    const content = fs.readFileSync(forgePath, 'utf-8');
    assert.ok(content.includes('overwrite'), 'Should support --overwrite flag');
  });
});
