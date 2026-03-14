#!/usr/bin/env node

/**
 * @module sync-commands
 *
 * Utility for parsing and rebuilding YAML frontmatter in
 * `.claude/commands/*.md` files.
 *
 * Exports:
 *   parseFrontmatter(content) -> { frontmatter: object, body: string }
 *   buildFile(frontmatter, body) -> string
 */

const YAML = require('yaml');

/**
 * Parse YAML frontmatter from a markdown string.
 *
 * Frontmatter is the YAML block between two `---` markers at the very start
 * of the file. If no valid frontmatter block is found, returns an empty object
 * with the full content as the body.
 *
 * @param {string} content - The raw file content
 * @returns {{ frontmatter: Record<string, unknown>, body: string }}
 */
function parseFrontmatter(content) {
  // Frontmatter must start at the very beginning with ---
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return { frontmatter: {}, body: content };
  }

  // Find the closing --- marker (skip the opening one)
  const openLen = content.startsWith('---\r\n') ? 5 : 4; // '---\n' or '---\r\n'
  const closeIndex = content.indexOf('\n---\n', openLen - 1);
  const closeIndexCRLF = content.indexOf('\r\n---\r\n', openLen - 1);

  let yamlStr;
  let bodyStart;

  if (closeIndex === -1 && closeIndexCRLF === -1) {
    // Check for --- at end of file (no trailing newline after closing ---)
    const closeAtEnd = content.indexOf('\n---', openLen - 1);
    if (closeAtEnd !== -1 && closeAtEnd + 4 === content.length) {
      yamlStr = content.slice(openLen, closeAtEnd + 1);
      bodyStart = content.length;
    } else {
      // No closing --- found — no valid frontmatter
      return { frontmatter: {}, body: content };
    }
  } else if (closeIndex !== -1 && (closeIndexCRLF === -1 || closeIndex < closeIndexCRLF)) {
    // LF line endings
    yamlStr = content.slice(openLen, closeIndex + 1);
    bodyStart = closeIndex + 5; // skip '\n---\n'
  } else {
    // CRLF line endings
    yamlStr = content.slice(openLen, closeIndexCRLF + 2);
    bodyStart = closeIndexCRLF + 7; // skip '\r\n---\r\n'
  }

  // Parse the YAML string
  const trimmed = yamlStr.trim();
  if (trimmed === '') {
    return { frontmatter: {}, body: content.slice(bodyStart) };
  }

  /** @type {Record<string, unknown>} */
  let frontmatter;
  try {
    frontmatter = YAML.parse(trimmed);
  } catch (_err) {
    // If YAML parsing fails, treat as no frontmatter
    return { frontmatter: {}, body: content };
  }

  // YAML.parse can return null for empty docs or a scalar for non-object input
  if (frontmatter === null || typeof frontmatter !== 'object') {
    return { frontmatter: {}, body: content };
  }

  return { frontmatter, body: content.slice(bodyStart) };
}

/**
 * Build a file string from frontmatter and body.
 *
 * Produces output in the format:
 * ```
 * ---
 * key: value
 * ---
 * body content
 * ```
 *
 * @param {Record<string, unknown>} frontmatter - Key-value pairs for the YAML block
 * @param {string} body - The markdown body content
 * @returns {string} The reconstructed file content
 */
function buildFile(frontmatter, body) {
  const keys = Object.keys(frontmatter);

  let yamlBlock;
  if (keys.length === 0) {
    yamlBlock = '';
  } else {
    yamlBlock = YAML.stringify(frontmatter, {
      lineWidth: 0,       // Prevent line wrapping
      defaultKeyType: 'PLAIN',
      defaultStringType: 'PLAIN',
    }).trimEnd();
    yamlBlock += '\n';
  }

  return `---\n${yamlBlock}---\n${body}`;
}

// ---- Agent adapters -------------------------------------------------------------

/**
 * @typedef {Object} AgentAdapter
 * @property {(commandName: string) => string} dir - Target directory path for a specific command
 * @property {string} baseDir - Base output directory for this agent (no sentinel needed)
 * @property {string} extension - File extension (e.g. '.md', '.prompt.md')
 * @property {(fm: Record<string, unknown>, commandName: string) => Record<string, unknown>} transformFrontmatter
 * @property {boolean} [skip] - If true, agent is canonical source (no sync needed)
 */

/**
 * Strip all frontmatter — return empty object.
 *
 * @param {Record<string, unknown>} _fm
 * @param {string} _commandName
 * @returns {Record<string, unknown>}
 */
function stripAllFrontmatter(_fm, _commandName) {
  return {};
}

/**
 * Keep only `description` from frontmatter.
 *
 * @param {Record<string, unknown>} fm
 * @param {string} _commandName
 * @returns {Record<string, unknown>}
 */
