'use strict';

// Regression guard for kernel issue 931e7924: `forge shepherd watch` runs
// detached in the background and re-polls every ~60s. On Windows, any
// child_process spawn/execFileSync WITHOUT `windowsHide: true` flashes a visible
// console window every poll (Node defaults windowsHide to false), strobing the
// user's desktop. Background/detached/hook-reachable spawns must be silent.
//
// OS-specific window behaviour can't be asserted cross-platform, so this is a
// STRUCTURAL test: it reads the source of every background-reachable child
// process call site and asserts each spawn/execFileSync option object carries
// `windowsHide: true`. If a new call site is added to these modules without it,
// this test fails and points at the regression.

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/**
 * Count child_process invocations (execFileSync / spawn / spawnSync) in `source`
 * and how many carry `windowsHide`. We match the call keyword and require a
 * `windowsHide` token to appear before the statement's terminating `);` so every
 * spawning call is covered, not just the file as a whole.
 */
function spawnCallsMissingWindowsHide(source) {
  const missing = [];
  // Match the child_process call keywords. The trailing `[^)\s]` lookahead skips
  // bare `spawn()` mentions in prose/comments (empty arg list), which are never
  // real spawning calls, so comments don't produce false positives.
  const callRe = /\b(execFileSync|spawnSync|spawn)\s*\(\s*[^)\s]/g;
  let match;
  while ((match = callRe.exec(source)) !== null) {
    const start = match.index;
    // Grab a window of text covering the call's arguments (options object is the
    // last arg, always within a few hundred chars for these call sites).
    const slice = source.slice(start, start + 400);
    if (!/windowsHide/.test(slice)) {
      const line = source.slice(0, start).split(/\r?\n/).length;
      missing.push({ call: match[1], line });
    }
  }
  return missing;
}

// Every module below is reachable from the detached `forge shepherd watch`
// background process (or a detached spawn) and MUST keep windowsHide on all its
// child_process call sites.
const BACKGROUND_REACHABLE = [
  'lib/commands/shepherd.js',
  'lib/adapters/pr-state-adapter.js',
  'lib/pr-monitor/watch-lifecycle.js',
  'lib/pr-monitor/reconcile-executor.js',
  'lib/pr-monitor/upsert-sticky.js',
  'lib/adapters/greptile-review-adapter.js',
  'lib/commands/serve.js',
];

describe('windowsHide on background/detached child processes (issue 931e7924)', () => {
  for (const rel of BACKGROUND_REACHABLE) {
    test(`${rel}: every spawn/execFileSync sets windowsHide`, () => {
      const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const missing = spawnCallsMissingWindowsHide(source);
      expect(missing).toEqual([]);
    });
  }

  test('the detached shepherd watcher spawn itself is hidden', () => {
    const source = fs.readFileSync(
      path.join(ROOT, 'lib/pr-monitor/watch-lifecycle.js'),
      'utf8',
    );
    // The detached spawn that launches `forge shepherd watch` must be silent.
    expect(/detached:\s*true[\s\S]{0,120}windowsHide:\s*true/.test(source)).toBe(true);
  });
});
