// Byte-for-byte parity check between the two Forge distribution channels.
//
// Runs `forge setup` from BOTH the npm path (`node bin/forge.js`) and the compiled
// single-file binary into two throwaway git projects, then compares the produced
// trees by relative-path set + per-file SHA-256. Catches flattening, missing files,
// CRLF mangling, and corruption in one assertion.
//
// This is the "one real-compile leg" the reliability guidance asks for. It is
// runnable locally (`bun run parity:binary`) and by the step-3 CI matrix on each
// host target. Requires `bun` and `git` on PATH.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = process.platform === 'win32' ? 'forge-bin.exe' : 'forge-bin';
const BIN_PATH = path.join(REPO, BIN);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return r;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Directories to skip entirely while walking a setup tree. `node_modules` is a
// package-manager install artifact, NOT a Forge-managed asset — `setup --quick`
// may run an npm/bun install whose output (dependency trees, registry metadata)
// is legitimately non-deterministic between runs, channels, and OSes. Comparing
// it produces false-positive drift, so it is excluded. `.git` is runtime VCS state.
const EXCLUDED_DIRS = new Set(['.git', 'node_modules']);

// Files to skip regardless of location. Lockfiles are install byproducts: their
// bytes vary with registry ordering/timestamps and are not Forge assets. Excluding
// them keeps parity strict for real assets (skills/rules/hooks/.forge/AGENTS.md)
// while ignoring package-manager noise. `.package-lock.json` normally lives under
// node_modules/ (already excluded) but is guarded here too for robustness.
const EXCLUDED_FILES = new Set(['package-lock.json', '.package-lock.json']);

/**
 * Map of relative-posix-path → sha256 for every Forge-managed file under dir.
 * Excludes .git, node_modules/**, and package-manager lockfiles (see the
 * EXCLUDED_* sets above) so parity compares only Forge assets, not install output.
 */
function hashTree(dir) {
  const map = {};
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs)) {
      if (EXCLUDED_DIRS.has(e)) continue;
      const a = path.join(abs, e);
      const r = rel ? `${rel}/${e}` : e;
      const st = fs.lstatSync(a);
      if (st.isDirectory()) walk(a, r);
      else if (st.isFile() && !EXCLUDED_FILES.has(e)) map[r] = sha256(a);
    }
  };
  walk(dir, '');
  return map;
}

function makeProject(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `forge-parity-${label}-`));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'parity@forge.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'parity'], { cwd: dir });
  return dir;
}

function runSetup(label, cmd, args, dir) {
  console.log(`\n[${label}] ${cmd} ${args.join(' ')}  (cwd=${dir})`);
  const r = run(cmd, args, { cwd: dir });
  if (r.status !== 0) {
    console.error(`[${label}] setup exited ${r.status}`);
    if (r.stdout) console.error(r.stdout.slice(-2000));
    if (r.stderr) console.error(r.stderr.slice(-2000));
    throw new Error(`[${label}] setup failed`);
  }
  return r;
}

function main() {
  // 1. Build the binary (regenerates the embed manifest first).
  console.log('Building single-file binary (bun run build:binary)…');
  const build = run('bun', ['run', 'build:binary'], { cwd: REPO });
  if (build.status !== 0) {
    console.error(build.stdout || '');
    console.error(build.stderr || '');
    throw new Error('build:binary failed');
  }
  if (!fs.existsSync(BIN_PATH)) throw new Error(`binary not found at ${BIN_PATH}`);

  // 2. Run setup from both channels into fresh git projects.
  const setupArgs = ['setup', '--quick', '--yes'];
  const npmDir = makeProject('npm');
  const binDir = makeProject('bin');

  // try/finally so the throwaway temp git projects are removed even when setup
  // or the comparison throws (no leaked dirs on any failure path).
  try {
    runSetup('npm', 'node', [path.join(REPO, 'bin', 'forge.js'), ...setupArgs], npmDir);
    runSetup('bin', BIN_PATH, setupArgs, binDir);

    // 3. Compare trees.
    const a = hashTree(npmDir);
    const b = hashTree(binDir);
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const missingInBin = [];
    const missingInNpm = [];
    const differing = [];
    for (const k of keys) {
      if (!(k in b)) missingInBin.push(k);
      else if (!(k in a)) missingInNpm.push(k);
      else if (a[k] !== b[k]) differing.push(k);
    }

    const problems = missingInBin.length + missingInNpm.length + differing.length;
    console.log(`\nParity: ${Object.keys(a).length} npm files vs ${Object.keys(b).length} binary files.`);
    if (missingInBin.length) console.log(`  Missing in binary: ${missingInBin.join(', ')}`);
    if (missingInNpm.length) console.log(`  Missing in npm:    ${missingInNpm.join(', ')}`);
    if (differing.length) console.log(`  Differing bytes:   ${differing.join(', ')}`);

    if (problems > 0) {
      console.error(`\nPARITY FAILED (${problems} discrepancies).`);
      process.exit(1);
    }
    console.log('\nPARITY OK — npm and compiled binary produced byte-identical setup trees.');
  } finally {
    fs.rmSync(npmDir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  }
}

// Exported for unit testing the asset-vs-install-artifact filtering. `hashTree`
// and the exclusion sets are the load-bearing parity logic; the rest of the file
// drives real builds and only runs when executed directly (guarded below).
export { hashTree, EXCLUDED_DIRS, EXCLUDED_FILES };

// Only build + compare when run as a script, not when imported by a test.
if (import.meta.main) main();
