import { describe, test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../');

const src = fs.readFileSync(path.join(root, 'bin/forge.js'), 'utf8');

describe('Task 4: OpenSpec removal from bin/forge.js', () => {
  test('promptOpenSpecSetup is removed', () => {
    expect(src).not.toContain('promptOpenSpecSetup');
  });

  test('checkForOpenSpec is removed', () => {
    expect(src).not.toContain('checkForOpenSpec');
  });

  test('initializeOpenSpec is removed', () => {
    expect(src).not.toContain('initializeOpenSpec');
  });

  test('isOpenSpecInitialized is removed', () => {
    expect(src).not.toContain('isOpenSpecInitialized');
  });

  test('openspecInstallType is removed from status object', () => {
    expect(src).not.toContain('openspecInstallType');
  });

  test('hasOpenSpec is removed from status object', () => {
    expect(src).not.toContain('hasOpenSpec');
  });
});
