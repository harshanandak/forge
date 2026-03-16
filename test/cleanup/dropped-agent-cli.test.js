const { describe, test, expect } = require('bun:test');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Verify that dropped-agent code has been removed from CLI and lib modules.
 *
 * Forbidden patterns (case-insensitive where noted):
 *  - 'aider' (case-insensitive) in lib/project-discovery.js
 *  - 'continueFormat', 'continueConfig', 'generateContinueConfig', '.continue/' in bin/forge.js
 *  - 'OpenSpec' in bin/forge-cmd.js
 *
 * The JavaScript `continue;` keyword (loop control) must NOT be flagged.
 */
describe('dropped-agent code removed from CLI and lib', () => {
  const forgeJs = fs.readFileSync(path.join(ROOT, 'bin/forge.js'), 'utf8');
  const forgeCmdJs = fs.readFileSync(path.join(ROOT, 'bin/forge-cmd.js'), 'utf8');
  const projectDiscovery = fs.readFileSync(path.join(ROOT, 'lib/project-discovery.js'), 'utf8');

  // --- bin/forge.js ---

  test('bin/forge.js must not contain "continueFormat"', () => {
    expect(forgeJs).not.toContain('continueFormat');
  });

  test('bin/forge.js must not contain "continueConfig"', () => {
    expect(forgeJs).not.toContain('continueConfig');
  });

  test('bin/forge.js must not contain "generateContinueConfig"', () => {
    expect(forgeJs).not.toContain('generateContinueConfig');
  });

  test('bin/forge.js must not contain ".continue/"', () => {
    expect(forgeJs).not.toContain('.continue/');
  });

  test('bin/forge.js must not reference Continue AI agent setup', () => {
    // Match agent-specific patterns: .continue/, continueFormat, continueConfig, generateContinue
    expect(forgeJs).not.toMatch(/\.continue\//);
    expect(forgeJs).not.toMatch(/continueFormat/);
    expect(forgeJs).not.toMatch(/continueConfig/);
    expect(forgeJs).not.toMatch(/generateContinue/);
  });

  // --- bin/forge-cmd.js ---

  test('bin/forge-cmd.js must not contain "OpenSpec"', () => {
    expect(forgeCmdJs).not.toContain('OpenSpec');
  });

  // --- lib/project-discovery.js ---

  test('lib/project-discovery.js must not contain "aider" (case-insensitive)', () => {
    expect(projectDiscovery).not.toMatch(/aider/i);
  });
});
