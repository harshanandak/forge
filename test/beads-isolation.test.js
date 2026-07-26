const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');

const ROOT = path.resolve(__dirname, '..');

/**
 * Modules deleted when the live Beads surfaces were retired (Slice D).
 * Requiring any of them must fail — they have no replacement.
 */
const DELETED_MODULES = [
  '../lib/beads-setup',
  '../lib/beads-sync-scaffold',
  '../lib/pat-setup',
];

/**
 * The ONLY runtime modules allowed to require a beads-named module.
 *
 * Beads survives exclusively as an inbound migration path
 * (`forge migrate --from beads`), the upgrade-time advisory that detects stale
 * Beads artifacts, and the kernel's JSONL projection compat writer. Every
 * entry is named individually — a directory-wide exemption would let any new
 * module under it reintroduce a live Beads surface without failing this test.
 */
const ALLOWED_IMPORTERS = new Set([
  'lib/commands/migrate.js',
  'lib/upgrade-safety.js',
  'lib/kernel/projection-jsonl-writer.js',
]);

const BEADS_REQUIRE = /require\(\s*['"]([^'"]*beads[^'"]*)['"]\s*\)/g;

/**
 * Spawning the retired `bd` binary is the same live dependency as importing a
 * beads module, just through the process boundary instead of the module graph.
 * Matched on the argument shape (`'bd'` as argv[0] followed by an args list)
 * rather than on a list of child_process function names, so an injected or
 * renamed runner — `runCommand('bd', args)` — cannot smuggle one back in.
 */
const JS_BD_SPAWN = /\(\s*['"]bd['"]\s*,/;

/**
 * Shell scripts have no spawn syntax to key on: every bare `bd` token is an
 * invocation, a shim that resolves one, or an operator message naming the
 * binary — all live Beads surface. So the shell pass matches the word itself
 * with `#` comments stripped first, which is why the scripts are held by exact
 * line rather than by call shape.
 */
const SH_BD_TOKEN = /\bbd\b/;

function normalizeSignature(line) {
  return line.trim().replace(/\s+/g, ' ');
}

/**
 * The bd call sites that exist today, each pinned to its own normalized source
 * line and to how many identical lines its file may hold.
 *
 * Allowlisting whole files instead — as this guard first did — meant a brand
 * new bd spawn added to one of them passed silently. Under this shape the rest
 * of an allowlisted file is still scanned: only these exact lines are exempt,
 * and a copy of one is a violation like any other new call site.
 *
 * This is a shrinking baseline, not an exemption. Every entry is held open by a
 * filed issue, and the guard still fails closed for anything not listed.
 */
const ALLOWED_BD_CALL_SITES = new Map([
  // `forge migrate --from beads` shells out to `bd export` to read a legacy
  // store — the sanctioned inbound migration path, which is why this file is
  // also an allowed importer above.
  [
    'lib/commands/migrate.js',
    [{ signature: "const stdout = exec('bd', ['export', '--all'], {", count: 1 }],
  ],
  // 9ee29231-66ee-441d-a5df-d82e9ae1ab60
  [
    'lib/commands/status.js',
    [{ signature: "const raw = secureExecFileSync('bd', ['show', issueId, '--json'], {", count: 1 }],
  ],
  // 5b02dbd6-2c68-4c69-b0ee-fc1f05666f3c
  [
    'lib/runtime-health.js',
    [{ signature: "const bd = checkCommandAvailability('bd', root, options);", count: 1 }],
  ],
  // 560dc153-4f31-4007-a99b-3acbb89d43bf — resolves BD_CMD and defines the bd()
  // wrapper the three scripts below depend on, so it retires last.
  [
    'scripts/bootstrap-windows-tools.sh',
    [
      { signature: 'BD_CMD="$(_forge_resolve_tool bd || true)"', count: 1 },
      { signature: 'bd() {', count: 1 },
    ],
  ],
  // a0d5bc41-c6b5-43e4-8e98-9e0004b29d52
  [
    'scripts/dep-guard.sh',
    [
      {
        signature:
          'rollback_output="$(${BD_CMD:-bd} dep remove "$dependent_issue" "$depends_on_issue" 2>&1)" || {',
        count: 1,
      },
      { signature: 'output="$(${BD_CMD:-bd} update "$@" 2>&1)"', count: 1 },
      { signature: 'output="$(${BD_CMD:-bd} comments add "$@" 2>&1)"', count: 1 },
      { signature: 'output="$(${BD_CMD:-bd} set-state "$@" 2>&1)"', count: 1 },
      {
        signature:
          'json="$(${BD_CMD:-bd} show "$issue_id" --json 2>&1)" || die "Failed to show issue ${issue_id}"',
        count: 1,
      },
      { signature: 'open_list="$(${BD_CMD:-bd} list --status=open 2>/dev/null)" || true', count: 1 },
      {
        signature: 'ip_list="$(${BD_CMD:-bd} list --status=in_progress 2>/dev/null)" || true',
        count: 1,
      },
      {
        signature: 'open_json="$(${BD_CMD:-bd} list --status=open --json 2>/dev/null)" || true',
        count: 1,
      },
      {
        signature:
          'in_progress_json="$(${BD_CMD:-bd} list --status=in_progress --json 2>/dev/null)" || true',
        count: 1,
      },
      {
        signature:
          'dep_add_output="$(${BD_CMD:-bd} dep add "$dependent_issue" "$depends_on_issue" 2>&1)" || {',
        count: 1,
      },
      { signature: 'if ! ${BD_CMD:-bd} dep cycles &>/dev/null; then', count: 1 },
      {
        signature: 'graph_output="$(${BD_CMD:-bd} graph "$issue_id" 2>&1)" || rollback_and_die \\',
        count: 1,
      },
      {
        signature: 'ready_output="$(${BD_CMD:-bd} ready 2>&1)" || rollback_and_die \\',
        count: 1,
      },
    ],
  ],
  // d4ef0670-ecae-4c9a-a651-b70321f0aa37
  [
    'scripts/pr-coordinator.sh',
    [
      {
        signature: 'add_output="$(${BD_CMD:-bd} dep add "$issue_a" "$issue_b" 2>&1)" || {',
        count: 1,
      },
      { signature: 'if ! ${BD_CMD:-bd} dep cycles &>/dev/null; then', count: 2 },
      {
        signature: '${BD_CMD:-bd} dep remove "$issue_a" "$issue_b" 2>/dev/null || true',
        count: 1,
      },
      { signature: '${BD_CMD:-bd} dep remove "$issue_a" "$issue_b" 2>&1 || {', count: 1 },
      { signature: 'show_output="$(${BD_CMD:-bd} show "$issue_id" 2>&1)" || {', count: 2 },
      {
        signature: 'list_output="$(${BD_CMD:-bd} list --status=open,in_progress 2>&1)" || {',
        count: 1,
      },
      { signature: 'show_out="$(${BD_CMD:-bd} show "$issue_id" 2>&1)" || continue', count: 1 },
      {
        signature:
          '${BD_CMD:-bd} set-state "$issue_id" "pr_number=$pr_number" --reason "PR created by /ship" 2>&1 || {',
        count: 1,
      },
      {
        signature: 'issues_output="$(${BD_CMD:-bd} list --status=open,in_progress 2>&1)" || {',
        count: 1,
      },
      { signature: 'show_out="$(${BD_CMD:-bd} show "$id" 2>&1)" || continue', count: 2 },
    ],
  ],
  // 5e19f428-423e-43b9-a731-b0393744546d
  [
    'scripts/sync-utils.sh',
    [
      { signature: 'bd dolt pull && bd dolt push', count: 1 },
      { signature: 'local bd_cmd="${BD_CMD:-bd}"', count: 1 },
      {
        signature:
          'echo "Warning: sync skipped, unable to inspect Beads Dolt remotes (is \'bd\' installed and configured?)." >&2',
        count: 1,
      },
      {
        signature:
          'echo "Warning: sync skipped, Beads Dolt remote \'$sync_remote\' is not configured (run \'bd dolt remote add $sync_remote <url>\')." >&2',
        count: 1,
      },
      {
        signature:
          'design_meta="$(bd show "$issue_id" 2>/dev/null | grep -A1 \'DESIGN\' | tail -1 | sed \'s/.*| //\')" || true',
        count: 1,
      },
    ],
  ],
]);

function collectFiles(dir, extension, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, extension, acc);
    } else if (entry.name.endsWith(extension)) {
      acc.push(full);
    }
  }
  return acc;
}

