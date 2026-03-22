/**
 * Husky detection and automated migration to Lefthook.
 *
 * Detects existing Husky installations, maps hook scripts to Lefthook format,
 * and orchestrates a safe migration with symlink validation (OWASP A08).
 *
 * @module lib/husky-migration
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

/**
 * Resolve a command to its full path to avoid relying on inherited PATH.
 * Falls back to the command name if resolution fails.
 * @param {string} command
 * @returns {string}
 */
function resolveCommand(command) {
  const resolver = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const result = spawnSync(resolver, [command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim().split(/\r?\n/)[0].trim();
    }
  } catch (_e) {
    // Expected: command resolution may fail if 'which'/'where.exe' is unavailable — fall back to bare command name
  }
  return command;
}

/**
 * Known hook-command patterns that can be auto-mapped to Lefthook.
 * Each entry: { pattern: RegExp, name: string|function, run: string|function }
 *
 * @type {Array<{pattern: RegExp, name: string|((m: RegExpMatchArray) => string), run: string|((m: RegExpMatchArray) => string)}>}
 */
const KNOWN_PATTERNS = [
  {
    pattern: /^npx\s+lint-staged$/m,
    name: 'lint-staged',
    run: 'npx lint-staged',
  },
  {
    pattern: /^npx\s+(?:--no\s+--\s+)?commitlint\s+--edit\s+\$\{?1\}?$/m,
    name: 'commitlint',
    run: 'npx --no -- commitlint --edit {1}',
  },
  {
    // npm run <script>, yarn run <script>, bun run <script>, pnpm run <script>
    pattern: /^(npm|yarn|bun|pnpm)\s+run\s+(\S+)$/m,
    name: (m) => m[2],
    run: (m) => `${m[1]} run ${m[2]}`,
  },
  {
    // npx <tool> (simple single-command invocations, no pipes/conditionals)
    pattern: /^npx\s+(\S+)$/m,
    name: (m) => m[1],
    run: (m) => `npx ${m[1]}`,
  },
];

/**
 * Files/directories inside .husky/ that are internal to Husky and should be skipped.
 * @type {Set<string>}
 */
const HUSKY_INTERNAL = new Set(['_', '.gitignore', 'husky.sh']);

/**
 * Detect whether Husky is installed in a project.
 *
 * @param {string} projectRoot - Absolute path to the project root.
 * @returns {{ found: boolean, huskyDir: string|null, hasHooksPath: boolean }}
 */
function detectHusky(projectRoot) {
  const huskyDir = path.join(projectRoot, '.husky');
  const found = fs.existsSync(huskyDir) && fs.statSync(huskyDir).isDirectory();

  if (!found) {
    return { found: false, huskyDir: null, hasHooksPath: false };
  }

  // Check for core.hooksPath in .git/config
  let hasHooksPath = false;
  const gitConfigPath = path.join(projectRoot, '.git', 'config');
  if (fs.existsSync(gitConfigPath)) {
    try {
      const gitConfig = fs.readFileSync(gitConfigPath, 'utf8');
      hasHooksPath = /hooksPath\s*=/.test(gitConfig);
    } catch (_err) {
      // Expected: .git/config may be unreadable or malformed — assume no hooksPath is configured
    }
  }

  return { found: true, huskyDir, hasHooksPath };
}

/**
 * Strip Husky boilerplate (shebang, sourcing _/husky.sh, blank lines) from hook content.
 *
 * @param {string} content - Raw hook file content.
 * @returns {string} Cleaned command lines.
 */
function stripHuskyBoilerplate(content) {
  return content
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (trimmed.startsWith('#!')) return false;
      if (trimmed.startsWith('. "$(dirname')) return false;
      if (trimmed.startsWith('# ')) return false;
      return true;
    })
    .join('\n')
    .trim();
}

/**
 * Try to match a cleaned hook body against known auto-mappable patterns.
 *
 * @param {string} body - Cleaned hook body (no shebang/boilerplate).
 * @returns {{ name: string, run: string } | null} Mapped command or null.
 */
function matchKnownPattern(body) {
  for (const entry of KNOWN_PATTERNS) {
    const m = entry.pattern.exec(body);
    if (m) {
      const name = typeof entry.name === 'function' ? entry.name(m) : entry.name;
      const run = typeof entry.run === 'function' ? entry.run(m) : entry.run;
      return { name, run };
    }
  }
  return null;
}

/**
 * Determine if a hook body is "complex" — contains conditionals, pipes, loops, etc.
 *
 * @param {string} body - Cleaned hook body.
 * @returns {boolean}
 */
function isComplexScript(body) {
  // Multiple non-blank lines that aren't a single command
  const lines = body.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length > 1) return true;

  // Contains shell constructs
  if (/\b(if|then|else|fi|for|while|do|done|case|esac)\b/.test(body)) return true;
  if (/[|&;]/.test(body) && !/^npx\s+--no\s+--/.test(body)) return true;

  return false;
}

