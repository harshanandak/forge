import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('dead config removal (forge-8u6q)', () => {
  const forgeSrc = readFileSync(
    join(import.meta.dirname, '..', 'bin', 'forge.js'),
    'utf-8'
  );

  test('bin/forge.js must not contain _CODE_REVIEW_TOOLS', () => {
    expect(forgeSrc).not.toContain('_CODE_REVIEW_TOOLS');
  });

  test('bin/forge.js must not contain _CODE_QUALITY_TOOLS', () => {
    expect(forgeSrc).not.toContain('_CODE_QUALITY_TOOLS');
  });
});
