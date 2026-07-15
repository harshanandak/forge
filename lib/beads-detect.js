'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Single-source, side-effect-free Beads-store detector (kernel issue a5399f3d).
//
// Both upgrade-safety surfaces reuse this ONE definition: the issue-path
// unmigrated-beads nudge (lib/commands/_issue.js) and the `forge upgrade`
// advisory (lib/upgrade-safety.js). It deliberately lives in a neutral module,
// NOT in lib/commands/migrate.js — re-exporting a `detectBeadsJsonlSource` name
// from the migrate command would revive the identifier the a7e1443c
// implicit-auto-migrate tombstone pins gone (test/commands/runtime-no-auto-migrate).
// This detector only READS the filesystem and never triggers a migration, so it
// honors that tombstone's spirit while giving both nudges a shared source.

function dirHasJsonl(dir) {
  try {
    return fs.readdirSync(dir).some(entry => entry.endsWith('.jsonl'));
  } catch (_err) {
    /* intentional: an unreadable directory has no usable jsonl */ // NOSONAR S2486
    return false;
  }
}

/**
 * Return the absolute path of the directory holding a returning user's Beads
 * JSONL under `projectRoot`, or null when none is found. Checks the top-level
 * `.beads/` first, then the split-store `.beads/backup/` layout (jsonl there and
 * nowhere else — a layout the migrator itself reads), so neither surface misses
 * it. Never throws.
 *
 * @param {string} [projectRoot]
 * @returns {string|null}
 */
function detectBeadsJsonlSource(projectRoot) {
  const root = projectRoot || process.cwd();
  const beadsDir = path.join(root, '.beads');
  try {
    if (!fs.existsSync(beadsDir)) {
      return null;
    }
    if (dirHasJsonl(beadsDir)) {
      return beadsDir;
    }
    const backupDir = path.join(beadsDir, 'backup');
    if (fs.existsSync(backupDir) && dirHasJsonl(backupDir)) {
      return backupDir;
    }
    return null;
  } catch (_err) {
    /* intentional: an unreadable project root has no detectable beads source */ // NOSONAR S2486
    return null;
  }
}

module.exports = {
  detectBeadsJsonlSource,
  dirHasJsonl,
};