function keepDescription(fm, _commandName) {
  /** @type {Record<string, unknown>} */
  const result = {};
  if (fm.description !== undefined) {
    result.description = fm.description;
  }
  return result;
}

/**
 * Keep `description`, add `mode: code`.
 *
 * @param {Record<string, unknown>} fm
 * @param {string} _commandName
 * @returns {Record<string, unknown>}
 */
function keepDescriptionAddMode(fm, _commandName) {
  /** @type {Record<string, unknown>} */
  const result = {};
  if (fm.description !== undefined) {
    result.description = fm.description;
  }
  result.mode = 'code';
  return result;
}

/**
 * GitHub Copilot transform: add `name`, keep `description`, add `tools`.
 *
 * @param {Record<string, unknown>} fm
 * @param {string} commandName
 * @returns {Record<string, unknown>}
 */
function copilotTransform(fm, commandName) {
  /** @type {Record<string, unknown>} */
  const result = {};
  result.name = commandName;
  if (fm.description !== undefined) {
    result.description = fm.description;
  }
  result.tools = Array.isArray(fm.tools) ? fm.tools : [];
  return result;
}

/**
 * Agent adapter configuration for command sync.
 *
 * Each entry maps an agent slug to its target directory, file extension,
 * and frontmatter transform function.
 *
 * @type {Record<string, AgentAdapter>}
 */
const AGENT_ADAPTERS = {
  'claude-code': {
    dir: () => '.claude/commands/',
    baseDir: '.claude/commands/',
    extension: '.md',
    transformFrontmatter: (fm) => ({ ...fm }),
    skip: true,
  },
  cursor: {
    dir: () => '.cursor/commands/',
    baseDir: '.cursor/commands/',
    extension: '.md',
    transformFrontmatter: stripAllFrontmatter,
  },
  cline: {
    dir: () => '.clinerules/workflows/',
    baseDir: '.clinerules/workflows/',
    extension: '.md',
    transformFrontmatter: stripAllFrontmatter,
  },
  opencode: {
    dir: () => '.opencode/commands/',
    baseDir: '.opencode/commands/',
    extension: '.md',
    transformFrontmatter: keepDescription,
  },
  'github-copilot': {
    dir: () => '.github/prompts/',
    baseDir: '.github/prompts/',
    extension: '.prompt.md',
    transformFrontmatter: copilotTransform,
  },
  'kilo-code': {
    dir: () => '.kilocode/workflows/',
    baseDir: '.kilocode/workflows/',
    extension: '.md',
    transformFrontmatter: keepDescriptionAddMode,
  },
  'roo-code': {
    dir: () => '.roo/commands/',
    baseDir: '.roo/commands/',
    extension: '.md',
    transformFrontmatter: keepDescriptionAddMode,
  },
  codex: {
    dir: (commandName) => `.codex/skills/${commandName}/`,
    baseDir: '.codex/skills/',
    extension: '.md',
    transformFrontmatter: keepDescription,
  },
};

/**
 * Adapt a command file for a specific agent.
 *
 * Applies the agent's frontmatter transform and returns the target
 * filename, directory, and rebuilt file content.
 *
 * @param {string} agentName - Agent slug (e.g. 'cursor', 'claude-code')
 * @param {Record<string, unknown>} frontmatter - Parsed frontmatter object
 * @param {string} body - Markdown body content (after frontmatter)
 * @param {string} commandName - Command name (e.g. 'plan', 'dev', 'status')
 * @returns {{ content: string, filename: string, dir: string } | null}
 *   null if the agent is skipped (canonical source)
 * @throws {Error} If agentName is not a known agent
 */
function adaptForAgent(agentName, frontmatter, body, commandName) {
  const adapter = AGENT_ADAPTERS[agentName];
  if (!adapter) {
    throw new Error(`Unknown agent: "${agentName}". Known agents: ${Object.keys(AGENT_ADAPTERS).join(', ')}`);
  }

  if (adapter.skip) {
    return null;
  }

  const transformed = adapter.transformFrontmatter(frontmatter, commandName);
  const hasKeys = Object.keys(transformed).length > 0;

  // Build content: if frontmatter is empty, output body only (no --- markers)
  const content = hasKeys ? buildFile(transformed, body) : body;

  // Determine filename — Codex uses SKILL.md, others use <commandName>.<ext>
  let filename;
  if (agentName === 'codex') {
    filename = `SKILL${adapter.extension}`;
  } else {
    filename = `${commandName}${adapter.extension}`;
  }

  return {
    content,
    filename,
    dir: adapter.dir(commandName),
  };
}

// ---- Sync logic -----------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Compute a content hash for change detection.
 * Normalizes line endings to LF before hashing to avoid CRLF/LF mismatches
 * on Windows (git checkout converts LF to CRLF on Windows).
 *
 * @param {string} content
 * @returns {string} hex digest
 */
