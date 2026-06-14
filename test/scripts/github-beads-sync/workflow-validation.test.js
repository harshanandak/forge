import { describe, it, expect } from 'bun:test';
import { existsSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();

describe('deprecated GitHub-Beads workflow templates', () => {
  it('does not keep an active GitHub to Beads workflow in the repository', () => {
    expect(existsSync(join(ROOT, '.github/workflows/github-to-beads.yml'))).toBe(false);
  });

  it('does not keep an active Beads to GitHub workflow in the repository', () => {
    expect(existsSync(join(ROOT, '.github/workflows/beads-to-github.yml'))).toBe(false);
  });
});