/**
 * Parse a single hook file and classify it as mapped or unmapped.
 *
 * @param {string} huskyDir - Absolute path to .husky/ directory.
 * @param {string} hookName - Name of the hook file (e.g., "pre-commit").
 * @param {Array<{hook: string, name: string, run: string}>} mapped - Accumulator for mapped hooks.
 * @param {Array<{hook: string, reason: string}>} unmapped - Accumulator for unmapped hooks.
 */
function parseHookFile(huskyDir, hookName, mapped, unmapped) {
  const filePath = path.join(huskyDir, hookName);

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (_err) {
    // Expected: hook file may be unreadable due to permissions — report as unmapped
    unmapped.push({ hook: hookName, reason: `Cannot read file: ${_err.message}` });
    return;
  }

  const body = stripHuskyBoilerplate(content);
  if (!body) {
    // Empty hook — skip silently
    return;
  }

  const match = matchKnownPattern(body);
  if (match) {
    mapped.push({ hook: hookName, name: match.name, run: match.run });
  } else if (isComplexScript(body)) {
    unmapped.push({
      hook: hookName,
      reason: `Complex script with conditionals/multiple commands — requires manual conversion`,
    });
  } else {
    // Single unknown command — still try to map it literally
    const singleLine = body.split('\n')[0].trim();
    if (singleLine) {
      mapped.push({ hook: hookName, name: hookName, run: singleLine });
    } else {
      unmapped.push({ hook: hookName, reason: 'Unrecognized command pattern' });
    }
  }
}

/**
 * Read .husky/ hook files and map them to Lefthook format.
 *
 * @param {string} huskyDir - Absolute path to .husky/ directory.
 * @returns {{ mapped: Array<{hook: string, name: string, run: string}>, unmapped: Array<{hook: string, reason: string}> }}
 */
function mapHuskyHooks(huskyDir) {
  const mapped = [];
  const unmapped = [];

  let entries;
  try {
    entries = fs.readdirSync(huskyDir, { withFileTypes: true });
  } catch (_err) {
    // Expected: .husky/ directory may be unreadable — return empty results
    return { mapped, unmapped };
  }

  for (const entry of entries) {
    // Skip internal Husky files/directories
    if (HUSKY_INTERNAL.has(entry.name)) continue;
    if (entry.isDirectory()) continue;
    parseHookFile(huskyDir, entry.name, mapped, unmapped);
  }

  return { mapped, unmapped };
}

/**
 * Validate that all files in .husky/ are regular files, not symlinks.
 * OWASP A08: Rejects symlinks to prevent path traversal attacks.
 *
 * @param {string} huskyDir - Absolute path to .husky/ directory.
 * @returns {{ valid: boolean, symlinkFiles: string[] }}
 */
function validateNoSymlinks(huskyDir) {
  const symlinkFiles = [];

  let entries;
  try {
    entries = fs.readdirSync(huskyDir, { withFileTypes: true });
  } catch (_err) {
    // Expected: .husky/ directory may be unreadable — treat as valid since we cannot detect symlinks
    return { valid: true, symlinkFiles };
  }

  for (const entry of entries) {
    if (HUSKY_INTERNAL.has(entry.name)) continue;
    if (entry.isDirectory()) continue;

    const filePath = path.join(huskyDir, entry.name);
    try {
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink()) {
        symlinkFiles.push(entry.name);
      }
    } catch (_err) {
      // Expected: file may have been removed between readdir and lstat — skip unstattable entries
    }
  }

  return { valid: symlinkFiles.length === 0, symlinkFiles };
}

/**
 * Format an array of hooks as YAML command entries.
 *
 * @param {Array<{hook: string, name: string, run: string}>} hooks - Hooks to format.
 * @returns {string} YAML snippet with indented command entries.
 */
function formatHookCommands(hooks) {
  let result = '';
  for (const h of hooks) {
    result += `    ${h.name}:\n      run: ${h.run}\n`;
  }
  return result;
}

/**
 * Merge hooks into an existing YAML string for a given hook type.
 *
 * @param {string} yaml - Current YAML content.
 * @param {string} hookType - Hook type name (e.g., "pre-commit").
 * @param {Array<{hook: string, name: string, run: string}>} hooks - Hooks to merge.
 * @returns {string} Updated YAML content with hooks merged in.
 */
function mergeHookTypeIntoYaml(yaml, hookType, hooks) {
  const commandsRegex = new RegExp(String.raw`(` + hookType + String.raw`:\s*\n(?:.*\n)*?\s+commands:\s*\n)`, 'm');
  const commandsMatch = commandsRegex.exec(yaml);
  if (commandsMatch) {
    const insertion = formatHookCommands(hooks);
    return yaml.replace(commandsMatch[1], commandsMatch[1] + insertion);
  }
  return yaml;
}

/**
 * Generate Lefthook YAML content for mapped hooks.
 * Merges into existing lefthook.yml content if provided.
 *
 * @param {Array<{hook: string, name: string, run: string}>} mappedHooks - Mapped hooks.
 * @param {string} [existingContent] - Existing lefthook.yml content to merge into.
 * @returns {string} Generated YAML content.
 */