function contentHash(content) {
  const normalized = content.replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * @typedef {Object} SyncEntry
 * @property {string} agent - Agent slug
 * @property {string} dir - Relative directory path
 * @property {string} filename - Output filename
 * @property {string} content - Generated file content
 * @property {string} filePath - Full absolute path to the output file
 */

/**
 * @typedef {Object} SyncResult
 * @property {SyncEntry[]} [planned] - (dry-run) entries that would be written
 * @property {SyncEntry[]} [written] - (write mode) entries that were written
 * @property {SyncEntry[]} [overwritten] - (write mode) entries that overwrote manually modified files
 * @property {boolean} [inSync] - (check mode) whether all files match
 * @property {SyncEntry[]} [outOfSync] - (check mode) entries that differ from expected
 * @property {string[]} [staleFiles] - (check mode) files on disk that are no longer generated
 * @property {boolean} [empty] - (check mode) true when no commands found in canonical source
 * @property {boolean} [manifestMissing] - (check mode) true when sync manifest not found
 */

/**
 * Sync .claude/commands/*.md files to all non-skip agent directories.
 *
 * Modes:
 * - `dryRun: true` — returns planned writes without touching the filesystem
 * - `check: true` — compares generated content with existing files, reports mismatches
 * - default (both false) — writes files, creating directories as needed
 *
 * @param {{ dryRun: boolean, check: boolean, repoRoot: string }} options
 * @returns {SyncResult}
 */
function syncCommands({ dryRun, check, repoRoot }) {
  const commandsDir = path.join(repoRoot, '.claude', 'commands');

  // Read all .md files from the commands directory
  /** @type {string[]} */
  let commandFiles = [];
  if (fs.existsSync(commandsDir)) {
    commandFiles = fs.readdirSync(commandsDir)
      .filter((f) => f.endsWith('.md'))
      .sort();
  }

  // Build the list of all files to generate
  /** @type {SyncEntry[]} */
  const entries = [];

  for (const file of commandFiles) {
    const commandName = file.replace(/\.md$/, '');
    const filePath = path.join(commandsDir, file);
    const raw = fs.readFileSync(filePath, 'utf8');
    const { frontmatter, body } = parseFrontmatter(raw);

    for (const agentName of Object.keys(AGENT_ADAPTERS)) {
      const adapted = adaptForAgent(agentName, frontmatter, body, commandName);
      if (adapted === null) {
        continue; // skip canonical agent
      }

      const targetDir = path.join(repoRoot, adapted.dir);
      const targetPath = path.join(targetDir, adapted.filename);

      entries.push({
        agent: agentName,
        dir: adapted.dir,
        filename: adapted.filename,
        content: adapted.content,
        filePath: targetPath,
      });
    }
  }

  // ---- dry-run mode ----
  if (dryRun) {
    return { planned: entries };
  }

  // ---- check mode ----
  if (check) {
    // Warn when no commands exist (could mask a misconfigured path)
    if (commandFiles.length === 0) {
      return { inSync: false, outOfSync: [], empty: true };
    }

    /** @type {SyncEntry[]} */
    const outOfSync = [];

    for (const entry of entries) {
      if (!fs.existsSync(entry.filePath)) {
        outOfSync.push(entry);
        continue;
      }
      const existing = fs.readFileSync(entry.filePath, 'utf8');
      if (contentHash(existing) !== contentHash(entry.content)) {
        outOfSync.push(entry);
      }
    }

    // Detect stale files using the sync manifest (.forge/sync-manifest.json).
    // The manifest records every file path the sync script generated on the last
    // write run. Stale = in manifest but NOT in current expected set.
    // This avoids false positives on custom files — only files sync created are tracked.
    const expectedPaths = new Set(entries.map((e) => e.filePath));
    /** @type {string[]} */
    const staleFiles = [];

    const manifestPath = path.join(repoRoot, '.forge', 'sync-manifest.json');
    let manifestMissing = false;
    if (!fs.existsSync(manifestPath)) {
      manifestMissing = true;
    }
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const previousPaths = manifest.files || [];
        for (const prevPath of previousPaths) {
          const absPath = path.resolve(repoRoot, prevPath);
          if (!expectedPaths.has(absPath) && fs.existsSync(absPath)) {
            staleFiles.push(absPath);
          }
        }
      } catch (_err) {
        // Corrupt manifest — skip stale detection, don't fail
      }
    }

    return {
      inSync: outOfSync.length === 0 && staleFiles.length === 0,
      outOfSync,
      staleFiles,
      manifestMissing,
    };
  }

  // ---- write mode (default) ----

  // Migrate flat files to directories where needed.
  // Cline: .clinerules (flat file) → .clinerules/default-rules.md
  // This follows Cline's own migration pattern (ensureLocalClineDirExists).
  const clinerules = path.join(repoRoot, '.clinerules');
  if (fs.existsSync(clinerules) && fs.statSync(clinerules).isFile()) {
    const content = fs.readFileSync(clinerules, 'utf8');
    // Atomic migration: write backup first, then remove original, then create dir.
    // If interrupted after backup but before dir creation, backup file preserves data.
    const backupPath = path.join(repoRoot, `.clinerules.sync-backup-${Date.now()}`);
    fs.writeFileSync(backupPath, content);
    fs.unlinkSync(clinerules);
    fs.mkdirSync(clinerules, { recursive: true });
    fs.writeFileSync(path.join(clinerules, 'default-rules.md'), content);
    fs.unlinkSync(backupPath);
  }

  /** @type {SyncEntry[]} */
  const written = [];
  /** @type {SyncEntry[]} */
  const overwritten = [];

  for (const entry of entries) {
    const targetDir = path.dirname(entry.filePath);

    // Check if existing file has been manually modified
    if (fs.existsSync(entry.filePath)) {
      const existing = fs.readFileSync(entry.filePath, 'utf8');
      if (contentHash(existing) !== contentHash(entry.content)) {
        overwritten.push(entry);
      }
    }

    // Create directory if needed
    fs.mkdirSync(targetDir, { recursive: true });

    // Write the file
    fs.writeFileSync(entry.filePath, entry.content);
    written.push(entry);
  }

  // Write sync manifest — records every file generated so stale detection
  // can identify orphaned files without false-flagging custom files.
  const manifestDir = path.join(repoRoot, '.forge');
  fs.mkdirSync(manifestDir, { recursive: true });
  const manifestData = {
    generatedAt: new Date().toISOString(),
    files: written.map((e) => path.relative(repoRoot, e.filePath).replace(/\\/g, '/')),
  };
  fs.writeFileSync(
    path.join(manifestDir, 'sync-manifest.json'),
    JSON.stringify(manifestData, null, 2) + '\n'
  );

  return { written, overwritten };
}

