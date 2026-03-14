import { describe, test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../');

function readIfExists(filePath) {
  const full = path.join(root, filePath);
  if (!fs.existsSync(full)) return '';
  // Handle .clinerules being a directory (migrated from flat file)
  if (fs.statSync(full).isDirectory()) {
    const defaultRules = path.join(full, 'default-rules.md');
    return fs.existsSync(defaultRules) ? fs.readFileSync(defaultRules, 'utf8') : '';
  }
  return fs.readFileSync(full, 'utf8');
}

describe('Task 9: Doc cleanup — dropped agents removed', () => {
  test('.clinerules has no Antigravity references', () => {
    const src = readIfExists('.clinerules');
    expect(src).not.toContain('Antigravity');
    expect(src).not.toContain('GEMINI.md');
    expect(src).not.toContain('.agent/');
  });

  test('.clinerules has no Windsurf references', () => {
    const src = readIfExists('.clinerules');
    expect(src).not.toContain('Windsurf');
    expect(src).not.toContain('.windsurf/');
    expect(src).not.toContain('.windsurfrules');
  });

  test('.clinerules has no Aider references', () => {
    const src = readIfExists('.clinerules');
    expect(src).not.toContain('Aider');
    expect(src).not.toContain('aider');
  });

  test('.windsurfrules does not exist', () => {
    expect(fs.existsSync(path.join(root, '.windsurfrules'))).toBe(false);
  });

  test('docs/SETUP.md has no Antigravity section', () => {
    const src = readIfExists('docs/SETUP.md');
    expect(src).not.toContain('Google Antigravity');
    expect(src).not.toContain('GEMINI.md');
  });

  test('docs/SETUP.md has no Windsurf section', () => {
    const src = readIfExists('docs/SETUP.md');
    expect(src).not.toContain('### Windsurf');
    expect(src).not.toContain('.windsurfrules');
  });
});
