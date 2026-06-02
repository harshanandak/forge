const { describe, it, expect } = require('bun:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');

function readDoc(relPath) {
  return readFileSync(join(ROOT, relPath), 'utf8');
}

describe('Forge Kernel schema release docs', () => {
  it('links the schema reference from the documentation index', () => {
    const index = readDoc('docs/INDEX.md');

    expect(index).toContain('reference/forge-kernel-schema.md');
    expect(index).toContain('Forge Kernel schema and migrations');
  });

  it('documents the schema, migration, and storage-class contract', () => {
    const doc = readDoc('docs/reference/forge-kernel-schema.md');

    expect(doc).toContain('lib/kernel/schema.js');
    expect(doc).toContain('lib/kernel/migrations.js');
    expect(doc).toContain('FORGE_KERNEL_STORAGE_MODEL.md');
    expect(doc).toContain('Schema registry contract');
    expect(doc).toContain('Migration contract');
    expect(doc).toContain('Storage-class contract');
    expect(doc).toContain('expected_revision');
  });

  it('keeps broker, import, and conflict handling marked as follow-up work', () => {
    const doc = readDoc('docs/reference/forge-kernel-schema.md');

    expect(doc).toContain('Follow-up PRs');
    expect(doc).toContain('broker');
    expect(doc).toContain('import');
    expect(doc).toContain('conflict');
  });
});
