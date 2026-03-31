/**
 * file-utils.js — File I/O operations extracted from bin/forge.js
 *
 * All functions that previously relied on the module-level `projectRoot`
 * variable now accept it as an explicit parameter.
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Read a file and return its contents as a UTF-8 string.
 * @param {string} filePath - Absolute path to the file.
 * @returns {string|null} File contents, or null on failure.
 */
function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (process.env.DEBUG) {
      console.warn(`  ⚠ Could not read ${filePath}: ${err.message}`);
    }
    return null;
  }
}

/**
 * Write content to a file, creating parent directories as needed.
 * Blocks path traversal outside projectRoot.
 * @param {string} filePath - Relative path within projectRoot.
 * @param {string} content - Content to write.
 * @param {string} projectRoot - Absolute path to the project root.
 * @returns {boolean} True on success, false on failure or blocked traversal.
 */
function writeFile(filePath, content, projectRoot) {
  try {
    const fullPath = path.resolve(projectRoot, filePath);
    const resolvedProjectRoot = path.resolve(projectRoot);

    // SECURITY: Prevent path traversal
    if (!fullPath.startsWith(resolvedProjectRoot)) {
      console.error(`  ✗ Security: Write path escape blocked: ${filePath}`);
      return false;
    }

    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(fullPath, content, { mode: 0o644 });
    return true;
  } catch (err) {
    console.error(`  ✗ Failed to write ${filePath}: ${err.message}`);
    return false;
  }
}

/**
 * Ensure a directory exists under projectRoot.
 * Blocks path traversal outside projectRoot.
 * @param {string} dir - Relative path within projectRoot.
 * @param {string} projectRoot - Absolute path to the project root.
 * @returns {boolean} True on success, false on blocked traversal.
 */
function ensureDir(dir, projectRoot) {
  const fullPath = path.resolve(projectRoot, dir);
  const resolvedProjectRoot = path.resolve(projectRoot);

  // SECURITY: Prevent path traversal
  if (!fullPath.startsWith(resolvedProjectRoot)) {
    console.error(`  ✗ Security: Directory path escape blocked: ${dir}`);
    return false;
  }

  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true });
  }
  return true;
}

/**
 * Creates a directory on first use and prints a one-time purpose note.
 * @param {string} dir - Absolute path to the directory to create.
 * @param {string} purpose - Human-readable purpose description.
 * @returns {string|null} Purpose message if created, null if already existed.
 */
function ensureDirWithNote(dir, purpose) {
  if (fs.existsSync(dir)) {
    return null;
  }
  fs.mkdirSync(dir, { recursive: true });
  const display = dir.replaceAll('\\', '/');
  const msg = `Created ${display} for ${purpose}`;
  console.log(`  ${msg}`);
  return msg;
}

/**
 * Strip YAML frontmatter from markdown content.
 * @param {string} content - Markdown string potentially containing frontmatter.
 * @returns {string} Content without frontmatter.
 */
function stripFrontmatter(content) {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/); // NOSONAR — RegExp.exec blocked by security hook; match() equivalent here (no g flag)
  return match ? match[1] : content;
}

/**
 * Read the .env.local file from projectRoot.
 * @param {string} projectRoot - Absolute path to the project root.
 * @returns {string} File contents, or empty string if missing.
 */
function readEnvFile(projectRoot) {
  const envPath = path.join(projectRoot, '.env.local');
  try {
    if (fs.existsSync(envPath)) {
      return fs.readFileSync(envPath, 'utf8');
    }
  } catch (err) {
    // File read failure is acceptable - file may not exist or have permission issues
    // Return empty string to allow caller to proceed with defaults
    console.warn('Failed to read .env.local:', err.message);
  }
  return '';
}

/**
 * Parse .env.local and return key-value pairs.
 * @param {string} projectRoot - Absolute path to the project root.
 * @returns {Object} Parsed key-value pairs.
 */
