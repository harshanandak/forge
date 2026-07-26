'use strict';

// Kernel issue 4cf2c43d: five separate builders shifted the bd call-site census, forgot
// `forge release regen-audit`, and only found out a CI round later when the
// `d20-audit-artifact-current` release gate went red. Documentation did not fix it, so
// the pre-commit hook now regenerates and stages the artifact itself — the same shape
// scripts/sync-agent-skills.js uses to keep the .agents/skills mirror from drifting.

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { AUDIT_ARTIFACT } = require('../lib/release-readiness');
const { run, parseStagedNameStatus, stagedPaths } = require('../scripts/sync-d20-audit');

function deps(overrides = {}) {
  const calls = { wrote: 0, staged: [], logs: [] };
  const wired = {
    projectRoot: '/repo',
    staged: () => [],
    isCensusPath: (_root, filePath) => filePath.startsWith('lib/'),
    writeArtifact: () => { calls.wrote += 1; },
    stage: (_root, filePath) => calls.staged.push(filePath),
    log: message => calls.logs.push(message),
    ...overrides,
  };
  return { wired, calls };
}

describe('sync-d20-audit run() — changed-path gate', () => {
  test('regenerates and stages the artifact when a counted path is staged', () => {
    const { wired, calls } = deps({ staged: () => ['lib/commands/sync.js'] });

    const result = run(wired);

    expect(result.regenerated).toBe(true);
    expect(result.triggers).toEqual(['lib/commands/sync.js']);
    expect(calls.wrote).toBe(1);
    expect(calls.staged).toEqual([AUDIT_ARTIFACT]);
  });

  test('does no work at all when nothing staged touches the census', () => {
    const { wired, calls } = deps({ staged: () => ['notes/scratch.md', 'README.other'] });

    const result = run(wired);

    expect(result.regenerated).toBe(false);
    expect(result.triggers).toEqual([]);
    expect(calls.wrote).toBe(0);
    expect(calls.staged).toEqual([]);
  });

  test('skips an empty staging area without touching git or the filesystem', () => {
    const { wired, calls } = deps();

    expect(run(wired).regenerated).toBe(false);
    expect(calls.wrote).toBe(0);
  });

  test('reports the triggering paths so a surprised committer can see why', () => {
    const { wired, calls } = deps({ staged: () => ['lib/a.js', 'docs/x.md', 'lib/b.js'] });

    run(wired);

    expect(calls.logs.join('\n')).toContain('lib/a.js');
  });
});

// `--name-status -z` emits a flat NUL-delimited token stream: a status token, then one
// path (two for R/C). Line/tab splitting could not represent a pathname containing a tab
// or a newline, and git's non-z output would hand those over in its quoted, backslash-
// escaped form. Either way the hook would mis-read a census-impacting path and silently
// skip the regen — the exact failure this auto-heal exists to prevent.
describe('sync-d20-audit parseStagedNameStatus', () => {
  test('reads added/modified/deleted paths', () => {
    expect(parseStagedNameStatus('A\0lib/a.js\0M\0lib/b.js\0D\0lib/c.js\0'))
      .toEqual(['lib/a.js', 'lib/b.js', 'lib/c.js']);
  });

  // A rename changes the census on BOTH sides — the old path leaves it, the new one may
  // not enter it — so --name-only (destination only) would miss half the shift.
  test('reads both sides of a rename or copy', () => {
    expect(parseStagedNameStatus('R096\0lib/old.js\0lib/new.js\0'))
      .toEqual(['lib/old.js', 'lib/new.js']);
  });

  test('keeps the status/path pairing across a rename in the middle of the stream', () => {
    expect(parseStagedNameStatus('A\0lib/a.js\0R100\0lib/old.js\0lib/new.js\0M\0lib/b.js\0'))
      .toEqual(['lib/a.js', 'lib/old.js', 'lib/new.js', 'lib/b.js']);
  });

  test('reads a pathname containing a space', () => {
    expect(parseStagedNameStatus('M\0lib/with space.js\0'))
      .toEqual(['lib/with space.js']);
  });

  // Nothing may trim a pathname: leading/trailing whitespace is legal in git, and a
  // trimmed path stops matching the census predicate.
  test('preserves whitespace and embedded tabs/newlines in pathnames', () => {
    expect(parseStagedNameStatus('A\0lib/ padded .js\0M\0lib/tab\there.js\0D\0lib/new\nline.js\0'))
      .toEqual(['lib/ padded .js', 'lib/tab\there.js', 'lib/new\nline.js']);
  });

  test('handles empty output and the trailing NUL', () => {
    expect(parseStagedNameStatus('')).toEqual([]);
    expect(parseStagedNameStatus('\0')).toEqual([]);
  });
});

