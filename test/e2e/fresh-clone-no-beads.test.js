'use strict';

// E2E acceptance (Forge 0.1.0 readiness gate: `fresh-clone-no-beads-acceptance`).
//
// Proves the Beads-retirement promise end to end: a FRESH CLONE of this repo, run
// with NO Beads/Dolt available on PATH, can drive the entire Forge issue lifecycle
// (prime -> ready -> create -> claim -> comment -> close -> recap) purely on the
// builtin `node:sqlite` kernel, never shelling out to `bd` or `dolt`.
//
// The harness is real, not mocked:
//   1. `git clone` makes a genuine fresh checkout (no node_modules of its own).
//   2. The repo's node_modules is junction/symlinked in so the cloned CLI runs.
//   3. `bd`/`dolt` are shimmed to a temp bin placed FIRST on PATH; each shim
//      appends its argv to a log and exits non-zero. If forge ever invoked them
//      the log would be non-empty (and the failing shim would likely break the
//      command), so an empty `bdInvocations` is hard proof forge stayed off Beads.

const { describe, test, expect, setDefaultTimeout } = require('bun:test');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const IS_WINDOWS = process.platform === 'win32';

// A real clone + lifecycle is slow; keep the per-test budget generous.
setDefaultTimeout(120000);

// Write a fake `bd`/`dolt` executable into `binDir` that records every call to
// `logPath` and fails, so any accidental shell-out is both logged and surfaced.
function installToolShim(binDir, name, logPath) {
  const posixShim = path.join(binDir, name);
  const posixLog = logPath.replace(/\\/g, '/');
  fs.writeFileSync(posixShim, `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "${posixLog}"\nexit 1\n`);
  if (!IS_WINDOWS) {
    fs.chmodSync(posixShim, 0o755);
  }
  if (IS_WINDOWS) {
    const cmdShim = path.join(binDir, `${name}.cmd`);
    fs.writeFileSync(cmdShim, `@echo off\r\necho ${name} %* >> "${logPath}"\r\nexit /b 1\r\n`);
  }
}

// Windows can hold a transient WAL/junction lock right after the kernel DB
// closes; retry the rm so cleanup never flakes the suite.
function rmrfWithRetry(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      // `recursive` rm treats the node_modules junction as a symlink and unlinks
      // it instead of descending, so the repo's real node_modules is untouched.
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4 || (error.code !== 'EBUSY' && error.code !== 'EPERM' && error.code !== 'ENOTEMPTY')) {
        return; // best-effort cleanup; never fail the test on a temp-dir lock
      }
      const until = Date.now() + 100;
      while (Date.now() < until) { /* brief spin before retry */ }
    }
  }
}

