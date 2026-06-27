const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listFilesRecursive } = require('../../lib/skills-sync');

let tmp;

function write(rel, content) {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-sync-list-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('skills-sync: listFilesRecursive', () => {
  test('returns relative paths sorted deterministically with forward slashes', () => {
    // Write files in non-sorted creation order, including nested dirs, so the
    // result order can only come from an explicit comparator (not insertion).
    write('zeta.md', 'z');
    write('nested/beta.md', 'b');
    write('alpha.md', 'a');
    write('nested/alpha.md', 'na');

    const files = listFilesRecursive(tmp);

    expect(files).toEqual([
      'alpha.md',
      'nested/alpha.md',
      'nested/beta.md',
      'zeta.md',
    ]);
    // Contract: deterministic ascending order regardless of fs read order.
    expect(files).toEqual([...files].sort((a, b) => a.localeCompare(b)));
  });

  test('returns an empty array for a missing directory', () => {
    expect(listFilesRecursive(path.join(tmp, 'does-not-exist'))).toEqual([]);
  });
});
