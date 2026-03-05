import { describe, test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../');

describe('Task 2: Windsurf removal', () => {
  test('lib/agents/windsurf.plugin.json does not exist', () => {
    expect(fs.existsSync(path.join(root, 'lib/agents/windsurf.plugin.json'))).toBe(false);
  });

  test('.windsurfrules does not exist', () => {
    expect(fs.existsSync(path.join(root, '.windsurfrules'))).toBe(false);
  });

  test('.windsurf/ directory does not exist', () => {
    expect(fs.existsSync(path.join(root, '.windsurf'))).toBe(false);
  });
});