function generateLefthookYaml(mappedHooks, existingContent) {
  // Group hooks by hook type (pre-commit, commit-msg, etc.)
  const hookGroups = {};
  for (const h of mappedHooks) {
    if (!hookGroups[h.hook]) hookGroups[h.hook] = [];
    hookGroups[h.hook].push(h);
  }

  // Start with existing content or empty string
  let yaml = existingContent ? existingContent.trimEnd() + '\n' : '';

  for (const [hookType, hooks] of Object.entries(hookGroups)) {
    // Check if this hook type already exists in existing content
    const hookRegex = new RegExp(`^${hookType}:`, 'm');
    if (existingContent && hookRegex.test(existingContent)) {
      yaml = mergeHookTypeIntoYaml(yaml, hookType, hooks);
      continue;
    }

    // New hook type — append full block
    if (yaml && !yaml.endsWith('\n')) yaml += '\n';
    yaml += `${hookType}:\n  commands:\n`;
    yaml += formatHookCommands(hooks);
  }

  return yaml;
}

/**
 * Try to unset core.hooksPath via git config.
 * Uses execFileSync (not execSync) to prevent command injection.
 *
 * @param {string} projectRoot - Absolute path to the project root.
 * @returns {boolean} Whether the unset was attempted.
 */
function unsetHooksPath(projectRoot) {
  try {
    execFileSync(resolveCommand('git'), ['config', '--unset', 'core.hooksPath'], {
      cwd: projectRoot,
      stdio: 'ignore',
    });
    return true;
  } catch (_err) {
    // Expected: git config --unset fails when core.hooksPath is not set — safe to ignore
    return false;
  }
}

/**
 * Orchestrate a full Husky-to-Lefthook migration.
 *
 * @param {string} projectRoot - Absolute path to the project root.
 * @param {object} [options] - Migration options.
 * @param {boolean} [options.nonInteractive=false] - Skip user prompts.
 * @returns {{ success: boolean, mappedCount: number, unmappedCount: number, warnings: string[], hooksPathUnset?: boolean }}
 */
function migrateHusky(projectRoot, options = {}) {
  const warnings = [];

  // Step 1: Detect Husky
  const detection = detectHusky(projectRoot);
  if (!detection.found) {
    return {
      success: false,
      mappedCount: 0,
      unmappedCount: 0,
      warnings: ['No .husky/ directory found — nothing to migrate'],
    };
  }

  // Step 2: Validate no symlinks (OWASP A08)
  const symCheck = validateNoSymlinks(detection.huskyDir);
  if (!symCheck.valid) {
    return {
      success: false,
      mappedCount: 0,
      unmappedCount: 0,
      warnings: [
        `Security: symlink detected in .husky/ — rejecting migration. Symlinked files: ${symCheck.symlinkFiles.join(', ')}`,
      ],
    };
  }

  // Step 3: Map hooks
  const { mapped, unmapped } = mapHuskyHooks(detection.huskyDir);

  // Step 4: Warn about unmapped hooks
  for (const u of unmapped) {
    warnings.push(`Unmapped hook '${u.hook}': ${u.reason}`);
  }

  // Step 5: In non-interactive mode, proceed automatically
  // In interactive mode, the caller (bin/forge.js) handles the prompt
  if (!options.nonInteractive) {
    return {
      success: false,
      mappedCount: mapped.length,
      unmappedCount: unmapped.length,
      warnings: [...warnings, 'Interactive mode — caller must confirm before proceeding'],
    };
  }

  // Step 6: Generate/merge lefthook.yml
  const lefthookPath = path.join(projectRoot, 'lefthook.yml');
  let existingContent = null;
  if (fs.existsSync(lefthookPath)) {
    try {
      existingContent = fs.readFileSync(lefthookPath, 'utf8');
    } catch (_err) {
      // Expected: existing lefthook.yml may be unreadable — will create a new one instead
    }
  }

  if (mapped.length > 0) {
    const yaml = generateLefthookYaml(mapped, existingContent);
    fs.writeFileSync(lefthookPath, yaml, 'utf8');
  }

  // Step 7: Unset core.hooksPath if set
  let hooksPathUnset = false;
  if (detection.hasHooksPath) {
    hooksPathUnset = unsetHooksPath(projectRoot);
  }

  // Step 8: Remove .husky/ directory
  try {
    fs.rmSync(detection.huskyDir, { recursive: true, force: true });
  } catch (_err) {
    // Expected: .husky/ removal may fail due to file locks or permissions
    warnings.push(`Could not remove .husky/ directory: ${_err.message}`);
  }

  return {
    success: true,
    mappedCount: mapped.length,
    unmappedCount: unmapped.length,
    warnings,
    hooksPathUnset,
  };
}

module.exports = {
  detectHusky,
  mapHuskyHooks,
  migrateHusky,
};