describe('fresh clone, no Beads — full Forge issue lifecycle on the builtin kernel', () => {
  test(
    'prime -> ready -> create -> claim -> comment -> close -> recap with zero bd invocations',
    () => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-fresh-clone-'));
      try {
        // 1) FRESH CLONE of this repo. `--local` is fast; fall back to `--no-local`
        //    for environments (e.g. linked worktrees on older git) where the local
        //    object copy is unavailable. The clone has no node_modules of its own.
        const freshCloneDir = path.join(workspace, 'clone');
        try {
          execFileSync('git', ['clone', '--local', '--no-hardlinks', REPO_ROOT, freshCloneDir], { stdio: 'pipe' });
        } catch {
          rmrfWithRetry(freshCloneDir);
          execFileSync('git', ['clone', '--no-local', REPO_ROOT, freshCloneDir], { stdio: 'pipe' });
        }
        expect(fs.existsSync(path.join(freshCloneDir, 'bin', 'forge.js'))).toBe(true);
        expect(fs.existsSync(path.join(freshCloneDir, '.git'))).toBe(true);

        // Make the clone runnable. The kernel uses node:sqlite (no install needed),
        // but the CLI still resolves npm deps from <clone>/node_modules, so link the
        // repo's node_modules in rather than running a slow reinstall.
        const repoNodeModules = path.join(REPO_ROOT, 'node_modules');
        const cloneNodeModules = path.join(freshCloneDir, 'node_modules');
        if (fs.existsSync(repoNodeModules) && !fs.existsSync(cloneNodeModules)) {
          // `fs.symlinkSync(..., 'junction')` makes a Windows junction (no admin,
          // no shell-out) and a normal dir symlink elsewhere. Using the Node API
          // instead of `cmd /c mklink` avoids building a shell command from path
          // values (CodeQL js/shell-command-injection-from-environment).
          try {
            fs.symlinkSync(repoNodeModules, cloneNodeModules, 'junction');
          } catch {
            fs.symlinkSync(repoNodeModules, cloneNodeModules, 'dir');
          }
        }
        expect(fs.existsSync(cloneNodeModules)).toBe(true);

        // AGENTS.md bypasses the first-run setup gate in the fresh clone.
        fs.writeFileSync(path.join(freshCloneDir, 'AGENTS.md'), '# fresh clone acceptance\n');

        // 2) NO Beads/Dolt environment: shim `bd`/`dolt` so any shell-out is
        //    recorded and fails, then put the shim dir FIRST on PATH.
        const noBeadsBinDir = path.join(workspace, 'no-beads-bin');
        fs.mkdirSync(noBeadsBinDir, { recursive: true });
        const bdInvocationsLog = path.join(workspace, 'bd-invocations.log');
        installToolShim(noBeadsBinDir, 'bd', bdInvocationsLog);
        installToolShim(noBeadsBinDir, 'dolt', bdInvocationsLog);

        const env = { ...process.env };
        // Windows env is case-insensitive; overwrite the existing PATH key in place
        // so the shim dir wins regardless of the original casing (`Path` vs `PATH`).
        const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
        env[pathKey] = noBeadsBinDir + path.delimiter + (env[pathKey] || '');

        // forge runner bound to the cloned CLI, the clone cwd, and the no-beads PATH.
        // Collects every command's stderr so step 5 can assert none of it ever
        // mentions Beads (the "Beads-not-initialized" noise this suite guards
        // against, per issue 8e38896c: a kernel-primary repo with no .beads/
        // dir must run the runtime commands clean, not just avoid shelling out).
        const cloneForgeBin = path.join(freshCloneDir, 'bin', 'forge.js');
        const capturedStderr = [];
        const forge = (args) => {
          // spawnSync (not execFileSync) so stderr is captured on the success
          // path too — a command can exit 0 while still warning on stderr.
          const proc = spawnSync('node', [cloneForgeBin, ...args], {
            cwd: freshCloneDir,
            env,
            encoding: 'utf8',
          });
          const stdout = proc.stdout || '';
          const stderr = proc.stderr || '';
          capturedStderr.push(stderr);
          if (proc.status !== 0) {
            throw new Error(`forge ${args.join(' ')} failed (exit ${proc.status}):\n${stdout}\n${stderr}`);
          }
          return stdout;
        };

        // 3) Drive the full lifecycle in the fresh clone (each must exit 0 —
        //    `forge` throws on a non-zero exit, with stderr in the message).
        forge(['prime']); // initialize/prime the kernel-backed session orientation
        forge(['status', '--json']); // kernel-backed status snapshot

        const ready = JSON.parse(forge(['issue', 'ready', '--json']));
        expect(Array.isArray(ready.data.issues)).toBe(true); // empty on a fresh clone is fine

        const created = JSON.parse(forge(['create', 'Fresh clone acceptance issue', '--type=task', '--json']));
        const issueId = created.data.id;
        expect(typeof issueId).toBe('string');
        expect(issueId.length).toBeGreaterThan(0);

        forge(['recap', issueId]); // grounding (gate.read_first): read the issue before claiming it
        forge(['claim', issueId, '--json']);
        forge(['comment', issueId, 'Acceptance run: fresh-clone lifecycle in progress', '--json']);
        forge(['close', issueId, '--reason=fresh-clone acceptance complete', '--json']);
        forge(['recap', issueId]); // issue-scoped recap; exits 0 even on the D21 V1 projection

        // 4) Prove forge never shelled out to bd/dolt: the recorder log is empty.
        const bdInvocations = fs.existsSync(bdInvocationsLog)
          ? fs.readFileSync(bdInvocationsLog, 'utf8').split('\n').filter(line => line.trim().length > 0)
          : [];
        expect(bdInvocations).toEqual([]);

        // 5) Prove none of the above printed Beads-not-initialized noise on
        //    stderr — the runtime purge target, distinct from "never shelled
        //    out" (a silent fs.existsSync probe could still warn on stderr).
        const beadsNoise = capturedStderr.join('\n');
        expect(beadsNoise).not.toMatch(/beads/i);
      } finally {
        rmrfWithRetry(workspace);
      }
    },
    120000,
  );
});
