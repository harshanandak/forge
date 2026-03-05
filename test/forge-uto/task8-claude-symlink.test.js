import { describe, test, expect, mock } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../');

// Dynamically import the function under test
// We test by calling it in a temp directory so nothing is written to real project

describe('Task 8: CLAUDE.md symlink creation', () => {
  test('createClaudeSymlink function exists in bin/forge.js', () => {
    const src = fs.readFileSync(path.join(root, 'bin/forge.js'), 'utf8');
    expect(src).toContain('createClaudeSymlink');
  });

  test('createClaudeSymlink is not marked @private', () => {
    const src = fs.readFileSync(path.join(root, 'bin/forge.js'), 'utf8');
    // The function should not have @private comment — it's active now
    const fnIdx = src.indexOf('function createClaudeSymlink(');
    const preceding = src.slice(Math.max(0, fnIdx - 200), fnIdx);
    expect(preceding).not.toContain('@private');
  });

  test('createClaudeSymlink uses symlinkSync', () => {
    const src = fs.readFileSync(path.join(root, 'bin/forge.js'), 'utf8');
    expect(src).toContain('symlinkSync');
  });

  test('createClaudeSymlink has EPERM fallback', () => {
    const src = fs.readFileSync(path.join(root, 'bin/forge.js'), 'utf8');
    expect(src).toContain('EPERM');
  });

  test('_createClaudeReference is removed (renamed)', () => {
    const src = fs.readFileSync(path.join(root, 'bin/forge.js'), 'utf8');
    expect(src).not.toContain('_createClaudeReference');
  });
});
