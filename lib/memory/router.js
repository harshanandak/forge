'use strict';

/**
 * @module memory/router
 *
 * Single dispatch seam for `forge remember` / `forge recall`. The DEFAULT is
 * `local`, which now means the kernel `kernel_memories` table indexed by FTS5
 * (via `lib/project-memory.js`) — the same knowledge layer decisions and issues
 * share. The router exists so the opt-in `graphiti` knowledge-graph tier can slot
 * in behind the same CLI verbs WITHOUT changing the clean default path.
 *
 * Public config surface is deliberately `local | graphiti` only. `graphiti` is
 * EXPERIMENTAL — its config/doctor scaffolding ships but the runtime emitter is a
 * fast-follow, so today it always writes the local kernel floor and the emit is a
 * best-effort no-op unless a caller injects an emitter.
 *
 * Design: docs/work/2026-07-09-decision-store/design.md §B.1 (memory consolidation
 * onto the kernel + FTS5). The retired flat JSONL store (`lib/memory-store.js`) is
 * imported once into kernel_memories on first use, then never written again.
 *
 * Hard rule: `remember`/`recall` must NEVER hang or fail. Under `graphiti`, the
 * emit is FIRE-AND-FORGET with a HARD FALLBACK to the local kernel store on any
 * error/timeout — a down sidecar can never strand a note. The local kernel write
 * is the floor and always happens. Strict validation (`assertMemoryConfigValid`)
 * is a separate, explicit gate for tooling (e.g. `forge doctor`).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const projectMemory = require('../project-memory');

/** Supported PUBLIC backends, default first. */
const MEMORY_BACKENDS = ['local', 'graphiti'];
const DEFAULT_MEMORY_BACKEND = 'local';
const ENV_VAR = 'FORGE_MEMORY_BACKEND';

/** Default recall cap — newest-N, so `recall` with no query never dumps the whole store. */
const DEFAULT_RECALL_LIMIT = 20;
/** sourceAgent stamped on CLI `remember` notes (distinct from insights-written rows). */
const REMEMBER_SOURCE_AGENT = 'forge remember';
/** sourceAgent stamped on notes imported once from the retired JSONL store. */
const IMPORT_SOURCE_AGENT = 'forge remember (imported)';
/**
 * The source_agents that are human `remember` notes — the scope of the DEFAULT (no-query)
 * `recall` view, so machine/insights records never pollute or miscount the plain listing.
 * A query, or `--all`, still reaches every stored memory.
 */
const HUMAN_MEMORY_AGENTS = [REMEMBER_SOURCE_AGENT, IMPORT_SOURCE_AGENT];
/** The retired flat JSONL store, imported once into kernel_memories, then renamed. */
const LEGACY_JSONL_RELATIVE = ['.forge', 'memory', 'notes.jsonl'];

/**
 * Safely read the `memory` block from `<projectRoot>/.forge/config.yaml`.
 * Never throws — a missing or malformed file resolves to `{}` so the default
 * (local) path is byte-identical to shipping no config at all.
 *
 * @param {string|undefined} projectRoot
 * @returns {object} The parsed `memory` object, or `{}`.
 */