function toRepoPath(absolute) {
  return path.relative(ROOT, absolute).split(path.sep).join('/');
}

function isAllowedImporter(repoPath) {
  return ALLOWED_IMPORTERS.has(repoPath);
}

function readEntry(absolute, shell) {
  return { repoPath: toRepoPath(absolute), source: fs.readFileSync(absolute, 'utf8'), shell };
}

/** Every file the bd guard reads: JavaScript runtime plus the shell scripts. */
function loadScanEntries() {
  return [
    ...collectFiles(path.join(ROOT, 'lib'), '.js').map(file => readEntry(file, false)),
    ...collectFiles(path.join(ROOT, 'bin'), '.js').map(file => readEntry(file, false)),
    ...collectFiles(path.join(ROOT, 'scripts'), '.js').map(file => readEntry(file, false)),
    ...collectFiles(path.join(ROOT, 'scripts'), '.sh').map(file => readEntry(file, true)),
  ];
}

function findBdCallSites(source, shell) {
  const pattern = shell ? SH_BD_TOKEN : JS_BD_SPAWN;
  const counts = new Map();

  for (const line of source.split(/\r?\n/)) {
    const code = shell ? line.replace(/#.*$/, '') : line;
    if (!pattern.test(code)) continue;
    const signature = normalizeSignature(code);
    counts.set(signature, (counts.get(signature) || 0) + 1);
  }

  return counts;
}

function allowedCountsFor(repoPath) {
  const sites = ALLOWED_BD_CALL_SITES.get(repoPath) || [];
  return new Map(sites.map(site => [site.signature, site.count]));
}

function collectBdViolations(entries) {
  const violations = [];

  for (const entry of entries) {
    const allowed = allowedCountsFor(entry.repoPath);

    for (const [signature, count] of findBdCallSites(entry.source, entry.shell)) {
      if (!allowed.has(signature)) {
        violations.push(`${entry.repoPath}: new bd call site \`${signature}\``);
      } else if (allowed.get(signature) !== count) {
        violations.push(
          `${entry.repoPath}: bd call site \`${signature}\` occurs ${count}x, allowlisted ${allowed.get(signature)}x`,
        );
      }
    }
  }

  return violations;
}

/** Entries whose call site is gone: the baseline shrank and must be recorded. */
function findStaleAllowlistEntries(entries) {
  const scanned = new Map(entries.map(entry => [entry.repoPath, entry]));
  const stale = [];

  for (const [repoPath, sites] of ALLOWED_BD_CALL_SITES) {
    const entry = scanned.get(repoPath);
    if (!entry) {
      stale.push(`${repoPath}: file is gone or no longer scanned`);
      continue;
    }

    const found = findBdCallSites(entry.source, entry.shell);
    for (const site of sites) {
      if (!found.has(site.signature)) stale.push(`${repoPath}: \`${site.signature}\``);
    }
  }

  return stale;
}

describe('beads isolation', () => {
  test.each(DELETED_MODULES)('%s no longer exists', modulePath => {
    // require.resolve, not require: a restored module that throws its own
    // "Cannot find module" would otherwise satisfy this assertion.
    expect(() => require.resolve(modulePath)).toThrow(/Cannot find module/);
  });

  test('no runtime module outside the migration path requires a beads module', () => {
    const files = [
      ...collectFiles(path.join(ROOT, 'lib'), '.js'),
      ...collectFiles(path.join(ROOT, 'bin'), '.js'),
    ];

    const violations = [];
    for (const file of files) {
      const repoPath = toRepoPath(file);
      if (isAllowedImporter(repoPath)) continue;

      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(BEADS_REQUIRE)) {
        violations.push(`${repoPath} requires ${match[1]}`);
      }
    }

    expect(violations).toEqual([]);
  });

  test('no bd call site outside the allowlist exists in runtime code or scripts', () => {
    expect(collectBdViolations(loadScanEntries())).toEqual([]);
  });

  test('the guard scans shell scripts, not only JavaScript', () => {
    const shellPaths = loadScanEntries()
      .filter(entry => entry.shell)
      .map(entry => entry.repoPath);

    expect(shellPaths).toContain('scripts/dep-guard.sh');
    expect(shellPaths).toContain('scripts/pr-coordinator.sh');
    expect(shellPaths).toContain('scripts/sync-utils.sh');
  });

  test('the bd call-site allowlist carries no stale entries', () => {
    expect(findStaleAllowlistEntries(loadScanEntries())).toEqual([]);
  });

  test('a new bd spawn inside an allowlisted file still fails the guard', () => {
    const repoPath = 'lib/commands/migrate.js';
    const source = `${fs.readFileSync(path.join(ROOT, repoPath), 'utf8')}\nrunCommand('bd', ['close', issueId]);\n`;

    expect(collectBdViolations([{ repoPath, source, shell: false }])).toEqual([
      "lib/commands/migrate.js: new bd call site `runCommand('bd', ['close', issueId]);`",
    ]);
  });

  test('a copy of an allowlisted bd call site fails the guard', () => {
    const repoPath = 'lib/commands/status.js';
    const [site] = ALLOWED_BD_CALL_SITES.get(repoPath);
    const source = `${fs.readFileSync(path.join(ROOT, repoPath), 'utf8')}\n${site.signature}\n`;

    expect(collectBdViolations([{ repoPath, source, shell: false }])).toEqual([
      `lib/commands/status.js: bd call site \`${site.signature}\` occurs 2x, allowlisted 1x`,
    ]);
  });

  test('a new bd invocation inside an allowlisted shell script fails the guard', () => {
    const repoPath = 'scripts/sync-utils.sh';
    const source = `${fs.readFileSync(path.join(ROOT, repoPath), 'utf8')}\nbd close "$issue_id"\n`;

    expect(collectBdViolations([{ repoPath, source, shell: true }])).toEqual([
      'scripts/sync-utils.sh: new bd call site `bd close "$issue_id"`',
    ]);
  });

  test('the deleted sync scaffold scripts are gone', () => {
    const removed = [
      'scripts/github-beads-sync',
      'scripts/github-beads-sync.config.json',
      'scripts/beads-context.sh',
      'scripts/beads-migrate-to-dolt.sh',
      'scripts/lib/beads-migrate-to-dolt.mjs',
      'scripts/beads-upgrade-smoke.sh',
    ];

    const survivors = removed.filter(rel => fs.existsSync(path.join(ROOT, rel)));
    expect(survivors).toEqual([]);
  });

  test('detectDefaultBranch lives in a beads-free module', () => {
    const { detectDefaultBranch } = require('../lib/git-defaults');
    expect(typeof detectDefaultBranch).toBe('function');
  });
});
