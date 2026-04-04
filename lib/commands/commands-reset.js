'use strict';

/**
 * @module commands-reset
 *
 * Reset agent command files to match the canonical source (commands/*.md or .claude/commands/*.md).
 * Rebuilds adapted files via sync-commands and optionally writes them.
 *
 * Used by `forge commands reset [--dry-run] [--all] [command-name]`.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  syncCommands,
  contentHash,
  writeSyncManifest,
} = require('../../scripts/sync-commands.js');

function resolveCanonicalCommandsDir(repoRoot) {
  const candidates = [
    path.join(repoRoot, 'commands'),
    path.join(repoRoot, '.claude', 'commands'),
  ];

  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

function validateCommandName(commandName) {
  if (commandName && !/^[a-z0-9-]+$/.test(commandName)) {
    return [`Invalid command name: "${commandName}" - only lowercase letters, numbers, and hyphens allowed`];
  }

  return [];
}

function ensureCanonicalCommandExists(repoRoot, canonicalDir, commandName) {
  if (!commandName) {
    return [];
  }

  if (fs.existsSync(path.join(canonicalDir, `${commandName}.md`))) {
    return [];
  }

  const canonicalLabel = path.relative(repoRoot, canonicalDir).replaceAll('\\', '/');
  return [`Command not found: ${canonicalLabel}/${commandName}.md`];
}

function filterPlannedEntries(entries, commandName, all) {
  if (commandName && all !== true) {
    return entries.filter(entry =>
      entry.filename.replaceAll('.prompt.md', '').replaceAll('.md', '') === commandName ||
      entry.dir.includes(`/${commandName}/`)
    );
  }

  return entries;
}

function recordEntryResult(entry, reset, skipped, dryRun) {
  const relativeFile = path.join(entry.dir, entry.filename);

  if (dryRun) {
    if (fs.existsSync(entry.filePath)) {
      const existing = fs.readFileSync(entry.filePath, 'utf8');
      if (contentHash(existing) === contentHash(entry.content)) {
        skipped.push({ agent: entry.agent, file: relativeFile });
      } else {
        reset.push({ agent: entry.agent, file: relativeFile });
      }
    } else {
      reset.push({ agent: entry.agent, file: relativeFile });
    }
    return;
  }

  const targetDir = path.dirname(entry.filePath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  if (fs.existsSync(entry.filePath)) {
    const existing = fs.readFileSync(entry.filePath, 'utf8');
    if (contentHash(existing) === contentHash(entry.content)) {
      skipped.push({ agent: entry.agent, file: relativeFile });
      return;
    }
  }

  fs.writeFileSync(entry.filePath, entry.content);
  reset.push({ agent: entry.agent, file: relativeFile });
}

function resetCommands({ repoRoot, commandName, all, dryRun }) {
  const errors = [];
  const reset = [];
  const skipped = [];

  errors.push(...validateCommandName(commandName));
  if (errors.length > 0) {
    return { reset, skipped, errors };
  }

  const canonicalDir = resolveCanonicalCommandsDir(repoRoot);
  if (!canonicalDir) {
    errors.push('Canonical source directory not found: commands/ or .claude/commands/');
    return { reset, skipped, errors };
  }

  errors.push(...ensureCanonicalCommandExists(repoRoot, canonicalDir, commandName));
  if (errors.length > 0) {
    return { reset, skipped, errors };
  }

  const result = syncCommands({ dryRun: true, check: false, repoRoot });
  if (!result.planned || result.planned.length === 0) {
    return { reset, skipped, errors };
  }

  const entries = filterPlannedEntries(result.planned, commandName, all);
  for (const entry of entries) {
    recordEntryResult(entry, reset, skipped, dryRun);
  }

  if (!dryRun) {
    // Refresh the manifest using the full expected sync set without rewriting
    // unrelated command files that were intentionally excluded from this reset.
    writeSyncManifest(repoRoot, result.planned);
  }

  return { reset, skipped, errors };
}

module.exports = {
  name: 'commands-reset',
  description: 'Reset generated agent command files to canonical content',
  handler: async (args, flags, repoRoot) => {
    const commandName = args.find(arg => !arg.startsWith('-'));
    const result = resetCommands({
      repoRoot,
      commandName,
      all: Boolean(flags.all),
      dryRun: Boolean(flags.dryRun),
    });

    if (result.errors.length > 0) {
      return { success: false, error: result.errors.join('; ') };
    }

    return { success: true, ...result };
  },
  resetCommands,
  resolveCanonicalCommandsDir,
};
