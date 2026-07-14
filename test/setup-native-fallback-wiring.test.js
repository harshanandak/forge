'use strict';

// B3: the LIVE `forge setup` path is bin/forge.js's installGitHooks/autoInstallLefthook
// (executeSetup -> installGitHooks). It must delegate to the shared lib/lefthook-wiring
// module so that: a REAL lefthook.yml is written (not the repo's dev config nor the
// stock example), a native `.git/hooks` fallback runs when the lefthook binary is
// unavailable, setup verifies hooks are actually active, and lefthook is never
// npm-installed into an ancestor package.json (kernel 22e33dbf).
//
// bin/forge.js is a CLI entrypoint (not a requireable module), so — matching the
// existing setup-shared-helper / cross-platform-install suites — these are
// source-level assertions that lock the wiring in place. The behavioural contract of
// the helpers themselves is covered by test/lefthook-wiring.test.js.

const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');

const forgeSource = fs.readFileSync(path.join(__dirname, '..', 'bin', 'forge.js'), 'utf8');

function bodyOf(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) return '';
  const nextFn = source.indexOf('\nfunction ', start + 1);
  const nextAsync = source.indexOf('\nasync function ', start + 1);
  const end = Math.min(
    nextFn > -1 ? nextFn : Infinity,
    nextAsync > -1 ? nextAsync : Infinity
  );
  return source.substring(start, end === Infinity ? source.length : end);
}

describe('bin/forge.js delegates hook wiring to lib/lefthook-wiring (B3)', () => {
  test('requires the shared lefthook-wiring module', () => {
    expect(forgeSource).toContain("require('../lib/lefthook-wiring')");
  });

  test('installGitHooks writes the REAL user lefthook.yml, not the repo dev config', () => {
    const body = bodyOf(forgeSource, 'function installGitHooks()');
    expect(body).toContain('FORGE_USER_LEFTHOOK_YML');
    expect(body).toContain('forgeShouldWriteLefthookConfig');
    // The old bug: copying the repo's own dev lefthook.yml (with scripts/*) to users.
    expect(body).not.toContain("path.join(packageDir, 'lefthook.yml')");
  });

  test('installGitHooks installs a native .git/hooks fallback', () => {
    const body = bodyOf(forgeSource, 'function installGitHooks()');
    expect(body).toContain('installNativeGitHooks');
  });

  test('installGitHooks verifies hooks are actually active (no silent no-op)', () => {
    const body = bodyOf(forgeSource, 'function installGitHooks()');
    expect(body).toContain('verifyHooksActive');
  });

  test('autoInstallLefthook refuses to npm-install lefthook without a local package.json', () => {
    const body = bodyOf(forgeSource, 'function autoInstallLefthook()');
    // Must guard on a package.json in projectRoot before running the package-manager
    // add/install, so npm/bun never resolves the install against an ancestor (22e33dbf).
    expect(body).toContain('package.json');
  });
});
