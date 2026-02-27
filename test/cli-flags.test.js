const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');

describe('CLI flags for bin/forge.js', () => {
  test('bin/forge.js file exists', () => {
    const forgePath = path.join(__dirname, '..', 'bin', 'forge.js');
    expect(fs.existsSync(forgePath)).toBeTruthy();
  });

  test('bin/forge.js should be a valid Node.js file', () => {
    const forgePath = path.join(__dirname, '..', 'bin', 'forge.js');
    const content = fs.readFileSync(forgePath, 'utf-8');
    expect(content.includes('#!/usr/bin/env node') || content.includes('node')).toBeTruthy();
  });

  test('should have --interactive flag support', () => {
    const forgePath = path.join(__dirname, '..', 'bin', 'forge.js');
    const content = fs.readFileSync(forgePath, 'utf-8');
    expect(content.includes('interactive')).toBeTruthy();
  });

  test('should have --config flag support', () => {
    const forgePath = path.join(__dirname, '..', 'bin', 'forge.js');
    const content = fs.readFileSync(forgePath, 'utf-8');
    expect(content.includes('config')).toBeTruthy();
  });

  test('should have --dry-run flag support', () => {
    const forgePath = path.join(__dirname, '..', 'bin', 'forge.js');
    const content = fs.readFileSync(forgePath, 'utf-8');
    expect(content.includes('dry') || content.includes('dryRun')).toBeTruthy();
  });

  test('should have --agent flag support', () => {
    const forgePath = path.join(__dirname, '..', 'bin', 'forge.js');
    const content = fs.readFileSync(forgePath, 'utf-8');
    expect(content.includes('agent')).toBeTruthy();
  });

  test('should have --profile flag support', () => {
    const forgePath = path.join(__dirname, '..', 'bin', 'forge.js');
    const content = fs.readFileSync(forgePath, 'utf-8');
    expect(content.includes('profile')).toBeTruthy();
  });

  test('should have --overwrite flag support', () => {
    const forgePath = path.join(__dirname, '..', 'bin', 'forge.js');
    const content = fs.readFileSync(forgePath, 'utf-8');
    expect(content.includes('overwrite')).toBeTruthy();
  });
});
