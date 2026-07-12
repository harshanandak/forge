'use strict';

// Completeness / drift guard for the single-binary embed set (no compile needed).
// Walks ASSET_ROOTS on disk, regenerates the embed set in-memory, and asserts the
// embed set == the on-disk asset set BOTH ways, plus that every critical setup
// consumer's source file is embedded and that embedded text bytes are LF-only.
// A new skill/rule/script file that would silently ship un-embedded fails here.

const { test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const { ASSET_ROOTS, DISK_PACKAGE_ROOT } = require('../lib/package-root');
const { collectAssetFiles, isExecutableAsset } = require('../scripts/gen-embedded-assets.mjs');
const { ESSENTIAL_DOCS } = require('../lib/docs-copy');

const REPO = DISK_PACKAGE_ROOT;

/** Independent recursive walk (posix rel paths) — must agree with collectAssetFiles. */
function independentWalk(root, roots) {
  const out = [];
  const visit = (abs, rel) => {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(abs)) visit(path.join(abs, e), `${rel}/${e}`);
    } else if (st.isFile()) {
      out.push(rel);
    }
  };
  for (const r of roots) {
    const abs = path.join(root, r);
    if (!fs.existsSync(abs)) continue;
    visit(abs, r.split(path.sep).join('/'));
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

test('embed set == on-disk asset set (both directions)', () => {
  const embed = collectAssetFiles(REPO, ASSET_ROOTS);
  const disk = independentWalk(REPO, ASSET_ROOTS);

  expect(embed.length).toBeGreaterThan(0);
  // Forward: every on-disk asset is embedded.
  expect(new Set(embed)).toEqual(new Set(disk));
  // Reverse: every embedded entry exists on disk.
  for (const rel of embed) {
    expect(fs.existsSync(path.join(REPO, ...rel.split('/')))).toBe(true);
  }
});

test('every critical setup consumer source is in the embed set (guards a dropped ASSET_ROOT)', () => {
  const embed = new Set(collectAssetFiles(REPO, ASSET_ROOTS));

  // AGENTS.md workflow contract.
  expect(embed.has('AGENTS.md')).toBe(true);

  // Essential docs copied by copyEssentialDocs — mirror its own existence guard
  // (it reads docs/<doc> and skips when absent). If/when a source appears on
  // disk it MUST be embedded; today docs/<doc> do not exist (they live under
  // docs/reference/ + docs/forge/), so copyEssentialDocs is a no-op in both
  // channels and parity holds. See kernel follow-up on the source-path mismatch.
  for (const doc of ESSENTIAL_DOCS) {
    if (fs.existsSync(path.join(REPO, 'docs', doc))) {
      expect(embed.has(`docs/${doc}`)).toBe(true);
    }
  }

  // Hook scripts installed by installForgeHookScripts.
  expect(embed.has('.forge/hooks/check-tdd.js')).toBe(true);
  expect(embed.has('.forge/hooks/forge-native-hook.js')).toBe(true);

  // load-env.sh + the forge-team entry script (`forge team`).
  expect(embed.has('.claude/scripts/load-env.sh')).toBe(true);
  expect(embed.has('scripts/forge-team/index.sh')).toBe(true);

  // Every canonical skill's SKILL.md and every canonical rule is embedded.
  const skillsDir = path.join(REPO, 'skills');
  for (const name of fs.readdirSync(skillsDir)) {
    const skillFile = path.join(skillsDir, name, 'SKILL.md');
    if (fs.existsSync(skillFile)) expect(embed.has(`skills/${name}/SKILL.md`)).toBe(true);
  }
  const rulesDir = path.join(REPO, 'rules');
  for (const f of fs.readdirSync(rulesDir)) {
    if (f.endsWith('.md')) expect(embed.has(`rules/${f}`)).toBe(true);
  }
});

test('executable assets are exactly the .sh + .forge/hooks files', () => {
  const embed = collectAssetFiles(REPO, ASSET_ROOTS);
  for (const rel of embed) {
    const exec = isExecutableAsset(rel);
    const expected = rel.endsWith('.sh') || rel.startsWith('.forge/hooks/');
    expect(exec).toBe(expected);
  }
});

test('embedded text assets are LF-only (no CRLF) so cross-platform embed bytes match', () => {
  const TEXT = new Set(['.md', '.sh', '.js', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.txt']);
  const embed = collectAssetFiles(REPO, ASSET_ROOTS);
  const offenders = [];
  for (const rel of embed) {
    if (!TEXT.has(path.extname(rel))) continue;
    const buf = fs.readFileSync(path.join(REPO, ...rel.split('/')));
    if (buf.includes(0x0d)) offenders.push(rel); // CR byte present
  }
  expect(offenders).toEqual([]);
});
