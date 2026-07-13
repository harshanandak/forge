'use strict';

// Regression guard for issue 53770b23 — "dynamic require(...) not bundled by
// bun compile, so a production dependency is missing at runtime in the single
// binary".
//
// bun's `--compile` bundler only follows requires it can resolve statically
// (string-literal specifiers). A production dependency that is reachable ONLY
// through a dynamic require — `require(variable)`, `require(path.join(...))`,
// template-literal specifiers — is silently excluded from the compiled binary
// and blows up at runtime with "Cannot find module".
//
// This test walks the runtime source (bin/ + lib/, excluding node_modules and
// generated files) and asserts every production dependency in package.json is
// required via at least one static string-literal `require('<dep>')`. That is
// the invariant that keeps the dependency bundleable — it is what currently
// keeps `fastest-levenshtein` (via lib/context-merge.js) inside the binary.
//
// Fast + deterministic: pure filesystem scan, no compile step.

const { test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const SCAN_ROOTS = ['bin', 'lib'];

const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const PROD_DEPS = Object.keys(pkg.dependencies || {});

/** Recursively collect *.js / *.mjs / *.cjs files under a root (skip generated). */
function collectSourceFiles(root) {
  const out = [];
  const abs = path.join(REPO, root);
  if (!fs.existsSync(abs)) return out;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (/\.(js|mjs|cjs)$/.test(e.name) && !e.name.includes('.generated.')) {
        out.push(full);
      }
    }
  };
  walk(abs);
  return out;
}

const SOURCE = collectSourceFiles(SCAN_ROOTS[0])
  .concat(collectSourceFiles(SCAN_ROOTS[1]))
  .map((f) => fs.readFileSync(f, 'utf8'))
  .join('\n');

/** True if `dep` is imported via a static string-literal require/import anywhere. */
function hasStaticImport(dep) {
  const d = dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`require\\(\\s*['"]${d}['"]`),
    new RegExp(`from\\s+['"]${d}['"]`),
    new RegExp(`import\\(\\s*['"]${d}['"]`),
  ];
  return patterns.some((re) => re.test(SOURCE));
}

test('production dependencies are statically requireable (bundleable by bun --compile)', () => {
  expect(PROD_DEPS.length).toBeGreaterThan(0);
  const missing = PROD_DEPS.filter((dep) => !hasStaticImport(dep));
  // Any production dep reachable only via a dynamic require would land here and
  // is a compiled-binary "Cannot find module" crash waiting to happen.
  expect(missing).toEqual([]);
});

test('fastest-levenshtein (context-merge path) is statically bundleable', () => {
  // Named explicitly because it is the dependency issue 53770b23 flagged.
  expect(hasStaticImport('fastest-levenshtein')).toBe(true);
});
