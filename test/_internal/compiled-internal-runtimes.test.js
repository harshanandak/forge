'use strict';

// Regression guard for PR #577 review (P1): the internal runtimes (Contracts,
// Memory, Flow) must be embedded in a `bun build --compile` binary. Bun's
// compiler does not follow computed require() specifiers, so a binary moved
// away from the tree it was built in could not load them. Running the binary
// next to the original checkout masks that, so this test builds from a
// throwaway copy of the loader + workspace packages, deletes the copy, and
// only then runs the binary. The compile flags match `build:binary`.

const { expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '../..');
const RUNTIMES = ['contracts', 'memory', 'flow'];

function stageBuildRoot(buildRoot) {
  fs.cpSync(path.join(REPO, 'lib', '_internal'), path.join(buildRoot, 'lib', '_internal'), {
    recursive: true,
    filter: (source) => path.basename(source) !== 'vendor',
  });
  for (const name of RUNTIMES) {
    fs.cpSync(path.join(REPO, 'packages', name), path.join(buildRoot, 'packages', name), {
      recursive: true,
      filter: (source) => path.basename(source) !== 'node_modules',
    });
  }
  // Workspace link that memory/flow resolve `@forge/contracts` through.
  fs.cpSync(path.join(REPO, 'packages', 'contracts'), path.join(buildRoot, 'node_modules', '@forge', 'contracts'), {
    recursive: true,
    filter: (source) => path.basename(source) !== 'node_modules',
  });
  const shims = RUNTIMES
    .map((name) => `  ${name}: typeof require('./lib/_internal/${name}.js'),`)
    .join('\n');
  const entry = path.join(buildRoot, 'entry.js');
  fs.writeFileSync(entry, `'use strict';\nconsole.log(JSON.stringify({\n${shims}\n}));\n`);
  return entry;
}

test('compiled binary embeds contracts, memory and flow runtimes', () => {
  const buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-compiled-build-'));
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-compiled-run-'));
  try {
    const entry = stageBuildRoot(buildRoot);
    const outfile = path.join(buildRoot, 'probe-bin');
    const build = spawnSync(process.execPath, [
      'build', '--compile', '--define', 'FORGE_COMPILED=true', entry, '--outfile', outfile,
    ], { cwd: buildRoot, encoding: 'utf8' });
    expect(build.status).toBe(0);

    const builtName = fs.readdirSync(buildRoot).find((name) => name.startsWith('probe-bin'));
    const moved = path.join(runDir, builtName);
    fs.copyFileSync(path.join(buildRoot, builtName), moved);
    fs.chmodSync(moved, 0o755);
    fs.rmSync(buildRoot, { force: true, recursive: true });

    const run = spawnSync(moved, [], { cwd: runDir, encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout.trim())).toEqual({
      contracts: 'object',
      memory: 'object',
      flow: 'object',
    });
  } finally {
    fs.rmSync(buildRoot, { force: true, recursive: true });
    fs.rmSync(runDir, { force: true, recursive: true });
  }
}, 180_000);
