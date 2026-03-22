/**
 * Husky detection and automated migration to Lefthook.
 *
 * Detects existing Husky installations, maps hook scripts to Lefthook format,
 * and orchestrates a safe migration with symlink validation (OWASP A08).
 *
 * @module lib/husky-migration
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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
    name: (_m) => _m[2],
    run: (_m) => `${_m[1]} run ${_m[2]}`,
  },
  {
    // npx <tool> (simple single-command invocations, no pipes/conditionals)
    pattern: /^npx\s+(\S+)$/m,
    name: (_m) => _m[1],
    run: (_m) => `npx ${_m[1]}`,
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
      // Cannot read git config — assume no hooksPath
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
    const m = body.match(entry.pattern);
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
    return { mapped, unmapped };
  }

  for (const entry of entries) {
    // Skip internal Husky files/directories
    if (HUSKY_INTERNAL.has(entry.name)) continue;
    if (entry.isDirectory()) continue;

    const filePath = path.join(huskyDir, entry.name);
    const hookName = entry.name; // e.g., "pre-commit", "commit-msg"

    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (_err) {
      unmapped.push({ hook: hookName, reason: `Cannot read file: ${_err.message}` });
      continue;
    }

    const body = stripHuskyBoilerplate(content);
    if (!body) {
      // Empty hook — skip silently
      continue;
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
      // Cannot stat — skip
    }
  }

  return { valid: symlinkFiles.length === 0, symlinkFiles };
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
      // Hook type exists — append commands under it
      // Find the commands section and add to it
      const commandsRegex = new RegExp(`(${hookType}:\\s*\\n(?:.*\\n)*?\\s+commands:\\s*\\n)`, 'm');
      const commandsMatch = yaml.match(commandsRegex);
      if (commandsMatch) {
        let insertion = '';
        for (const h of hooks) {
          insertion += `    ${h.name}:\n      run: ${h.run}\n`;
        }
        yaml = yaml.replace(commandsMatch[1], commandsMatch[1] + insertion);
      }
      // If no commands section found, skip merging this hook type
      continue;
    }

    // New hook type — append full block
    if (yaml && !yaml.endsWith('\n')) yaml += '\n';
    yaml += `${hookType}:\n  commands:\n`;
    for (const h of hooks) {
      yaml += `    ${h.name}:\n      run: ${h.run}\n`;
    }
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
    execFileSync('git', ['config', '--unset', 'core.hooksPath'], {
      cwd: projectRoot,
      stdio: 'ignore',
    });
    return true;
  } catch (_err) {
    // May fail if not set — that's fine
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
      // Cannot read — will create new
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
