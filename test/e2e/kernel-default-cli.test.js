'use strict';

// E2E: every CLI issue op runs on the KERNEL as the DEFAULT backend — no
// `--kernel` flag, no FORGE_ISSUE_BACKEND env. This is the dogfood proof for the
// default-backend flip (DEFAULT_BACKEND beads -> kernel). Each op spawns the real
// `forge` bin against a throwaway git repo and is asserted to (a) create/grow a
// fresh `.git/forge/kernel.sqlite` and (b) return the kernel issue-command
// contract (`schema_version: "forge.issue.v1"`) — NOT the Beads shape. Beads is
// uninitialized in the temp repo, so a Beads-routed op would error "Beads is not
// initialized" / "no beads database"; kernel-contract output therefore proves the
// op routed to the kernel, not merely that it exited 0.
//
// `claim` and `release` now route to and SUCCEED on the kernel default path: the
// de-beading spine (#241) implemented the real kernel handlers, closing the
// invalid_claim_scope and SQLite param-binding gaps. Their test below asserts the
// kernel contract on success and will RED if a regression breaks them. (dep
// add/remove likewise route to the kernel by default — covered above via the
// `forge issue dep` grouping.)

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FORGE_BIN = path.join(__dirname, '..', '..', 'bin', 'forge.js');
const TIMEOUT = 30000;

// Spawn the real forge bin with NO backend selector. A scrubbed env strips any
// ambient FORGE_ISSUE_BACKEND so the run exercises the pure default path. Returns
// `{ stdout, status }`; never throws on a non-zero exit (we assert on status).
function runForgeDefault(cwd, args) {
  const env = { ...process.env };
  delete env.FORGE_ISSUE_BACKEND;
  try {
    const stdout = execFileSync('node', [FORGE_BIN, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    return { stdout, status: 0 };
  } catch (error) {
    return {
      stdout: `${error.stdout || ''}${error.stderr || ''}`,
      status: typeof error.status === 'number' ? error.status : 1,
    };
  }
}

// Pull the minted UUID id out of a `forge create` kernel contract envelope.
function extractId(stdout) {
  const match = stdout.match(/"id":\s*"([^"]+)"/);
  return match ? match[1] : null;
}

// Windows can hold a transient WAL lock on the just-written DB; retry the rm.
function rmrfWithRetry(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4 || (error.code !== 'EBUSY' && error.code !== 'EPERM')) {
        return; // best-effort cleanup; never fail a test on a temp-dir lock
      }
      const until = Date.now() + 100;
      while (Date.now() < until) { /* brief spin before retry */ }
    }
  }
}

// A kernel contract envelope is the discriminator: only the kernel path emits it.
function expectKernelContract(stdout, command) {
  expect(stdout).toContain('"schema_version": "forge.issue.v1"');
  expect(stdout).toContain(`"command": "issue.${command}"`);
}

