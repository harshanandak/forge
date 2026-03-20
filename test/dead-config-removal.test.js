const { describe, test, expect } = require('bun:test');
const { readFileSync } = require('fs');
const path = require('path');

describe('dead config removal (forge-8u6q)', () => {
  const forgeSrc = readFileSync(
    path.join(__dirname, '..', 'bin', 'forge.js'),
    'utf-8'
  );

  test('bin/forge.js must not contain _CODE_REVIEW_TOOLS', () => {
    expect(forgeSrc).not.toContain('_CODE_REVIEW_TOOLS');
  });

  test('bin/forge.js must not contain _CODE_QUALITY_TOOLS', () => {
    expect(forgeSrc).not.toContain('_CODE_QUALITY_TOOLS');
  });
});