function parseEnvFile(projectRoot) {
  const content = readEnvFile(projectRoot);
  const lines = content.split(/\r?\n/);
  const vars = {};
  lines.forEach(line => {
    const match = line.match(/^([A-Z_]+)=(.*)$/); // NOSONAR — RegExp.exec blocked by security hook; match() equivalent here (no g flag)
    if (match) {
      vars[match[1]] = match[2];
    }
  });
  return vars;
}

/**
 * Write or update .env.local — PRESERVES existing values by default.
 * @param {Object} tokens - Key-value pairs to write.
 * @param {boolean} [preserveExisting=true] - Whether to preserve existing values.
 * @param {string} projectRoot - Absolute path to the project root.
 * @returns {{ added: string[], preserved: string[] }} Keys added and preserved.
 */
function writeEnvTokens(tokens, projectRoot, preserveExisting = true) {
  const envPath = path.join(projectRoot, '.env.local');
  let content = readEnvFile(projectRoot);

  // Parse existing content (handle both CRLF and LF line endings)
  const lines = content.split(/\r?\n/);
  const existingVars = {};
  const existingKeys = new Set();
  lines.forEach(line => {
    const match = line.match(/^([A-Z_]+)=/); // NOSONAR — RegExp.exec blocked by security hook; match() equivalent here (no g flag)
    if (match) {
      existingVars[match[1]] = line;
      existingKeys.add(match[1]);
    }
  });

  // Track what was added vs preserved
  let added = [];
  let preserved = [];

  // Add/update tokens - PRESERVE existing values if preserveExisting is true
  Object.entries(tokens).forEach(([key, value]) => {
    if (value?.trim()) {
      if (preserveExisting && existingKeys.has(key)) {
        // Keep existing value, don't overwrite
        preserved.push(key);
      } else {
        // Add new token
        existingVars[key] = `${key}=${value.trim()}`;
        added.push(key);
      }
    }
  });

  // Rebuild file with comments
  const outputLines = [];

  // Add header if new file
  if (!content.includes('# External Service API Keys')) {
    outputLines.push(
      '# External Service API Keys for Forge Workflow',
      '# Get your keys from:',
      '#   Parallel AI: https://platform.parallel.ai',
      '#   Greptile: https://app.greptile.com/api',
      '#   SonarCloud: https://sonarcloud.io/account/security',
      ''
    );
  }

  // Add existing content (preserve order and comments)
  lines.forEach(line => {
    const match = line.match(/^([A-Z_]+)=/); // NOSONAR — RegExp.exec blocked by security hook; match() equivalent here (no g flag)
    if (match && existingVars[match[1]]) {
      outputLines.push(existingVars[match[1]]);
      delete existingVars[match[1]]; // Mark as added
    } else if (line.trim()) {
      outputLines.push(line);
    }
  });

  // Add any new tokens not in original file
  Object.values(existingVars).forEach(line => {
    outputLines.push(line);
  });

  // Ensure ends with newline
  let finalContent = outputLines.join('\n').trim() + '\n';

  fs.writeFileSync(envPath, finalContent);

  // OWASP A02: Set restrictive permissions on .env.local (contains API keys)
  // On Windows, chmod is a no-op so we skip it
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(envPath, 0o600);
    } catch (_err) {
      // chmod failure is non-fatal — file was still written successfully
    }
  }

  // Add .env.local to .gitignore if not present
  const gitignorePath = path.join(projectRoot, '.gitignore');
  try {
    let gitignore = '';
    if (fs.existsSync(gitignorePath)) {
      gitignore = fs.readFileSync(gitignorePath, 'utf8');
    }
    if (!gitignore.includes('.env.local')) {
      fs.appendFileSync(gitignorePath, '\n# Local environment variables\n.env.local\n');
    }
  } catch (err) {
    // Gitignore update is optional - failure doesn't prevent .env.local creation
    // User can manually add .env.local to .gitignore if needed
    console.warn('Failed to update .gitignore:', err.message);
  }

  return { added, preserved };
}

module.exports = {
  readFile,
  writeFile,
  ensureDir,
  ensureDirWithNote,
  stripFrontmatter,
  readEnvFile,
  parseEnvFile,
  writeEnvTokens,
};