function readMemoryConfig(projectRoot) {
  if (!projectRoot) return {};

  const fs = require('node:fs');
  const path = require('node:path');
  const configPath = path.join(projectRoot, '.forge', 'config.yaml');
  if (!fs.existsSync(configPath)) return {};

  let parsed;
  try {
    // Lazy-require keeps the default no-config path free of the YAML parser.
    const YAML = require('yaml');
    parsed = YAML.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const memory = parsed.memory;
  if (!memory || typeof memory !== 'object' || Array.isArray(memory)) return {};
  return memory;
}

/**
 * Gather the raw backend signal by precedence (deps > env > config), WITHOUT
 * validation. Returns `{ value, source }` or `{ value: null, source: null }`.
 */
function collectBackendSignal({ deps = {}, env = process.env, projectRoot, config } = {}) {
  if (typeof deps.memoryBackend === 'string' && deps.memoryBackend.trim()) {
    return { value: deps.memoryBackend.trim(), source: 'deps' };
  }

  const envValue = env && env[ENV_VAR];
  if (typeof envValue === 'string' && envValue.trim()) {
    return { value: envValue.trim(), source: 'env' };
  }

  const memory = config || readMemoryConfig(projectRoot);
  const configValue = memory && memory.backend;
  if (typeof configValue === 'string' && configValue.trim()) {
    return { value: configValue.trim(), source: 'config' };
  }

  return { value: null, source: null };
}

/**
 * Resolve the active memory backend by precedence:
 *   deps.memoryBackend > FORGE_MEMORY_BACKEND env > .forge/config.yaml > 'local'.
 *
 * An UNKNOWN value (from any source) warns and falls back to `local` so a typo
 * — or a legacy `kernel` value — can never break `remember`/`recall`. Use
 * `assertMemoryConfigValid` when you need a hard error instead.
 *
 * @param {object} [options]
 * @returns {'local'|'graphiti'}
 */
function resolveMemoryBackend({
  deps = {},
  env = process.env,
  projectRoot,
  config,
  warn = console.warn,
} = {}) {
  const { value, source } = collectBackendSignal({ deps, env, projectRoot, config });
  if (!value) return DEFAULT_MEMORY_BACKEND;

  const normalized = value.toLowerCase();
  if (MEMORY_BACKENDS.includes(normalized)) return normalized;

  warn(
    `Unknown memory backend "${value}" from ${source}; `
    + `falling back to "${DEFAULT_MEMORY_BACKEND}". Valid backends: ${MEMORY_BACKENDS.join(', ')}.`,
  );
  return DEFAULT_MEMORY_BACKEND;
}

/**
 * Strict validation for the resolved backend. Unlike `resolveMemoryBackend`
 * (which soft-falls-back), this THROWS a clear, actionable error when the
 * selection is inconsistent. Used by tooling (e.g. `forge doctor`).
 *
 * @param {object} [options]
 * @returns {{ backend: string, graphiti: object|null }}
 */
function assertMemoryConfigValid({ deps = {}, env = process.env, projectRoot, config } = {}) {
  const memory = config || readMemoryConfig(projectRoot);
  const backend = resolveMemoryBackend({ deps, env, projectRoot, config: memory, warn: () => {} });

  if (backend !== 'graphiti') {
    return { backend, graphiti: null };
  }

  const graphiti = memory && memory.graphiti;
  const hasServerPath = graphiti
    && typeof graphiti.mcpServerPath === 'string'
    && graphiti.mcpServerPath.trim() !== '';
  if (!hasServerPath) {
    throw new Error(
      'memory.backend is "graphiti" but memory.graphiti.mcpServerPath is not set. '
      + 'Configure the Graphiti MCP server path (the checkout\'s mcp_server directory) '
      + 'in .forge/config.yaml. See docs/guides/memory-backends.md. '
      + 'The local store stays the default and the safety floor when unset.',
    );
  }
  return { backend, graphiti };
}

/**
 * Best-effort, fire-and-forget emit of an episode to the graph backend. This is
 * a SEAM: the actual Graphiti MCP client lands in a fast-follow PR. It NEVER
 * throws and NEVER blocks the caller — any error/timeout is swallowed so the
 * local floor write is the only thing that can affect `remember`'s result.
 *
 * CONTRACT for the fast-follow emitter (MUST hold — safe today only because no
 * emitter is constructed): the emitter MUST NOT keep the Node event loop alive
 * or delay CLI exit. Any spawned process/socket/timer it creates MUST be
 * `child.unref()`'d (or otherwise detached / left with no lingering handle), and
 * any network/RPC call MUST be bounded by its OWN timeout so a hung sidecar can
 * never stall `forge remember`. This function does NOT await the emit, so a
 * lingering handle inside `emit()` would be the ONLY way to break the
 * never-hang guarantee — the emitter, not this seam, owns preventing that.
 *
 * @param {object} [emitter] - optional `{ emit(entry) }` injected by callers.
 * @param {object} entry - the persisted local entry.
 */
function fireAndForgetGraphitiEmit(emitter, entry) {
  if (!emitter || typeof emitter.emit !== 'function') return;
  try {
    // Do not await: fire-and-forget. If it returns a promise, swallow rejection.
    const maybePromise = emitter.emit(entry);
    if (maybePromise && typeof maybePromise.then === 'function') {
      maybePromise.then(() => {}, () => {});
    }
  } catch {
    // Hard fallback: the local write already succeeded. Never surface emit errors.
  }
}

/**
 * Render a non-string memory value (e.g. an insights skill record) as a compact, READABLE
 * one-liner rather than a raw JSON blob. Flattens the top level: primitive fields become
 * `key: value`; nested fields fall back to compact JSON.
 *
 * @param {*} value
 * @returns {string}
 */
function renderStructuredValue(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) {
    return value.map(item => (item !== null && typeof item === 'object' ? JSON.stringify(item) : String(item))).join(', ');
  }
  return Object.entries(value)
    .map(([key, val]) => (val !== null && typeof val === 'object' ? `${key}: ${JSON.stringify(val)}` : `${key}: ${val}`))
    .join(' · ');
}

