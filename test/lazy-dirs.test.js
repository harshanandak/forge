const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { describe, test, expect, beforeEach, afterEach } = require('bun:test');

describe('Lazy directory creation', () => {
  // setupCoreDocs was extracted from bin/forge.js to lib/commands/setup.js
  const setupPath = path.join(__dirname, '..', 'lib', 'commands', 'setup.js');
  const content = fs.readFileSync(setupPath, 'utf-8');

  // -----------------------------------------------------------
  // Structural tests: setupCoreDocs must NOT eagerly create dirs
  // -----------------------------------------------------------
  describe('setupCoreDocs removes eager ensureDir calls', () => {
    // Extract setupCoreDocs function body
    const funcStart = content.indexOf('function setupCoreDocs()');
    const funcBody = funcStart > -1
      ? content.substring(funcStart, content.indexOf('\n}', funcStart) + 2)
      : '';

    test('setupCoreDocs exists', () => {
      expect(funcStart).toBeGreaterThan(-1);
    });

    test('does NOT call ensureDir("docs/planning")', () => {
      expect(funcBody).not.toContain("ensureDir('docs/planning')");
      expect(funcBody).not.toContain('ensureDir("docs/planning")');
    });

    test('does NOT call ensureDir("docs/research")', () => {
      expect(funcBody).not.toContain("ensureDir('docs/research')");
      expect(funcBody).not.toContain('ensureDir("docs/research")');
    });
  });

  // -----------------------------------------------------------
  // ensureDirWithNote helper tests
  // -----------------------------------------------------------
  describe('ensureDirWithNote helper', () => {
    test('ensureDirWithNote function exists in lib/file-utils.js', () => {
      const fileUtilsContent = fs.readFileSync(
        path.join(__dirname, '..', 'lib', 'file-utils.js'), 'utf-8'
      );
      expect(fileUtilsContent).toContain('function ensureDirWithNote(');
    });

    test('ensureDirWithNote is re-exported from bin/forge.js', () => {
      const forgeContent = fs.readFileSync(
        path.join(__dirname, '..', 'bin', 'forge.js'), 'utf-8'
      );
      expect(forgeContent).toMatch(/module\.exports\s*=\s*\{[^}]*ensureDirWithNote/);
    });
  });

  // -----------------------------------------------------------
  // Behavioral tests: ensureDirWithNote creates dir and returns
  // -----------------------------------------------------------
  describe('ensureDirWithNote behavior', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-lazy-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('creates directory and returns purpose message on first call', () => {
      const { ensureDirWithNote } = require('../bin/forge.js');
      const targetDir = path.join(tmpDir, 'docs', 'planning');
      const result = ensureDirWithNote(targetDir, 'design documents');

      expect(fs.existsSync(targetDir)).toBe(true);
      // Message contains forward-slashed path and purpose
      expect(result).toContain('docs/planning');
      expect(result).toContain('for design documents');
      expect(result).toMatch(/^Created .+docs\/planning for design documents$/);
    });

    test('returns null when directory already exists', () => {
      const { ensureDirWithNote } = require('../bin/forge.js');
      const targetDir = path.join(tmpDir, 'docs', 'research');

      // First call creates it
      ensureDirWithNote(targetDir, 'research notes');

      // Second call should return null
      const result = ensureDirWithNote(targetDir, 'research notes');
      expect(result).toBeNull();
    });
  });
});
