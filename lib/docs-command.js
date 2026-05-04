const fs = require('node:fs');
const path = require('node:path');

/**
 * Allowlist mapping topic names to filenames in docs/.
 * Security: Only these exact keys are accepted — prevents path traversal.
 */
const TOPICS = {
  toolchain: 'TOOLCHAIN.md',
  validation: 'VALIDATION.md',
  setup: 'SETUP.md',
  examples: 'EXAMPLES.md',
  roadmap: 'ROADMAP.md',
};

const TOPIC_DIRS = {
  setup: ['guides', 'reference', ''],
};

/**
 * List all available topic names.
 * @returns {string[]}
 */
function listTopics() {
  return Object.keys(TOPICS);
}

/**
 * Get the content of a documentation topic.
 * Uses an allowlist to prevent path traversal attacks.
 *
 * @param {string} topic - Topic name (must be in TOPICS allowlist)
 * @param {string} packageDir - Forge package root directory
 * @returns {{ content?: string, error?: string }}
 */
function getTopicContent(topic, packageDir) {
  const availableList = listTopics().join(', ');

  // Validate against allowlist (rejects any path traversal attempt)
  const filename = TOPICS[topic];
  if (!filename) {
    return { error: `Unknown topic: "${topic}". Available topics: ${availableList}` };
  }

  const searchDirs = TOPIC_DIRS[topic] || ['reference', 'guides', ''];

  for (const dir of searchDirs) {
    const filePath = path.join(packageDir, 'docs', dir, filename);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return { content };
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        // Try the next allowed documentation directory.
        continue;
      }
      return { error: `Failed to read documentation file "${filePath}": ${error.message}` };
    }
  }

  const searchedPaths = searchDirs
    .map((dir) => path.join(packageDir, 'docs', dir, filename))
    .join(', ');
  return { error: `Documentation file "${filename}" not found at ${searchedPaths}` };
}

module.exports = { listTopics, getTopicContent, TOPICS };
