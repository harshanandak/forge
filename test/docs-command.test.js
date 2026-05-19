const { describe, test, expect } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');
const { getTopicContent, validateDocs, formatDocsValidation } = require('../lib/docs-command');

const forgePath = path.resolve(__dirname, '..', 'bin', 'forge.js');

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

  test('reports broken reference-style markdown links', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-reference-link-test-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '[Guide][guide]\n\n[guide]: docs/missing.md\n', 'utf8');

      const result = validateDocs(tmpDir);

      expect(result.ok).toBe(false);
      expect(result.links.linksChecked).toBe(1);
      expect(result.links.brokenLinks[0].target).toBe('docs/missing.md');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('resolves markdown links with balanced parentheses in destinations', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-parentheses-link-test-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '[Guide](docs/guide(v1).md)\n', 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'docs', 'guide(v1).md'), '# Guide\n', 'utf8');

      const result = validateDocs(tmpDir);

      expect(result.links.brokenLinks).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('rejects local links that escape to a sibling with the same root prefix', () => {
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-prefix-test-'));
    const projectDir = path.join(parentDir, 'project');
    const siblingDir = path.join(parentDir, 'project-old');
    try {
      fs.mkdirSync(path.join(projectDir, 'docs'), { recursive: true });
      fs.mkdirSync(path.join(siblingDir, 'docs'), { recursive: true });
      fs.mkdirSync(path.join(projectDir, 'lib'), { recursive: true });
      fs.mkdirSync(path.join(projectDir, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(projectDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'README.md'), '[Escaped](../project-old/docs/foo.md)\n', 'utf8');
      fs.writeFileSync(path.join(siblingDir, 'docs', 'foo.md'), '# Sibling\n', 'utf8');

      const result = validateDocs(projectDir);

      expect(result.ok).toBe(false);
      expect(result.links.brokenLinks[0].reason).toBe('Link escapes project root');
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true });
    }
  });

  test('ignores protocol-relative external links', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-protocol-relative-test-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '[CDN](//cdn.example.com/app.js)\n', 'utf8');

      const result = validateDocs(tmpDir);

      expect(result.links.brokenLinks).toHaveLength(0);
      expect(result.links.linksChecked).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('ignores markdown links inside fenced code blocks', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-fence-test-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'README.md'),
        '# Test\n\n```md\n[View in Beads](bd show forge-abc)\n```\n',
        'utf8'
      );

      const result = validateDocs(tmpDir);

      expect(result.links.brokenLinks).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('ignores headings inside fenced code blocks when checking anchors', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-anchor-fence-test-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '[Fenced](docs/guide.md#fake-heading)\n', 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'docs', 'guide.md'), '```md\n# Fake Heading\n```\n', 'utf8');

      const result = validateDocs(tmpDir);

      expect(result.links.brokenLinks).toHaveLength(1);
      expect(result.links.brokenLinks[0].reason).toBe('Target anchor does not exist');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('removes local absolute path prefixes from reported broken targets', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-absolute-target-test-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'README.md'),
        '[Worktree](C:/Users/example/Downloads/forge/.worktrees/demo/bin/forge.js)\n',
        'utf8'
      );

      const result = validateDocs(tmpDir);

      expect(result.links.brokenLinks[0].target).toBe('<repo>/.worktrees/demo/bin/forge.js');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('resolves leading-slash markdown links from the project root', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-root-link-test-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '[Guide](/docs/guide.md)\n', 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'docs', 'guide.md'), '# Guide\n', 'utf8');

      const result = validateDocs(tmpDir);

      expect(result.links.brokenLinks).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('normalizes anchor targets with the same slug rules as headings', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-anchor-slug-test-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '[Release](docs/releases.md#v0.0.19)\n', 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'docs', 'releases.md'), '# v0.0.19\n', 'utf8');

      const result = validateDocs(tmpDir);

      expect(result.links.brokenLinks).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('accepts duplicate heading suffix anchors', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-anchor-duplicate-test-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '[Second](docs/releases.md#section-1)\n', 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'docs', 'releases.md'), '# Section\n\n# Section\n', 'utf8');

      const result = validateDocs(tmpDir);

      expect(result.links.brokenLinks).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('collects setext heading anchors', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-anchor-setext-test-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '[Intro](docs/guide.md#intro)\n', 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'docs', 'guide.md'), 'Intro\n=====\n', 'utf8');

      const result = validateDocs(tmpDir);

      expect(result.links.brokenLinks).toHaveLength(0);
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

  test('checks docstring coverage in common src roots', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-coverage-src-test-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test\n', 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'src', 'feature.js'), 'function missingFromSrc() {}\n', 'utf8');

      const result = validateDocs(tmpDir, { minDocstringCoverage: 100 });

      expect(result.ok).toBe(false);
      expect(result.docstrings.filesChecked).toBe(1);
      expect(result.docstrings.missing[0].file).toBe('src/feature.js');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('checks docstring coverage for TypeScript sources', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-coverage-ts-test-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test\n', 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'src', 'feature.ts'), 'export function missingTs(value: string) { return value; }\n', 'utf8');

      const result = validateDocs(tmpDir, { minDocstringCoverage: 100 });

      expect(result.ok).toBe(false);
      expect(result.docstrings.filesChecked).toBe(1);
      expect(result.docstrings.missing[0].file).toBe('src/feature.ts');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('checks docstring coverage for CommonJS export assignments', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-coverage-cjs-test-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test\n', 'utf8');
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'exports.js'),
        'exports.missing = function () {};\nmodule.exports.alsoMissing = () => {};\n',
        'utf8'
      );

      const result = validateDocs(tmpDir, { minDocstringCoverage: 100 });

      expect(result.ok).toBe(false);
      expect(result.docstrings.total).toBe(2);
      expect(result.docstrings.missing.map((item) => item.name)).toEqual(['missing', 'alsoMissing']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('checks docstring coverage for direct CommonJS function exports', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-coverage-cjs-direct-test-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test\n', 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'src', 'index.js'), 'module.exports = function () {};\n', 'utf8');

      const result = validateDocs(tmpDir, { minDocstringCoverage: 100 });

      expect(result.ok).toBe(false);
      expect(result.docstrings.total).toBe(1);
      expect(result.docstrings.missing[0].name).toBe('module.exports');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('parses ES module sources when checking docstring coverage', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-esm-test-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test\n', 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'lib', 'esm.js'), 'export function missing() {}\n', 'utf8');

      const result = validateDocs(tmpDir, { minDocstringCoverage: 100 });

      expect(result.ok).toBe(false);
      expect(result.docstrings.total).toBe(1);
      expect(result.docstrings.missing[0].name).toBe('missing');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('treats JavaScript parse errors as failed docstring coverage', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-parse-error-test-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test\n', 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'lib', 'broken.js'), 'function broken( {\n', 'utf8');

      const result = validateDocs(tmpDir, { minDocstringCoverage: 100 });

      expect(result.ok).toBe(false);
      expect(result.docstrings.total).toBe(1);
      expect(result.docstrings.missing[0].name).toBe('<parse-error>');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('reports malformed docs baseline JSON with the baseline path', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-bad-baseline-test-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test\n', 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'bad-baseline.json'), '{ nope', 'utf8');

      expect(() => validateDocs(tmpDir, { baselinePath: 'bad-baseline.json' }))
        .toThrow(/Invalid docs baseline JSON/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('keeps baseline entries scoped to the broken link line', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-baseline-line-test-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'README.md'),
        '[Missing](docs/missing.md)\n\n[Missing again](docs/missing.md)\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(tmpDir, 'baseline.json'),
        JSON.stringify({
          brokenLinks: [
            {
              file: 'README.md',
              line: 1,
              target: 'docs/missing.md',
              reason: 'Target file does not exist',
            },
          ],
        }),
        'utf8'
      );

      const result = validateDocs(tmpDir, { baselinePath: 'baseline.json' });

      expect(result.links.knownBrokenLinks).toBe(1);
      expect(result.links.brokenLinks).toHaveLength(1);
      expect(result.links.brokenLinks[0].line).toBe(3);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('CLI rejects invalid docstring coverage thresholds', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-cli-threshold-test-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test\n', 'utf8');

      const result = spawnSync(process.execPath, [
        forgePath,
        'docs',
        'verify',
        '--path',
        tmpDir,
        '--min-docstring-coverage',
        'nope',
      ], { encoding: 'utf8' });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--min-docstring-coverage must be a number between 0 and 100');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('CLI docs verify rejects missing --path targets', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-cli-missing-path-parent-'));
    const missingDir = path.join(tmpDir, 'missing');
    try {
      const result = spawnSync(process.execPath, [
        forgePath,
        'docs',
        'verify',
        '--path',
        missingDir,
      ], { encoding: 'utf8' });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('does not exist');
      expect(fs.existsSync(missingDir)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('CLI docs detect validates the --path project instead of Forge package docs', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-cli-path-test-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '[Missing](docs/missing.md)\n', 'utf8');
      const result = spawnSync(process.execPath, [
        forgePath,
        'docs',
        'detect',
        '--path',
        tmpDir,
      ], { encoding: 'utf8' });

      const output = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));

      expect(result.status).toBe(1);
      expect(output.ok).toBe(false);
      expect(output.links.brokenLinks[0].file).toBe('README.md');
      expect(output.links.brokenLinks[0].target).toBe('docs/missing.md');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
