'use strict';

/**
 * @module memory/router
 *
 * Single dispatch seam for `forge remember` / `forge recall`. The DEFAULT is
 * `local` (the flat JSONL store in `lib/memory-store.js`) — zero external
 * services, offline, instant. The router exists so the opt-in `graphiti`
 * knowledge-graph tier can slot in behind the same CLI verbs WITHOUT changing
 * the clean default path.
 *
 * Public config surface is deliberately `local | graphiti` only. The kernel
 * read model (`lib/project-memory.js`) stays an internal implementation detail
 * and is NOT a supported `memory.backend` value.
 *
 * Design: docs/work/2026-07-06-graphiti-memory/research.md (§2.1 "three tiers,
 * Graphiti is the top opt-in tier; the local store is always the floor").
 *
 * Hard rule: `remember`/`recall` must NEVER hang or fail. Under `graphiti`,
 * writes are FIRE-AND-FORGET with a HARD FALLBACK to the local JSONL store on
 * any error/timeout — a down sidecar can never strand a note. The local append
 * is the floor and always happens. Strict validation (`assertMemoryConfigValid`)
 * is a separate, explicit gate for tooling (e.g. `forge doctor`).
 */

const memoryStore = require('../memory-store');

/** Supported PUBLIC backends, default first. */
const MEMORY_BACKENDS = ['local', 'graphiti'];
const DEFAULT_MEMORY_BACKEND = 'local';
const ENV_VAR = 'FORGE_MEMORY_BACKEND';

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
 * Append a note. `local` is byte-identical to `memory-store.append`. `graphiti`
 * ALSO writes the local floor (the note is always durably captured) and then
 * fires a best-effort, non-blocking emit toward the graph backend.
 *
 * @param {string} projectRoot
 * @param {string} note
 * @param {object} [options] - { tags, filePath, deps, env, config, graphitiEmitter }
 * @returns {{ id: string, note: string, timestamp: string, tags: string[] }}
 */
function append(projectRoot, note, options = {}) {
  const backend = resolveMemoryBackend({ ...options, projectRoot });
  // The local JSONL store is the floor for EVERY backend — always write it first.
  const entry = memoryStore.append(projectRoot, note, options);
  if (backend === 'graphiti') {
    fireAndForgetGraphitiEmit(options.graphitiEmitter, entry);
  }
  return entry;
}

/**
 * List notes newest-first. Reads the local floor for every backend (the CLI
 * read surface; agents read the graph directly over MCP when enabled).
 */
function list(projectRoot, options = {}) {
  return memoryStore.list(projectRoot, options);
}

/**
 * Search notes. Reads the local floor for every backend.
 */
function search(projectRoot, query, options = {}) {
  return memoryStore.search(projectRoot, query, options);
}

module.exports = {
  MEMORY_BACKENDS,
  DEFAULT_MEMORY_BACKEND,
  ENV_VAR,
  readMemoryConfig,
  resolveMemoryBackend,
  assertMemoryConfigValid,
  append,
  list,
  search,
};
