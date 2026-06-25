'use strict';

/**
 * File-backed project memory store.
 *
 * Notes are persisted as newline-delimited JSON under
 * `.forge/memory/notes.jsonl`, which lives inside the repository so memory
 * travels with the project through normal git history. The store has no
 * external service or database dependency: every operation is a plain
 * filesystem read or append.
 *
 * @module memory-store
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MEMORY_DIR = path.join('.forge', 'memory');
const STORE_FILENAME = 'notes.jsonl';

/**
 * Resolve the default newline-delimited store path for a project.
 *
 * @param {string} projectRoot - Absolute path to the project root.
 * @returns {string} Absolute path to the notes store file.
 */
function defaultStorePath(projectRoot) {
  return path.join(projectRoot, MEMORY_DIR, STORE_FILENAME);
}

function resolveStorePath(projectRoot, options = {}) {
  return options.filePath || defaultStorePath(projectRoot);
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) {
    return [];
  }
  return tags
    .filter(tag => typeof tag === 'string')
    .map(tag => tag.trim())
    .filter(Boolean);
}

/**
 * Append a note to the store and return the persisted entry.
 *
 * @param {string} projectRoot - Absolute path to the project root.
 * @param {string} note - Free-form note text. Leading/trailing space is trimmed.
 * @param {Object} [options]
 * @param {string[]} [options.tags] - Optional search/grouping labels.
 * @param {string} [options.timestamp] - ISO timestamp; generated when omitted.
 * @param {string} [options.filePath] - Override the storage location (tests).
 * @returns {{ id: string, note: string, timestamp: string, tags: string[] }}
 */
function append(projectRoot, note, options = {}) {
  if (typeof note !== 'string' || note.trim() === '') {
    throw new TypeError('memory note must be a non-empty string');
  }

  const entry = {
    id: crypto.randomUUID(),
    note: note.trim(),
    timestamp: options.timestamp || new Date().toISOString(),
    tags: normalizeTags(options.tags),
  };

  const storePath = resolveStorePath(projectRoot, options);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.appendFileSync(storePath, `${JSON.stringify(entry)}\n`, 'utf8');

  return entry;
}

function readEntries(storePath) {
  if (!fs.existsSync(storePath)) {
    return [];
  }

  const raw = fs.readFileSync(storePath, 'utf8');
  const entries = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && typeof parsed.note === 'string') {
        entries.push({
          id: typeof parsed.id === 'string' ? parsed.id : '',
          note: parsed.note,
          timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : '',
          tags: normalizeTags(parsed.tags),
        });
      }
    } catch (_error) {
      // Skip unparseable lines so one bad record cannot break recall.
    }
  }

  return entries;
}

/**
 * List all stored notes, newest first.
 *
 * @param {string} projectRoot - Absolute path to the project root.
 * @param {Object} [options]
 * @param {string} [options.filePath] - Override the storage location (tests).
 * @returns {Array<{ id: string, note: string, timestamp: string, tags: string[] }>}
 */
function list(projectRoot, options = {}) {
  return readEntries(resolveStorePath(projectRoot, options)).reverse();
}

/**
 * Search stored notes by case-insensitive substring across note text and tags.
 * An empty query returns every entry (newest first).
 *
 * @param {string} projectRoot - Absolute path to the project root.
 * @param {string} query - Search term.
 * @param {Object} [options]
 * @param {string} [options.filePath] - Override the storage location (tests).
 * @returns {Array<{ id: string, note: string, timestamp: string, tags: string[] }>}
 */
function search(projectRoot, query, options = {}) {
  const entries = list(projectRoot, options);
  if (typeof query !== 'string' || query.trim() === '') {
    return entries;
  }

  const needle = query.trim().toLowerCase();
  return entries.filter(entry => {
    const haystack = `${entry.note} ${entry.tags.join(' ')}`.toLowerCase();
    return haystack.includes(needle);
  });
}

module.exports = {
  defaultStorePath,
  append,
  list,
  search,
};
