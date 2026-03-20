const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');

const ROOT = path.join(__dirname, '..', '..');

describe('forge-validate renamed to forge-preflight', () => {
  describe('binary file', () => {
    test('bin/forge-preflight.js exists', () => {
      expect(fs.existsSync(path.join(ROOT, 'bin', 'forge-preflight.js'))).toBe(true);
    });

    test('bin/forge-validate.js does NOT exist', () => {
      expect(fs.existsSync(path.join(ROOT, 'bin', 'forge-validate.js'))).toBe(false);
    });
  });

  describe('package.json bin entry', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

    test('has forge-preflight in bin field', () => {
      expect(pkg.bin['forge-preflight']).toBeDefined();
    });

    test('does NOT have forge-validate in bin field', () => {
      expect(pkg.bin['forge-validate']).toBeUndefined();
    });
  });

  describe('documentation references', () => {
    test('README.md contains forge-preflight (not forge-validate) in usage examples', () => {
      const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
      expect(readme).toContain('forge-preflight');
      expect(readme).not.toContain('forge-validate');
    });

    test('CHANGELOG.md contains forge-preflight (not forge-validate)', () => {
      const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
      expect(changelog).toContain('forge-preflight');
      expect(changelog).not.toContain('forge-validate');
    });

    test('DEVELOPMENT.md contains forge-preflight (not forge-validate)', () => {
      const devmd = fs.readFileSync(path.join(ROOT, 'DEVELOPMENT.md'), 'utf8');
      expect(devmd).toContain('forge-preflight');
      expect(devmd).not.toContain('forge-validate');
    });
  });
});
