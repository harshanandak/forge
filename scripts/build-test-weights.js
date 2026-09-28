#!/usr/bin/env node
'use strict';

// Rebuilds scripts/test-weights.json from a per-file CI timing CSV whose header
// has `file,windows_ms,ubuntu_ms,macos_ms` (extra columns are ignored). The
// weight table is generated, never hand-edited:
//
//   node scripts/build-test-weights.js --csv <per-file-os-compare.csv> \
//     --run-id <github run id> --date <YYYY-MM-DD>

const fs = require('node:fs');
const path = require('node:path');

const { comparePaths, normalizePath } = require('./lib/ci-shard-partition');

const DEFAULT_OUTPUT = path.join(__dirname, 'test-weights.json');
// CSV column -> weight-table OS key.
const CSV_COLUMNS = Object.freeze({ linux: 'ubuntu_ms', macos: 'macos_ms', windows: 'windows_ms' });

function parseArgs(argv) {
  const args = { output: DEFAULT_OUTPUT };
  for (let index = 0; index < argv.length; index += 1) {
    const next = argv[index + 1];
    if (argv[index] === '--csv') args.csv = next;
    if (argv[index] === '--run-id') args.runId = next;
    if (argv[index] === '--date') args.date = next;
    if (argv[index] === '--out') args.output = next;
  }
  for (const [flag, key] of [['--csv', 'csv'], ['--run-id', 'runId'], ['--date', 'date']]) {
    if (!args[key]) throw new Error(`${flag} is required`);
  }
  return args;
}

function parseTimingMs(value, file, column) {
  const ms = String(value ?? '').trim() === '' ? Number.NaN : Number(value);
  if (!Number.isFinite(ms) || ms < 0) throw new Error(`Invalid ${column} for ${file}: ${JSON.stringify(value)}`);
  return Math.round(ms);
}

function buildWeightTable(csvText, { date, runId }) {
  const [header, ...rows] = csvText.split(/\r?\n/).filter((line) => line.trim() !== '');
  const columns = header.split(',');
  const fileColumn = columns.indexOf('file');
  const osColumns = Object.entries(CSV_COLUMNS).map(([osName, column]) => {
    const index = columns.indexOf(column);
    if (index === -1) throw new Error(`CSV is missing the ${column} column`);
    return [osName, index, column];
  });
  if (fileColumn === -1) throw new Error('CSV is missing the file column');

  const entries = rows.map((row) => {
    const cells = row.split(',');
    const file = normalizePath(cells[fileColumn]);
    const weights = {};
    for (const [osName, index, column] of osColumns) weights[osName] = parseTimingMs(cells[index], file, column);
    return [file, weights];
  }).sort(([left], [right]) => comparePaths(left, right));

  return {
    version: 1,
    source: { date, runId: String(runId) },
    files: Object.fromEntries(entries),
  };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const table = buildWeightTable(fs.readFileSync(args.csv, 'utf8'), args);
  fs.writeFileSync(args.output, `${JSON.stringify(table, null, 2)}\n`);
  console.log(`Wrote ${Object.keys(table.files).length} file weights to ${args.output}`);
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`build-test-weights: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { buildWeightTable, parseArgs };
