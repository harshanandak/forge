#!/usr/bin/env node
'use strict';

/**
 * Thin CLI over lib/package-budget.js: measures the published package with
 * `npm pack --dry-run --json --ignore-scripts`, compares it per block against
 * scripts/package-size-baseline.json, prints a report, and exits non-zero when
 * a budget is exceeded.
 *
 *   node scripts/package-size-check.js                     # check
 *   node scripts/package-size-check.js --write-baseline    # regenerate baseline
 *   node scripts/package-size-check.js --previous <file>   # base-branch baseline, marks acknowledged growth
 *   node scripts/package-size-check.js --pack-json <file>  # use captured pack output instead of running npm
 *
 * The report is also appended to $GITHUB_STEP_SUMMARY when that is set.
 * Bundled dependencies are only packed when node_modules is installed, so run
 * `bun install` first.
 */

const fs = require('node:fs');
const path = require('node:path');
const spawn = require('cross-spawn');
const budget = require('../lib/package-budget');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(__dirname, 'package-budgets.json');
const BASELINE_PATH = path.join(__dirname, 'package-size-baseline.json');
const MANIFEST_SOURCE = 'scripts/package-budgets.json';
const BASELINE_SOURCE = 'scripts/package-size-baseline.json';
const PREVIOUS_SOURCE = 'base-branch baseline (--previous)';
const PREVIOUS_FIX = 'the base branch must carry a valid scripts/package-size-baseline.json; regenerate it there with node scripts/package-size-check.js --write-baseline';

function runPack(cwd = ROOT) {
  const res = spawn.sync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`npm pack failed (exit ${res.status}): ${res.stderr}`);
  return res.stdout;
}

function readJson(file) {
  const text = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON (${error.message})`);
  }
}

// A missing --previous file means the base branch has no baseline yet. A file
// that exists but does not parse fails closed: ignoring it would silently
// skip the changed-baseline check.
function readOptionalJson(file) {
  if (!file || !fs.existsSync(file)) return null;
  return readJson(file);
}

function parseArgs(argv) {
  const opts = { writeBaseline: false, previous: null, packJson: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write-baseline') opts.writeBaseline = true;
    else if (arg === '--previous') opts.previous = argv[++i];
    else if (arg === '--pack-json') opts.packJson = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

// The validation boundary: every input is checked here before evaluateBudget
// sees it, and any malformed value throws (exit 2) instead of passing.
function check({ packText, manifest, baseline, previousBaseline = null }) {
  const validManifest = budget.validateManifest(manifest, { source: MANIFEST_SOURCE });
  const measured = budget.measureBlocks(budget.parsePackOutput(packText), validManifest);
  const result = budget.evaluateBudget({
    measured,
    baseline: budget.validateBaseline(baseline, { source: BASELINE_SOURCE }),
    previousBaseline: previousBaseline === null
      ? null
      : budget.validateBaseline(previousBaseline, { source: PREVIOUS_SOURCE, fix: PREVIOUS_FIX }),
    policy: validManifest.policy,
  });
  return { measured, result, report: budget.renderReport(result) };
}

function main(argv = process.argv.slice(2), env = process.env) {
  const opts = parseArgs(argv);
  const manifest = readJson(MANIFEST_PATH);
  const packText = opts.packJson ? fs.readFileSync(opts.packJson, 'utf8') : runPack();

  if (opts.writeBaseline) {
    const validManifest = budget.validateManifest(manifest, { source: MANIFEST_SOURCE });
    const measured = budget.measureBlocks(budget.parsePackOutput(packText), validManifest);
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(budget.buildBaseline(measured), null, 2)}\n`);
    console.log(`Wrote ${path.relative(ROOT, BASELINE_PATH)} (unpacked ${budget.formatBytes(measured.total.unpacked)}, ${measured.total.files} files)`);
    return 0;
  }

  const { result, report } = check({
    packText,
    manifest,
    baseline: readJson(BASELINE_PATH),
    previousBaseline: readOptionalJson(opts.previous),
  });
  console.log(report);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, report);
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`package-size-check: ${error.message}`);
    process.exitCode = 2;
  }
}

module.exports = { runPack, check, main, parseArgs, MANIFEST_PATH, BASELINE_PATH, ROOT };