/**
 * Map a kernel_memories entry to the CLI note shape `remember`/`recall` render. A string
 * value IS the note text; a structured value (an insights/typed record) is rendered readably
 * and flagged `machine` with its `sourceAgent` so the CLI can LABEL it rather than mislabel a
 * raw JSON blob as a plain note.
 *
 * @param {object} entry - a kernel_memories entry ({ key, value, sourceAgent, timestamp, tags }).
 * @returns {{ id: string, note: string, sourceAgent: string, machine: boolean, timestamp: string, tags: string[] }}
 */
function toNote(entry) {
  if (!entry) return null;
  const isString = typeof entry.value === 'string';
  return {
    id: entry.key,
    note: isString ? entry.value : renderStructuredValue(entry.value),
    sourceAgent: typeof entry.sourceAgent === 'string' ? entry.sourceAgent : '',
    machine: !isString,
    timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : '',
    tags: Array.isArray(entry.tags) ? entry.tags : [],
  };
}

function legacyJsonlPath(projectRoot) {
  return path.join(projectRoot, ...LEGACY_JSONL_RELATIVE);
}

// A STABLE key for a legacy record that lacks an `id`, derived from its content — so a
// re-run (or a failed rename) upserts the same row instead of double-inserting under a
// fresh random UUID.
function legacyContentKey(parsed) {
  const basis = JSON.stringify({
    note: parsed.note,
    timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : '',
    tags: Array.isArray(parsed.tags) ? parsed.tags.filter(tag => typeof tag === 'string') : [],
  });
  return `import:${crypto.createHash('sha256').update(basis).digest('hex').slice(0, 32)}`;
}

/**
 * One-time import of the retired flat JSONL store into kernel_memories. Idempotent (keys
 * are the original note ids, so a re-run upserts) and best-effort (a malformed record or a
 * write error can never break `remember`/`recall`). After a pass the file is renamed so the
 * import runs at most once and JSONL is never read or written again.
 *
 * @param {string} projectRoot
 * @param {object} [options] - forwarded to `projectMemory.write` (e.g. an injected store).
 */
