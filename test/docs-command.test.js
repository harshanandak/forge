const { describe, test, expect } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getTopicContent, validateDocs, formatDocsValidation } = require('../lib/docs-command');

describe('docs command file reads', () => {
  test('surfaces non-missing file read errors', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-cmd-test-'));
    try {
      const toolchainPath = path.join(tmpDir, 'docs', 'reference', 'TOOLCHAIN.md');
      fs.mkdirSync(toolchainPath, { recursive: true });

      const result = getTopicContent('toolchain', tmpDir);
      expect(result.error).toContain('Failed to read documentation file');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('docs validation', () => {
  test('reports broken local markdown links', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-validate-test-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '[Missing](docs/missing.md)\n', 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'lib', 'ok.js'), '/** Does work. */\nfunction ok() {}\n', 'utf8');

      const result = validateDocs(tmpDir);

      expect(result.ok).toBe(false);
      expect(result.links.brokenLinks).toHaveLength(1);
      expect(result.links.brokenLinks[0].target).toBe('docs/missing.md');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('reports docstring coverage for public JavaScript functions', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-coverage-test-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test\n', 'utf8');
      fs.writeFileSync(
        path.join(tmpDir, 'lib', 'coverage.js'),
        '/** Documented. */\nfunction documented() {}\nfunction missing() {}\n',
        'utf8'
      );

      const result = validateDocs(tmpDir, { minDocstringCoverage: 100 });

      expect(result.ok).toBe(false);
      expect(result.docstrings.total).toBe(2);
      expect(result.docstrings.documented).toBe(1);
      expect(result.docstrings.missing[0].name).toBe('missing');
      expect(formatDocsValidation(result)).toContain('Docstring coverage: 1/2 (50%)');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
