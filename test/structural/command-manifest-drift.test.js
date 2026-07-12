/**
 * Drift guard for the static command manifest.
 *
 * `lib/commands/_manifest.js` is a GENERATED file that statically `require`s
 * every command module so `bun build --compile` can bundle the command graph.
 * It must stay in lockstep with the actual command files in `lib/commands/`:
 * every non-underscore `.js` command file must appear in the manifest, and the
 * manifest must not list files that no longer exist.
 *
 * Regenerate with: node scripts/gen-command-manifest.js
 *
 * This mirrors the registry-drift guards — it fails loudly when a command file
 * is added/removed without regenerating the manifest.
 */

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const {
  listCommandFiles,
  renderManifest,
  MANIFEST_PATH,
  COMMANDS_DIR,
} = require('../../scripts/gen-command-manifest');

const manifest = require('../../lib/commands/_manifest');

describe('static command manifest drift', () => {
  test('_manifest.js exists', () => {
    expect(fs.existsSync(MANIFEST_PATH)).toBe(true);
  });

  test('manifest exposes { dir, commands } shape', () => {
    expect(manifest).toBeTruthy();
    expect(typeof manifest.dir).toBe('string');
    expect(Array.isArray(manifest.commands)).toBe(true);
    expect(path.resolve(manifest.dir)).toBe(path.resolve(COMMANDS_DIR));
  });

  test('every command file on disk is listed in the manifest', () => {
    const onDisk = new Set(listCommandFiles());
    const inManifest = new Set(manifest.commands.map(e => e.file));

    const missing = [...onDisk].filter(f => !inManifest.has(f));
    expect(missing).toEqual([]);
  });

  test('manifest lists no files that are missing from disk', () => {
    const onDisk = new Set(listCommandFiles());
    const stale = manifest.commands.map(e => e.file).filter(f => !onDisk.has(f));
    expect(stale).toEqual([]);
  });

  test('every manifest entry resolves to a valid command module', () => {
    for (const entry of manifest.commands) {
      expect(typeof entry.file).toBe('string');
      expect(entry.module).toBeTruthy();
      expect(typeof entry.module.name).toBe('string');
      expect(typeof entry.module.handler).toBe('function');
    }
  });

  test('committed manifest is byte-identical to a fresh generation (no drift)', () => {
    const expected = renderManifest(listCommandFiles());
    const actual = fs.readFileSync(MANIFEST_PATH, 'utf8');
    expect(actual).toBe(expected);
  });
});
