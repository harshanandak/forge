'use strict';

const projectMemory = require('../../lib/project-memory');

const MAX_RECALL_FIXTURE_ROWS = 32;

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function rowValues(entry) {
  return [
    sqlText(entry.key),
    sqlText(JSON.stringify(entry.value)),
    sqlText(entry.sourceAgent),
    'NULL',
    'NULL',
    sqlText(JSON.stringify(entry.tags)),
    'NULL',
    'NULL',
    sqlText(entry.timestamp),
    sqlText(entry.timestamp),
  ].join(', ');
}

// Test-only bulk path: initialize the real memory schema once, then seed every recall
// fixture row in one transaction so Windows does not pay repeated SQLite setup costs.
async function seedRecallMemories(projectRoot, entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TypeError('seedRecallMemories requires a non-empty array');
  }
  if (entries.length > MAX_RECALL_FIXTURE_ROWS) {
    throw new RangeError(`seedRecallMemories accepts at most ${MAX_RECALL_FIXTURE_ROWS} rows`);
  }
  entries.forEach((entry, index) => {
    if (!entry || typeof entry.key !== 'string' || !entry.key.trim()) {
      throw new TypeError(`seedRecallMemories row ${index} requires a non-empty key`);
    }
    if (typeof entry.value !== 'string' || typeof entry.sourceAgent !== 'string'
      || !Array.isArray(entry.tags) || typeof entry.timestamp !== 'string') {
      throw new TypeError(`seedRecallMemories row ${index} has an invalid fixture shape`);
    }
  });

  const store = projectMemory.resolveStore(projectRoot);
  store.countMemories();
  const values = entries.map(rowValues).join('),\n  (');
  try {
    await store.exec([
      'BEGIN IMMEDIATE;',
      'INSERT INTO kernel_memories (key, value_json, source_agent, scope, confidence, tags_json, supersedes_json, beads_refs_json, created_at, updated_at)',
      `VALUES\n  (${values});`,
      'COMMIT;',
    ].join('\n'));
  } catch (error) {
    try { await store.exec('ROLLBACK;'); } catch { /* preserve the fixture error */ }
    throw error;
  }
}

module.exports = { seedRecallMemories };
