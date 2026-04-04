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

/**
 * Reset command files to canonical state.
 *
 * @param {{ repoRoot: string, commandName?: string, all?: boolean, dryRun?: boolean }} options
 * @returns {{ reset: Array<{agent: string, file: string}>, skipped: Array<{agent: string, file: string}>, errors: string[] }}
 */
function resolveCanonicalCommandsDir(repoRoot) {
  const candidates = [
    path.join(repoRoot, 'commands'),
    path.join(repoRoot, '.claude', 'commands'),
  ];

  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

function resetCommands({ repoRoot, commandName, all, dryRun }) {
  const errors = [];
  const reset = [];
  const skipped = [];

  // Validate command name (OWASP A03 — injection prevention)
  if (commandName && !/^[a-z0-9-]+$/.test(commandName)) {
    errors.push(`Invalid command name: "${commandName}" — only lowercase letters, numbers, and hyphens allowed`);
    return { reset, skipped, errors };
  }

  // Check canonical source exists
  const canonicalDir = resolveCanonicalCommandsDir(repoRoot);
  if (!canonicalDir) {
    errors.push('Canonical source directory not found: commands/ or .claude/commands/');
    return { reset, skipped, errors };
  }

  if (commandName && !fs.existsSync(path.join(canonicalDir, `${commandName}.md`))) {
    const canonicalLabel = path.relative(repoRoot, canonicalDir).replace(/\\/g, '/');
    errors.push(`Command not found: ${canonicalLabel}/${commandName}.md`);
    return { reset, skipped, errors };
  }

  // Get planned sync entries
  const result = syncCommands({ dryRun: true, check: false, repoRoot });
  if (!result.planned || result.planned.length === 0) {
    return { reset, skipped, errors };
  }

  // Filter to target command if specified
  let entries = result.planned;
  if (commandName && !all) {
    entries = entries.filter(e =>
      e.filename.replace(/\.prompt\.md$|\.md$/, '') === commandName ||
      e.dir.includes(`/${commandName}/`)
    );
  }

  if (dryRun) {
    for (const entry of entries) {
      if (fs.existsSync(entry.filePath)) {
        const existing = fs.readFileSync(entry.filePath, 'utf8');
        if (contentHash(existing) !== contentHash(entry.content)) {
          reset.push({ agent: entry.agent, file: path.join(entry.dir, entry.filename) });
        } else {
          skipped.push({ agent: entry.agent, file: path.join(entry.dir, entry.filename) });
        }
      } else {
        reset.push({ agent: entry.agent, file: path.join(entry.dir, entry.filename) });
      }
    }
    return { reset, skipped, errors };
  }

  // Write mode — actually reset files
  for (const entry of entries) {
    const targetDir = path.dirname(entry.filePath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    if (fs.existsSync(entry.filePath)) {
      const existing = fs.readFileSync(entry.filePath, 'utf8');
      if (contentHash(existing) === contentHash(entry.content)) {
        skipped.push({ agent: entry.agent, file: path.join(entry.dir, entry.filename) });
        continue;
      }
    }
    fs.writeFileSync(entry.filePath, entry.content);
    reset.push({ agent: entry.agent, file: path.join(entry.dir, entry.filename) });
  }

  // Refresh the manifest using the full expected sync set without rewriting
  // unrelated command files that were intentionally excluded from this reset.
  writeSyncManifest(repoRoot, result.planned);

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
