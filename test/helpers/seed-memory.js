'use strict';

const projectMemory = require('../../lib/project-memory');
const MAX_MEMORY_FIXTURE_ROWS = 512;

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlNullableText(value) {
  return value === null || value === undefined ? 'NULL' : sqlText(value);
}

function memoryValues(entry) {
  const timestamp = entry.timestamp || new Date().toISOString();
  return [
    sqlText(entry.key),
    sqlText(JSON.stringify(entry.value ?? null)),
    sqlText(entry.sourceAgent || entry['source-agent'] || ''),
    sqlNullableText(entry.scope),
    entry.confidence === undefined ? 'NULL' : String(entry.confidence),
    sqlText(JSON.stringify(Array.isArray(entry.tags) ? entry.tags : [])),
    sqlNullableText(Array.isArray(entry.supersedes) ? JSON.stringify(entry.supersedes) : null),
    sqlNullableText(Array.isArray(entry.beadsRefs) ? JSON.stringify(entry.beadsRefs) : null),
    sqlText(timestamp),
    sqlText(timestamp),
  ].join(', ');
}

// Test-only fixture path: one SQLite transaction avoids 101 synchronous driver calls on
// Windows while retaining the exact kernel_memories schema and FTS triggers used by recall.
async function seedMemoryEntries(projectRoot, entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TypeError('seedMemoryEntries requires a non-empty array');
  }
  if (entries.length > MAX_MEMORY_FIXTURE_ROWS) {
    throw new RangeError(`seedMemoryEntries accepts at most ${MAX_MEMORY_FIXTURE_ROWS} rows`);
  }
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== 'object' || typeof entry.key !== 'string' || !entry.key.trim()) {
      throw new TypeError(`seedMemoryEntries row ${index} requires a non-empty key`);
    }
    if (!Object.hasOwn(entry, 'value') || entry.value === undefined) {
      throw new TypeError(`seedMemoryEntries row ${index} requires value`);
    }
    const sourceAgent = entry.sourceAgent || entry['source-agent'];
    if (typeof sourceAgent !== 'string' || !sourceAgent.trim()) {
      throw new TypeError(`seedMemoryEntries row ${index} requires sourceAgent`);
    }
  }

  const store = projectMemory.resolveStore(projectRoot);
  const rows = entries.map(memoryValues).join('),\n  (');
  try {
    await store.exec([
      'BEGIN IMMEDIATE;',
      'INSERT INTO kernel_memories (key, value_json, source_agent, scope, confidence, tags_json, supersedes_json, beads_refs_json, created_at, updated_at)',
      `VALUES\n  (${rows});`,
      'COMMIT;',
    ].join('\n'));
  } catch (error) {
    try { await store.exec('ROLLBACK;'); } catch { /* preserve the fixture error */ }
    throw error;
  }

  const [countRow] = await store.queryAll('SELECT count(*) AS count FROM kernel_memories');
  const [newestRow] = await store.queryAll(
    'SELECT key FROM kernel_memories ORDER BY updated_at DESC, rowid DESC LIMIT 1',
  );
  return {
    count: Number(countRow?.count) || 0,
    newestKey: newestRow?.key || null,
  };
}

module.exports = { seedMemoryEntries };