// The exec seam is injected the way the rest of the repo does it (`exec = execFileSync`),
// so the argv the hook depends on is asserted without needing a real repo.
describe('sync-d20-audit stagedPaths', () => {
  function fakeExec(output) {
    const calls = [];
    const exec = (file, args) => {
      calls.push({ file, args });
      return output;
    };
    return { exec, calls };
  }

  test('asks git for NUL-delimited output', () => {
    const { exec, calls } = fakeExec('');

    stagedPaths('/project', exec);

    expect(calls[0].file).toBe('git');
    expect(calls[0].args).toContain('-z');
    expect(calls[0].args).toContain('--name-status');
  });

  test('returns the parsed paths, deduplicated', () => {
    const { exec } = fakeExec('M\0lib/a.js\0A\0lib/a.js\0D\0lib/b.js\0');

    expect(stagedPaths('/project', exec)).toEqual(['lib/a.js', 'lib/b.js']);
  });
});

describe('lefthook wiring', () => {
  const lefthook = fs.readFileSync(path.join(__dirname, '..', 'lefthook.yml'), 'utf8');

  test('runs the auto-heal as a pre-commit job', () => {
    const preCommit = lefthook.split(/^pre-push:/m)[0];
    expect(preCommit).toContain('node scripts/sync-d20-audit.js');
  });

  // The script does its own changed-path gating (the census roots are resolved at run
  // time from plugin manifests + .forge/sync-manifest.json), so a static lefthook glob
  // would be a second, drifting copy of the predicate.
  test('does not re-declare the predicate as a lefthook glob', () => {
    const job = lefthook.split('sync-d20-audit')[1].split(/\n\s{4}\w[\w-]*:/)[0];
    expect(job).not.toContain('glob:');
  });
});

// Unconditional, like the sibling real-git suite in test/release-readiness-tracked.test.js:
// git is a hard prerequisite of this repo (the hooks, the census's own `git ls-files`, the
// push workflow), so a suite that silently vanished without it would only ever hide a
// broken environment.
describe('sync-d20-audit in a real git repo', () => {
  let repo;

  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-d20-heal-')));
    spawnSync('git', ['-C', repo, 'init', '-q'], { encoding: 'utf8' });
    spawnSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
    spawnSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
  });

  afterEach(() => {
    if (repo && fs.existsSync(repo)) fs.rmSync(repo, { recursive: true, force: true });
  });

  function write(relativePath, content) {
    const full = path.join(repo, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }

  function stagedPaths() {
    return spawnSync('git', ['-C', repo, 'diff', '--cached', '--name-only'], { encoding: 'utf8' })
      .stdout.split(/\r?\n/).filter(Boolean);
  }

  function runScript() {
    return spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'sync-d20-audit.js')], {
      cwd: repo,
      encoding: 'utf8',
    });
  }

  test('stages a regenerated artifact for a staged census path', () => {
    write('lib/commands/sync.js', "spawnSync('bd', ['sync']);\n");
    spawnSync('git', ['-C', repo, 'add', 'lib/commands/sync.js']);

    const result = runScript();

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(repo, ...AUDIT_ARTIFACT.split('/')))).toBe(true);
    expect(stagedPaths()).toContain(AUDIT_ARTIFACT);
  });

  test('leaves the tree alone when the staged path is outside the census', () => {
    write('notes/scratch.txt', 'bd bd bd\n');
    spawnSync('git', ['-C', repo, 'add', 'notes/scratch.txt']);

    const result = runScript();

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(repo, ...AUDIT_ARTIFACT.split('/')))).toBe(false);
    expect(stagedPaths()).toEqual(['notes/scratch.txt']);
  });
});
