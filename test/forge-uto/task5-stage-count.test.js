import { describe, test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../');

describe('Task 5: Stage count update', () => {
  test('bin/forge.js does not contain "9-stage"', () => {
    const src = fs.readFileSync(path.join(root, 'bin/forge.js'), 'utf8');
    expect(src).not.toContain('9-stage');
  });

  test('bin/forge.js contains "7-stage"', () => {
    const src = fs.readFileSync(path.join(root, 'bin/forge.js'), 'utf8');
    expect(src).toContain('7-stage');
  });
});