// ---- CLI entry point -------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const check = args.includes('--check');

  if (dryRun && check) {
    console.error('Error: --dry-run and --check cannot be used together.');
    process.exit(1);
  }

  const repoRoot = path.resolve(__dirname, '..');

  const result = syncCommands({ dryRun, check, repoRoot });

  if (dryRun) {
    if (result.planned.length === 0) {
      console.log('No command files found in .claude/commands/');
    } else {
      console.log('Dry run — files that would be generated:\n');
      for (const entry of result.planned) {
        console.log(`  [${entry.agent}] ${path.join(entry.dir, entry.filename)}`);
      }
      console.log(`\nTotal: ${result.planned.length} files`);
    }
  } else if (check) {
    if (result.empty) {
      console.error('Error: no command files found in .claude/commands/ — cannot verify sync.');
      process.exit(1);
    }
    if (result.manifestMissing) {
      console.warn('Warning: .forge/sync-manifest.json not found — stale file detection skipped.');
      console.warn('Run "node scripts/sync-commands.js" to generate the manifest.\n');
    }
    if (result.inSync) {
      console.log('All agent command files are in sync.');
      process.exit(0);
    } else {
      if (result.outOfSync.length > 0) {
        console.log('Out of sync — the following files differ from expected:\n');
        for (const entry of result.outOfSync) {
          const exists = fs.existsSync(entry.filePath);
          const status = exists ? 'modified' : 'missing';
          console.log(`  [${entry.agent}] ${path.join(entry.dir, entry.filename)} (${status})`);
        }
      }
      if (result.staleFiles && result.staleFiles.length > 0) {
        console.log('\nStale files (no longer generated, should be removed):\n');
        for (const f of result.staleFiles) {
          console.log(`  ${path.relative(repoRoot, f)}`);
        }
      }
      const total = result.outOfSync.length + (result.staleFiles ? result.staleFiles.length : 0);
      console.log(`\n${total} issue(s) found.`);
      process.exit(1);
    }
  } else {
    // Write mode
    if (result.overwritten.length > 0) {
      console.log('Warning — overwriting manually modified files:\n');
      for (const entry of result.overwritten) {
        console.log(`  [${entry.agent}] ${path.join(entry.dir, entry.filename)}`);
      }
      console.log('');
    }

    if (result.written.length === 0) {
      console.log('No command files found in .claude/commands/');
    } else {
      console.log(`Synced ${result.written.length} file(s) across agents.`);
    }
  }
}

module.exports = { parseFrontmatter, buildFile, AGENT_ADAPTERS, adaptForAgent, syncCommands };
