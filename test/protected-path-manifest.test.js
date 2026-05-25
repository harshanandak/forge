const { describe, expect, test } = require('bun:test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const {
  PROTECTED_PATH_CATEGORY_IDS,
  buildProtectedPathManifestEvidence,
  getDefaultProtectedPathManifest,
  getProtectedPathHarnessEnforcement,
  loadProtectedPathManifest,
  validateProtectedPathManifest,
} = require('../lib/protected-path-manifest');

const ROOT = path.resolve(__dirname, '..');

describe('protected path manifest contract', () => {
  test('defines the seven W1 protected path categories', () => {
    const manifest = getDefaultProtectedPathManifest();

    expect(manifest.kind).toBe('ProtectedPathManifest');
    expect(manifest.categories.map(category => category.id)).toEqual(PROTECTED_PATH_CATEGORY_IDS);
    expect(manifest.categories.find(category => category.id === 'forge_core').mode).toBe('checksum-verified');
    expect(manifest.categories.find(category => category.id === 'beads_state').mode).toBe('bd-cli-only');
  });

  test('validates the default manifest and rejects missing categories', () => {
    const manifest = getDefaultProtectedPathManifest();
    const valid = validateProtectedPathManifest(manifest);

    expect(valid.ok).toBe(true);
    expect(valid.errors).toEqual([]);

    const invalid = validateProtectedPathManifest({
      ...manifest,
      categories: manifest.categories.filter(category => category.id !== 'immutable'),
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.errors.join('\n')).toContain('immutable');
  });

  test('accepts the legacy forge init protected paths scaffold identity', () => {
    const legacy = validateProtectedPathManifest({
      kind: 'forge.protectedPaths',
      version: 1,
      classification: 'standard',
      harness: { targets: ['codex'] },
      paths: [{ path: '.forge/config.yaml', reason: 'Forge runtime configuration' }],
    });

    expect(legacy.ok).toBe(true);
    expect(legacy.errors).toEqual([]);
  });

  test('rejects categories that use the wrong protected-path mode', () => {
    const manifest = getDefaultProtectedPathManifest();
    const invalid = validateProtectedPathManifest({
      ...manifest,
      categories: manifest.categories.map(category =>
        category.id === 'secrets'
          ? { ...category, mode: 'tool-owned' }
          : category,
      ),
    });

    expect(invalid.ok).toBe(false);
    expect(invalid.errors.join('\n')).toContain('Category secrets must use mode secret-scan-blocked.');
  });

  test('loads the repository default YAML manifest', () => {
    const loaded = loadProtectedPathManifest(path.join(ROOT, '.forge', 'protected-paths.yaml'));

    expect(loaded.kind).toBe('ProtectedPathManifest');
    expect(validateProtectedPathManifest(loaded).ok).toBe(true);
  });

  test('documents harness enforcement without pretending Cursor hooks are proven', () => {
    const enforcement = getProtectedPathHarnessEnforcement();

    expect(enforcement.claude.surface).toContain('PreToolUse');
    expect(enforcement.codex.surface).toContain('hook');
    expect(enforcement.cursor.status).toBe('fallback');
    expect(enforcement.cursor.knownIssue).toContain('No verified Cursor hook surface');
  });

  test('prints machine-readable manifest evidence', () => {
    const output = execFileSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'spikes', 'protected-path-manifest.js')],
      { cwd: ROOT, encoding: 'utf8' },
    );
    const parsed = JSON.parse(output);

    expect(parsed.kind).toBe('forge.protectedPathManifest');
    expect(parsed.validation.ok).toBe(true);
    expect(parsed.harnessEnforcement.cursor.status).toBe('fallback');
  });
});

describe('protected path manifest docs', () => {
  test('links the reference docs and evidence command', () => {
    const evidence = buildProtectedPathManifestEvidence();
    const docsIndex = require('node:fs').readFileSync(path.join(ROOT, 'docs', 'INDEX.md'), 'utf8');
    const docs = require('node:fs').readFileSync(path.join(ROOT, 'docs', 'reference', 'PROTECTED_PATH_MANIFEST.md'), 'utf8');

    expect(evidence.manifestPath).toBe('.forge/protected-paths.yaml');
    expect(docsIndex).toContain('PROTECTED_PATH_MANIFEST.md');
    expect(docs).toContain('node scripts/spikes/protected-path-manifest.js');
    expect(docs).toContain('Cursor fallback');
  });
});
