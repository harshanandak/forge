#!/usr/bin/env node
'use strict';

/**
 * Generate the static command manifest — scripts/gen-command-manifest.js
 *
 * Static bundlers (`bun build --compile`) need a static require graph, but the
 * command registry discovers commands at runtime via `fs.readdirSync` +
 * `require(filePath)`. This generator walks `lib/commands/*.js` and emits
 * `lib/commands/_manifest.js`, a checked-in module that `require`s every command
 * module by a *static* relative path. The registry loads the manifest as its
 * fast, bundleable path and keeps readdir auto-discovery as a dev/extension
 * fallback (see lib/commands/_registry.js).
 *
 * The output is deterministic (sorted by filename) and timestamp-free, and the
 * file is only rewritten when its content actually changes, so no-op
 * regeneration never dirties the working tree.
 *
 * Usage:
 *   node scripts/gen-command-manifest.js            # write if changed
 *   node scripts/gen-command-manifest.js --check    # exit 1 if out of date
 *
 * @module scripts/gen-command-manifest
 */

const fs = require('node:fs');
const path = require('node:path');

const COMMANDS_DIR = path.resolve(__dirname, '..', 'lib', 'commands');
const MANIFEST_PATH = path.join(COMMANDS_DIR, '_manifest.js');

/**
 * List the command module filenames the manifest should enumerate.
 *
 * Mirrors the registry's own filter: `.js` files that do not start with `_`
 * (underscore-prefixed files are registry internals, not commands), sorted for
 * deterministic output.
 *
 * @param {string} [commandsDir] - Directory to scan (defaults to lib/commands)
 * @returns {string[]} Sorted command filenames (e.g. `['add.js', 'audit.js']`)
 */
function listCommandFiles(commandsDir = COMMANDS_DIR) {
  return fs
    .readdirSync(commandsDir)
    .filter(f => f.endsWith('.js') && !f.startsWith('_'))
    .sort();
}

/**
 * Render the manifest source from a list of command filenames.
 *
 * @param {string[]} files - Sorted command filenames
 * @returns {string} Full source text for lib/commands/_manifest.js
 */
function renderManifest(files) {
  const header = [
    '/**',
    ' * Static Command Manifest — GENERATED FILE, DO NOT EDIT.',
    ' *',
    ' * Regenerate with: node scripts/gen-command-manifest.js',
    ' * Drift is enforced by test/structural/command-manifest-drift.test.js.',
    ' *',
    ' * This module `require`s every command by a static relative path so',
    ' * `bun build --compile` can statically bundle the command graph. The registry',
    ' * (lib/commands/_registry.js) consumes `commands` as its fast, bundleable path',
    ' * and falls back to `fs.readdirSync` auto-discovery for dev/extension commands.',
    ' *',
    ' * @module commands/_manifest',
    ' */',
    '',
    "'use strict';",
    '',
    '/**',
    ' * @typedef {Object} ManifestEntry',
    ' * @property {string} file - Command filename (e.g. `status.js`)',
    ' * @property {import("./_registry").CommandModule} module - The required command module',
    ' */',
    '',
    '/** @type {ManifestEntry[]} */',
    'const commands = [',
  ];

  const entries = files.map(file => {
    const modPath = `./${file.replace(/\.js$/, '')}`;
    return `  { file: ${JSON.stringify(file)}, module: require(${JSON.stringify(modPath)}) },`;
  });

  const footer = [
    '];',
    '',
    'module.exports = {',
    '  // Absolute path of the canonical commands directory this manifest describes.',
    '  // The registry applies the manifest only when asked to load this exact dir.',
    '  dir: __dirname,',
    '  commands,',
    '};',
    '',
  ];

  return [...header, ...entries, ...footer].join('\n');
}

/**
 * Generate (or check) the manifest.
 *
 * @param {{ check?: boolean, commandsDir?: string, manifestPath?: string }} [opts]
 * @returns {{ changed: boolean, files: string[], path: string }}
 */
function generate(opts = {}) {
  const commandsDir = opts.commandsDir ?? COMMANDS_DIR;
  const manifestPath = opts.manifestPath ?? MANIFEST_PATH;
  const files = listCommandFiles(commandsDir);
  const next = renderManifest(files);

  const current = fs.existsSync(manifestPath)
    ? fs.readFileSync(manifestPath, 'utf8')
    : null;

  const changed = current !== next;

  if (changed && !opts.check) {
    fs.writeFileSync(manifestPath, next, 'utf8');
  }

  return { changed, files, path: manifestPath };
}

module.exports = { listCommandFiles, renderManifest, generate, COMMANDS_DIR, MANIFEST_PATH };

// CLI entry point
if (require.main === module) {
  const check = process.argv.includes('--check');
  const result = generate({ check });

  if (check && result.changed) {
    console.error(
      '[gen-command-manifest] lib/commands/_manifest.js is out of date.\n' +
      'Run: node scripts/gen-command-manifest.js'
    );
    process.exit(1);
  }

  if (result.changed) {
    console.log(
      `[gen-command-manifest] wrote ${path.relative(process.cwd(), result.path)} ` +
      `(${result.files.length} commands)`
    );
  } else {
    console.log(
      `[gen-command-manifest] up to date (${result.files.length} commands)`
    );
  }
}
