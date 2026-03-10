import { describe, test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../');

describe('Task 3: Aider removal', () => {
  test('lib/agents/aider.plugin.json does not exist', () => {
    expect(fs.existsSync(path.join(root, 'lib/agents/aider.plugin.json'))).toBe(false);
  });

  test('bin/forge.js does not contain setupAiderAgent', () => {
    const source = fs.readFileSync(path.join(root, 'bin/forge.js'), 'utf-8');
    expect(source.includes('setupAiderAgent')).toBe(false);
  });

  test('bin/forge.js does not contain .aider.conf.yml in non-comment code', () => {
    const source = fs.readFileSync(path.join(root, 'bin/forge.js'), 'utf-8');
    // Filter out comment lines and check remaining code
    const codeLines = source.split('\n').filter(line => !line.trim().startsWith('//'));
    const codeOnly = codeLines.join('\n');
    expect(codeOnly.includes('aider.conf.yml')).toBe(false);
  });
});
