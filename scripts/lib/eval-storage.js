const fs = require('fs');
const path = require('path');

const DEFAULT_BASE_PATH = '.forge/eval-logs';

/**
 * Normalize a command name: strip leading slash, replace remaining slashes with dashes.
 */
function normalizeCommand(command) {
  return command.replace(/^\//, '').replace(/\//g, '-');
}

/**
 * Save an eval result as timestamped JSON.
 *
 * @param {object} result - Eval result with at minimum: { command, overall_score, results, timestamp }
 * @param {string} [_basePath] - Directory to write to (defaults to .forge/eval-logs)
 * @returns {string} The file path that was written
 */
function saveEvalResult(result, _basePath) {
  const basePath = _basePath || DEFAULT_BASE_PATH;
  const command = normalizeCommand(result.command);
  const date = new Date(result.timestamp);

  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');

  const fileName = `${yyyy}-${mm}-${dd}-${hh}-${min}-${command}.json`;
  const filePath = path.join(basePath, fileName);

  fs.mkdirSync(basePath, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf8');

  return filePath;
}

/**
 * Load eval history for a specific command.
 *
 * @param {string} command - Command name (e.g., '/status' or 'status')
 * @param {string} [_basePath] - Directory to read from (defaults to .forge/eval-logs)
 * @returns {object[]} Array of eval results sorted by timestamp (newest first)
 */
function loadEvalHistory(command, _basePath) {
  const basePath = _basePath || DEFAULT_BASE_PATH;
  const normalized = normalizeCommand(command);

  if (!fs.existsSync(basePath)) {
    return [];
  }

  const suffix = `-${normalized}.json`;
  const files = fs.readdirSync(basePath).filter((f) => f.endsWith(suffix));

  const results = [];
  for (const file of files) {
    const filePath = path.join(basePath, file);
    const content = fs.readFileSync(filePath, 'utf8');
    results.push(JSON.parse(content));
  }

  results.sort((a, b) => {
    const ta = new Date(a.timestamp).getTime();
    const tb = new Date(b.timestamp).getTime();
    return tb - ta;
  });

  return results;
}

module.exports = { saveEvalResult, loadEvalHistory };
