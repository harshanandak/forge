const crypto = require('crypto');
const fs = require('fs');

/**
 * Compute SHA-256 hex digest of a string.
 * @param {string} content
 * @returns {string} 64-char lowercase hex hash
 */
function contentHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Check whether an existing file's content matches the given string.
 * Returns false if the file does not exist.
 * @param {string} filePath
 * @param {string} newContent
 * @returns {boolean}
 */
function fileMatchesContent(filePath, newContent) {
  if (!fs.existsSync(filePath)) return false;
  const existing = fs.readFileSync(filePath, 'utf8');
  return contentHash(existing) === contentHash(newContent);
}

module.exports = { contentHash, fileMatchesContent };