describe('kernel is the DEFAULT issue backend — full CLI dogfood (no --kernel flag)', () => {
  let repo;
  let dbPath;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-kernel-default-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    // AGENTS.md bypasses the first-run setup gate (mirrors kernel-issue-cli.test.js).
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# test\n');
    dbPath = path.join(repo, '.git', 'forge', 'kernel.sqlite');
  });

  afterEach(() => {
    rmrfWithRetry(repo);
  });

  test(
    'create routes to the kernel by default — mints a kernel id and writes kernel.sqlite',
    () => {
      expect(fs.existsSync(dbPath)).toBe(false);
      const { stdout, status } = runForgeDefault(repo, ['create', '--title', 'first issue', '--type', 'task']);
      expect(status).toBe(0);
      expectKernelContract(stdout, 'create');
      // The fresh kernel DB was materialized by the default path — proof of routing.
      expect(fs.existsSync(dbPath)).toBe(true);
      expect(extractId(stdout)).toBeTruthy();
    },
    TIMEOUT,
  );

  test(
    'read + write ops all route to the kernel by default',
    () => {
      const created = runForgeDefault(repo, ['create', '--title', 'seed issue', '--type', 'task']);
      expect(created.status).toBe(0);
      const id = extractId(created.stdout);
      expect(id).toBeTruthy();

      // list / show — derived + single reads. Human-first (a9bbd065): the DEFAULT
      // output is a text rendering; the forge.issue.v1 contract is behind --json.
      expectKernelContract(runForgeDefault(repo, ['list', '--json']).stdout, 'list');
      expectKernelContract(runForgeDefault(repo, ['show', id, '--json']).stdout, 'show');
      const humanList = runForgeDefault(repo, ['list']).stdout;
      expect(humanList).toContain('seed issue');
      expect(humanList).not.toContain('"schema_version"');
      const humanShow = runForgeDefault(repo, ['show', id]).stdout;
      expect(humanShow).toContain(id); // the FULL id stays accessible in the show view
      expect(humanShow).not.toContain('"schema_version"');

      // update / comment — guarded mutations
      expectKernelContract(runForgeDefault(repo, ['update', id, '--priority', '1']).stdout, 'update');
      expectKernelContract(runForgeDefault(repo, ['comment', id, 'a handoff note']).stdout, 'comment');

      // derived read queries — these were the routing gap fixed alongside the flip
      // (blocked/stale/orphans/lint were missing from ISSUE_COMMANDS and fell
      // through to the Beads passthrough). Assert they now hit the kernel.
      // ready is human-first like list/show, so its contract check needs --json.
      expectKernelContract(runForgeDefault(repo, ['ready', '--json']).stdout, 'ready');
      expect(runForgeDefault(repo, ['ready']).stdout).not.toContain('"schema_version"');
      expectKernelContract(runForgeDefault(repo, ['blocked']).stdout, 'blocked');
      expectKernelContract(runForgeDefault(repo, ['stale']).stdout, 'stale');
      expectKernelContract(runForgeDefault(repo, ['orphans']).stdout, 'orphans');
      expectKernelContract(runForgeDefault(repo, ['lint']).stdout, 'lint');
    },
    TIMEOUT,
  );

  test(
    'close routes to the kernel by default — single id and multi-id with --reason',
    () => {
      const a = extractId(runForgeDefault(repo, ['create', '--title', 'close A', '--type', 'task']).stdout);
      const b = extractId(runForgeDefault(repo, ['create', '--title', 'close B', '--type', 'task']).stdout);
      const c = extractId(runForgeDefault(repo, ['create', '--title', 'close C', '--type', 'task']).stdout);
      expect(a && b && c).toBeTruthy();

      // Single-id close → byte-identical single kernel path, kernel contract.
      expectKernelContract(runForgeDefault(repo, ['close', a, '--reason', 'done']).stdout, 'close');

      // Multi-id close → batched fan-out (one kernel call per id), aggregated into
      // a JSON summary listing every id. Exit 0 and both ids present prove all
      // closed on the kernel.
      const multi = runForgeDefault(repo, ['close', b, c, '--reason', 'batch done']);
      expect(multi.status).toBe(0);
      expect(multi.stdout).toContain(b);
      expect(multi.stdout).toContain(c);
    },
    TIMEOUT,
  );

  test(
    'dep add / dep remove route to the kernel by default (via the issue grouping)',
    () => {
      // `dep` has no top-level alias command (no lib/commands/dep.js) — it is only
      // reachable through the `forge issue dep <action>` grouping. Exercise that
      // real path and assert it routes to the kernel by default.
      const a = extractId(runForgeDefault(repo, ['create', '--title', 'dep blocker', '--type', 'task']).stdout);
      const b = extractId(runForgeDefault(repo, ['create', '--title', 'dep blocked', '--type', 'task']).stdout);
      expect(a && b).toBeTruthy();

      expectKernelContract(runForgeDefault(repo, ['issue', 'dep', 'add', a, b]).stdout, 'dep.add');
      expectKernelContract(runForgeDefault(repo, ['issue', 'dep', 'remove', a, b]).stdout, 'dep.remove');
    },
    TIMEOUT,
  );

  test(
    'beads opt-out (--issue-backend beads) routes AWAY from the kernel by default-flip',
    () => {
      // With beads uninitialized in the temp repo, the beads-routed read must fail
      // with a Beads-specific error (NOT the kernel contract). This proves the
      // opt-out escape hatch still selects Beads after the default flip.
      const { stdout } = runForgeDefault(repo, ['list', '--issue-backend', 'beads']);
      expect(stdout).not.toContain('"schema_version": "forge.issue.v1"');
      expect(stdout).toMatch(/beads|bd/i);
    },
    TIMEOUT,
  );

  test(
    'claim + release succeed on the kernel default path (post-spine #241)',
    () => {
      const id = extractId(runForgeDefault(repo, ['create', '--title', 'gap issue', '--type', 'task']).stdout);
      expect(id).toBeTruthy();

      // claim — the de-beading spine (#241) implemented the real kernel claim
      // handler (fixed the invalid_claim_scope gap). No --kernel flag, so this
      // proves the DEFAULT path now claims successfully.
      const claim = runForgeDefault(repo, ['claim', id]);
      expect(claim.status).toBe(0);
      // Assert the kernel contract on stdout, not just a zero exit: claim/release
      // emit a bare `"command": "claim"`/`"release"` (no `issue.` prefix), so assert
      // the strings directly rather than via expectKernelContract. This proves real
      // kernel routing — release in particular exits 0 even for a nonexistent id.
      expect(claim.stdout).toContain('"schema_version": "forge.issue.v1"');
      expect(claim.stdout).toContain('"command": "claim"');

      // release — #241 also fixed the kernel release handler (SQLite param
      // binding). The previously-locked gap is now closed end-to-end.
      const release = runForgeDefault(repo, ['release', id]);
      expect(release.status).toBe(0);
      expect(release.stdout).toContain('"schema_version": "forge.issue.v1"');
      expect(release.stdout).toContain('"command": "release"');
    },
    TIMEOUT,
  );

  test(
    'search + stats route to the kernel by default',
    () => {
      // Both are reads in ISSUE_COMMANDS; with no --kernel flag they must hit the
      // kernel contract so the file-level "every CLI issue op" claim holds.
      expectKernelContract(runForgeDefault(repo, ['issue', 'search', 'seed']).stdout, 'search');
      expectKernelContract(runForgeDefault(repo, ['issue', 'stats']).stdout, 'stats');
    },
    TIMEOUT,
  );

  test(
    'subcommand --help prints usage and mints nothing on the kernel default',
    () => {
      // Regression guard: pre-fix, `--help` was forwarded to the kernel as an op arg,
      // so `forge issues create --help` errored "Command failed" and the singular
      // `forge create --help` SILENTLY minted a junk issue. Help must short-circuit
      // before any backend dispatch (lib/commands/_issue.js + lib/commands/issues.js).
      for (const args of [['create', '--help'], ['issue', 'create', '--help'], ['issues', 'create', '--help']]) {
        const res = runForgeDefault(repo, args);
        expect(res.status).toBe(0);
        expect(res.stdout).toContain('forge create');
        // A help request never dispatches to a backend: no create envelope returned.
        expect(res.stdout).not.toContain('"schema_version": "forge.issue.v1"');
      }
      // Help mints NOTHING: the issue store stays empty (pre-fix the singular path
      // silently minted a junk issue here). The broker may lazily create an empty
      // kernel.sqlite during opts resolution, so assert an empty store — not file
      // absence.
      const list = runForgeDefault(repo, ['issue', 'list', '--json']);
      expect(list.stdout).toContain('"count": 0');
    },
    TIMEOUT,
  );

  test(
    'update/close/comment on a nonexistent id error without minting a phantom issue',
    () => {
      // Regression (data-corruption blocker): a typo'd id on a mutation used to
      // SILENTLY succeed (exit 0) AND materialize a phantom issue — the row-level CAS
      // treated a missing row as expected_revision 0 and inserted it. It must now fail
      // with no write, matching Beads' not-found behavior.
      for (const args of [['update', 'missing-1', '--priority', '1'], ['close', 'missing-2'], ['comment', 'missing-3', 'note']]) {
        const res = runForgeDefault(repo, args);
        expect(res.status).not.toBe(0);
        expect(res.stdout).toMatch(/not found/i);
      }
      // None of the three failed mutations minted a phantom row.
      const after = runForgeDefault(repo, ['issue', 'list', '--json']);
      expect(after.stdout).toContain('"count": 0');
    },
    TIMEOUT,
  );
});
