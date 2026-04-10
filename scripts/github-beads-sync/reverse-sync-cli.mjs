#!/usr/bin/env node
/**
 * CLI entry point for Beads → GitHub reverse sync.
 * Usage: node reverse-sync-cli.mjs <old-snapshot-jsonl-path> <new-snapshot-jsonl-path>
 *
 * @module scripts/github-beads-sync/reverse-sync-cli
 */

import { readFileSync } from 'node:fs';
import { handleBeadsClosed } from './reverse-sync.mjs';

const oldPath = process.argv[2];
const newPath = process.argv[3];

if (!oldPath || !newPath) {
  console.error('Usage: node reverse-sync-cli.mjs <old-snapshot-jsonl-path> <new-snapshot-jsonl-path>');
  process.exit(1);
}

const oldContent = readFileSync(oldPath, 'utf-8');
const newContent = readFileSync(newPath, 'utf-8');

const result = handleBeadsClosed(oldContent, newContent);
console.log(JSON.stringify(result, null, 2));

if (result.errors.length > 0) {
  console.error(`${result.errors.length} issue(s) failed to close on GitHub`);
  process.exit(1);
}

console.log(`Closed ${result.closed.length} GitHub issue(s), skipped ${result.skipped.length}`);