function migrateJsonlNotesOnce(projectRoot, options = {}) {
  if (!projectRoot) return;
  const storePath = legacyJsonlPath(projectRoot);
  let raw;
  try {
    if (!fs.existsSync(storePath)) return;
    raw = fs.readFileSync(storePath, 'utf8');
  } catch {
    return;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // Skip an unparseable legacy line — one bad record can't block the import.
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.note !== 'string' || parsed.note.trim() === '') {
      continue;
    }
    const entry = {
      // A record with a stable id keys off it; one without keys off its content hash, so a
      // re-import can never double-insert the same note.
      key: typeof parsed.id === 'string' && parsed.id ? parsed.id : legacyContentKey(parsed),
      value: parsed.note,
      sourceAgent: IMPORT_SOURCE_AGENT,
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter(tag => typeof tag === 'string') : [],
    };
    if (typeof parsed.timestamp === 'string' && parsed.timestamp && !Number.isNaN(Date.parse(parsed.timestamp))) {
      entry.timestamp = parsed.timestamp;
    }
    try {
      projectMemory.write(projectRoot, entry, options);
    } catch {
      // Skip an unwritable legacy record; never break remember/recall on import.
    }
  }

  try {
    fs.renameSync(storePath, `${storePath}.migrated`);
  } catch {
    // Best-effort: the import is idempotent by key, so a failed rename re-imports safely.
  }
}

/**
 * Append a note through kernel_memories — the local floor for EVERY backend, always written
 * first so a note is durably captured. `graphiti` additionally fires a best-effort,
 * non-blocking emit toward the graph backend. Imports any retired JSONL store on first use.
 *
 * @param {string} projectRoot
 * @param {string} note
 * @param {object} [options] - { tags, deps, env, config, graphitiEmitter, store }
 * @returns {{ id: string, note: string, timestamp: string, tags: string[] }}
 */
function append(projectRoot, note, options = {}) {
  migrateJsonlNotesOnce(projectRoot, options);
  const backend = resolveMemoryBackend({ ...options, projectRoot });
  const written = projectMemory.write(projectRoot, {
    key: crypto.randomUUID(),
    value: note,
    sourceAgent: REMEMBER_SOURCE_AGENT,
    tags: Array.isArray(options.tags) ? options.tags : [],
  }, options);
  const entry = toNote(written);
  if (backend === 'graphiti') {
    fireAndForgetGraphitiEmit(options.graphitiEmitter, entry);
  }
  return entry;
}

/**
 * Read notes back through the FTS-backed kernel layer. WITH a query: BM25 token-AND top-N.
 * WITHOUT a query: the newest `limit` entries plus the total count (never a bare full dump).
 * Imports any retired JSONL store on first use.
 *
 * A query searches the WHOLE store (human notes + insights/typed records), so anything the
 * kernel knows is recallable. The default no-query view is scoped to human `remember` notes
 * so machine/insights records never pollute or miscount the plain listing; `selection.all`
 * widens it to every stored memory.
 *
 * @param {string} projectRoot
 * @param {object} [selection] - { query, limit, all }
 * @param {object} [options] - forwarded to the project-memory read paths (e.g. a store).
 * @returns {{ notes: object[], total: number, capped: boolean, query: string, limit: number, scope: string }}
 */
function recall(projectRoot, selection = {}, options = {}) {
  migrateJsonlNotesOnce(projectRoot, options);
  const requested = selection.limit;
  const limit = Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_RECALL_LIMIT;
  const query = String(selection.query || '').trim();
  const includeAll = Boolean(selection.all);

  if (query) {
    const notes = projectMemory.searchRanked(projectRoot, query, limit, options).map(toNote);
    // BM25 returns at most `limit`; a full result set signals there may be more.
    return { notes, total: notes.length, capped: notes.length >= limit, query, limit, scope: 'all' };
  }

  const agents = includeAll ? undefined : HUMAN_MEMORY_AGENTS;
  const readOptions = { ...options, agents };
  const notes = projectMemory.recent(projectRoot, limit, readOptions).map(toNote);
  const total = projectMemory.count(projectRoot, readOptions);
  return { notes, total, capped: total > notes.length, query: '', limit, scope: includeAll ? 'all' : 'remembered' };
}

module.exports = {
  MEMORY_BACKENDS,
  DEFAULT_MEMORY_BACKEND,
  DEFAULT_RECALL_LIMIT,
  ENV_VAR,
  readMemoryConfig,
  resolveMemoryBackend,
  assertMemoryConfigValid,
  migrateJsonlNotesOnce,
  toNote,
  append,
  recall,
};
