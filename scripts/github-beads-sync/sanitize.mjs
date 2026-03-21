/**
 * Input sanitizer for GitHub issue data before passing to bd CLI.
 * Strips shell metacharacters, GitHub Actions interpolation, and control chars.
 * @module sanitize
 */

/** Shell metacharacters to strip from titles and bodies */
const SHELL_META_RE = /[;|&$`()<>\r\n]/g;

/** GitHub Actions interpolation pattern: ${{ ... }} */
const INTERPOLATION_RE = /\$\{\{[^}]*\}\}/g;

/** Control characters (C0 range, excluding normal whitespace) */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/** Label: only allow alphanumeric, dot, underscore, hyphen */
const LABEL_INVALID_RE = /[^a-zA-Z0-9._-]/g;

/**
 * Sanitize a general text field (shared logic for title/body).
 * @param {string} input - Raw input string
 * @param {number} maxLen - Maximum allowed length
 * @param {string} fieldName - Name for warning messages
 * @returns {{ sanitized: string, warnings: string[] }}
 */
function sanitizeText(input, maxLen, fieldName) {
  const warnings = [];
  let text = String(input ?? '');

  // Strip GitHub Actions interpolation patterns
  // Use local regex to avoid stateful /g lastIndex bug with .test()
  const interpolationReLocal = /\$\{\{[^}]*\}\}/g;
  if (interpolationReLocal.test(text)) {
    warnings.push(`${fieldName}: stripped GitHub Actions interpolation pattern(s)`);
  }
  text = text.replace(INTERPOLATION_RE, '');

  // Strip shell metacharacters
  const metaMatches = text.match(SHELL_META_RE);
  if (metaMatches) {
    const unique = [...new Set(metaMatches)];
    warnings.push(`${fieldName}: stripped shell metacharacters: ${unique.join(' ')}`);
  }
  text = text.replace(SHELL_META_RE, '');

  // Strip control characters
  // eslint-disable-next-line no-control-regex
  const controlCharsReLocal = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
  if (controlCharsReLocal.test(text)) {
    warnings.push(`${fieldName}: stripped control characters`);
  }
  text = text.replace(CONTROL_CHARS_RE, '');

  // Trim whitespace
  text = text.trim();

  // Truncate
  if (text.length > maxLen) {
    warnings.push(`${fieldName}: truncated from ${text.length} to ${maxLen} chars`);
    text = text.slice(0, maxLen);
  }

  // Empty check
  if (text.length === 0) {
    warnings.push(`${fieldName}: empty after sanitization`);
    text = '(empty)';
  }

  return { sanitized: text, warnings };
}

/**
 * Sanitize an issue title for bd CLI args.
 * @param {string} title - Raw GitHub issue title
 * @returns {{ sanitized: string, warnings: string[] }}
 */
export function sanitizeTitle(title) {
  return sanitizeText(title, 256, 'title');
}

/**
 * Sanitize an issue body for the description field.
 * @param {string} body - Raw GitHub issue body
 * @returns {{ sanitized: string, warnings: string[] }}
 */
export function sanitizeBody(body) {
  return sanitizeText(body, 1024, 'body');
}

/**
 * Sanitize a single label string.
 * Only allows [a-zA-Z0-9._-], max 64 chars.
 * @param {string} label - Raw GitHub label name
 * @returns {{ sanitized: string, warnings: string[] }}
 */
export function sanitizeLabel(label) {
  const warnings = [];
  let text = String(label ?? '').trim();

  // Strip invalid characters
  const invalidMatches = text.match(LABEL_INVALID_RE);
  if (invalidMatches) {
    warnings.push(`label: stripped invalid characters: ${[...new Set(invalidMatches)].join(' ')}`);
    text = text.replace(LABEL_INVALID_RE, '');
  }

  // Truncate
  if (text.length > 64) {
    warnings.push(`label: truncated from ${text.length} to 64 chars`);
    text = text.slice(0, 64);
  }

  // Empty check
  if (text.length === 0) {
    warnings.push('label: empty after sanitization');
    text = '(empty)';
  }

  return { sanitized: text, warnings };
}
