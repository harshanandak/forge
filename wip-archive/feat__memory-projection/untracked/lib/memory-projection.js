'use strict';

/**
 * Memory-projection renderer.
 *
 * Typed kernel memory (lib/memory/typed-api.js → kernel_memories) is WRITE-ONLY on
 * its own: `forge insights` records decisions, but nothing ever read them back into an
 * agent-facing instruction surface. This module closes that gap. It READS typed memory
 * via the typed/project-memory API and PROJECTS a bounded, marked "Project Memory"
 * section into the harness instruction surfaces at setup/refresh:
 *
 *   - AGENTS.md  → read by Codex (native), Hermes (forge orient/recap), Cursor (native),
 *                  and Claude (via the CLAUDE.md → AGENTS.md shim).
 *   - .cursor/rules/forge-memory.mdc → Cursor's first-class always-on rule surface.
 *
 * Two invariants make this safe to run on every setup:
 *   1. BOUNDED — only the highest-confidence, most-recent typed entries are projected,
 *      capped by an entry count AND a character budget (never dump the whole store).
 *   2. IDEMPOTENT — the projection is a single marker-delimited block. A refresh replaces
 *      the block in place; it never duplicates, and it never touches USER content or any
 *      other Forge-managed block.
 *
 * The 7 typed categories come from lib/memory/typed-api.js.
 */

const fs = require('node:fs');
const path = require('node:path');
const projectMemory = require('./project-memory');

// Fixed marker strings so block detection is a stable literal match (the human-readable
// "auto-generated" notice lives in the rendered markdown body, not the comment).
const MEMORY_START = '<!-- FORGE:MEMORY:START -->';
const MEMORY_END = '<!-- FORGE:MEMORY:END -->';

// The 7 typed-memory categories (kept in sync with lib/memory/typed-api.js CATEGORIES).
const TYPED_CATEGORIES = new Set([
  'decisions',
  'episodes',
  'skills',
  'state',
  'issues',
  'audit',
  'preferences',
]);

// Category display order + labels. Highest-signal categories first so the bounded
// projection leads with decisions/state when the budget is tight.
const CATEGORY_ORDER = ['decisions', 'state', 'issues', 'skills', 'preferences', 'episodes', 'audit'];
const CATEGORY_LABELS = {
  decisions: 'Decisions',
  state: 'State',
  issues: 'Issues',
  skills: 'Skills',
  preferences: 'Preferences',
  episodes: 'Episodes',
  audit: 'Audit',
};

// Bounding defaults. maxEntries caps the count; maxChars caps the total useful text
// (roughly a few hundred tokens) so the projection can never balloon the context budget.
const DEFAULT_MAX_ENTRIES = 12;
const DEFAULT_MAX_CHARS = 1400;
const SUMMARY_MAX = 200;

const PROJECTION_NOTE =
  '_Auto-generated projection of the highest-confidence, most-recent typed kernel memory. ' +
  'Do not edit — this block is refreshed by `forge setup`._';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function adapter(options = {}) {
  return options.memory ?? projectMemory;
}

// Pull a concise, single-line summary out of an entry's `data` payload. Typed entries
// store `{ category, data, provenance }`; `data` may be a string or an object.
function summarizeData(data) {
  if (data === null || data === undefined) return '';
  if (typeof data === 'string') return data;
  if (typeof data !== 'object') return String(data);
  const preferred = ['note', 'summary', 'title', 'description', 'decision', 'text', 'status', 'value'];
  for (const key of preferred) {
    if (typeof data[key] === 'string' && data[key].trim() !== '') {
      return data[key];
    }
  }
  try {
    return JSON.stringify(data);
  } catch {
    return '';
  }
}

function normalizeSummary(text) {
  const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= SUMMARY_MAX) return collapsed;
  return `${collapsed.slice(0, SUMMARY_MAX - 1).trimEnd()}…`;
}

function isTypedEntry(entry) {
  if (!entry || typeof entry.key !== 'string') return false;
  const category = entry.key.split(':')[0];
  return TYPED_CATEGORIES.has(category);
}

function parseEntry(entry) {
  const category = entry.key.split(':')[0];
  const name = entry.key.slice(category.length + 1) || entry.key;
  const rawData = entry.value && typeof entry.value === 'object' && !Array.isArray(entry.value)
    ? entry.value.data
    : entry.value;
  return {
    key: entry.key,
    category,
    name,
    summary: normalizeSummary(summarizeData(rawData)),
    confidence: typeof entry.confidence === 'number' ? entry.confidence : null,
    timestamp: entry.timestamp || null,
  };
}

// Filter to typed entries, rank by confidence (desc) then recency (desc), and cap by
// BOTH the entry count and the character budget. This is the single place that decides
// "what is worth projecting" so AGENTS.md and the Cursor rule stay in lock-step.
function selectMemoryEntries(entries, options = {}) {
  const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0
    ? options.maxEntries
    : DEFAULT_MAX_ENTRIES;
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0
    ? options.maxChars
    : DEFAULT_MAX_CHARS;

  const parsed = (Array.isArray(entries) ? entries : [])
    .filter(isTypedEntry)
    .map(parseEntry)
    .filter(item => item.summary !== '');

  parsed.sort((a, b) => {
    const confA = a.confidence ?? -1;
    const confB = b.confidence ?? -1;
    if (confB !== confA) return confB - confA;
    const timeA = Date.parse(a.timestamp || '') || 0;
    const timeB = Date.parse(b.timestamp || '') || 0;
    if (timeB !== timeA) return timeB - timeA;
    return a.key.localeCompare(b.key);
  });

  const selected = [];
  let usedChars = 0;
  for (const item of parsed) {
    if (selected.length >= maxEntries) break;
    const cost = item.summary.length + item.name.length;
    if (selected.length > 0 && usedChars + cost > maxChars) break;
    selected.push(item);
    usedChars += cost;
  }
  return selected;
}

function formatBullet(item) {
  const confidence = item.confidence !== null
    ? ` _(confidence ${item.confidence.toFixed(2)})_`
    : '';
  return `- **${item.name}** — ${item.summary}${confidence}`;
}

// Render just the markdown body (heading + grouped bullets), without the markers.
function renderMemoryBody(selected) {
  const lines = ['## Project Memory', '', PROJECTION_NOTE, ''];
  const seen = new Set(CATEGORY_ORDER);
  const categories = [
    ...CATEGORY_ORDER,
    ...[...new Set(selected.map(item => item.category))].filter(cat => !seen.has(cat)),
  ];
  for (const category of categories) {
    const items = selected.filter(item => item.category === category);
    if (items.length === 0) continue;
    lines.push(`**${CATEGORY_LABELS[category] || category}**`);
    for (const item of items) {
      lines.push(formatBullet(item));
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * Render the full marker-delimited "Project Memory" block for a set of already-selected
 * entries. Returns '' when there is nothing to project.
 */
function renderMemoryBlock(selected) {
  if (!selected || selected.length === 0) return '';
  return `${MEMORY_START}\n${renderMemoryBody(selected)}\n${MEMORY_END}`;
}

/**
 * Public renderer: given RAW memory entries, produce the bounded, marked block. Applies
 * the selection/bounding rules internally.
 */
function renderProjectMemorySection(entries, options = {}) {
  return renderMemoryBlock(selectMemoryEntries(entries, options));
}

function stripBlock(content) {
  const blockRe = new RegExp(`${escapeRegExp(MEMORY_START)}[\\s\\S]*?${escapeRegExp(MEMORY_END)}`);
  if (!blockRe.test(content)) return content;
  return content.replace(blockRe, '').replace(/\n{3,}/g, '\n\n');
}

const FORGE_END = '<!-- FORGE:END -->';
const FOOTER_ANCHOR = '\n---\n\n## Improving This Workflow';

/**
 * Idempotently insert/replace the "Project Memory" block inside `content`.
 *
 * Placement (in priority order): immediately after the Forge-managed FORGE:END marker;
 * otherwise before the "Improving This Workflow" footer; otherwise appended. The block is
 * always OUTSIDE the USER and FORGE managed blocks, so it never collides with user edits
 * or the workflow template. Passing zero entries removes any existing block.
 */
function projectMemoryIntoContent(content, entries, options = {}) {
  const base = stripBlock(content || '');
  const selected = selectMemoryEntries(entries, options);
  if (selected.length === 0) return base;

  const block = renderMemoryBlock(selected);
  const forgeEndIdx = base.indexOf(FORGE_END);
  let result;
  if (forgeEndIdx !== -1) {
    const after = forgeEndIdx + FORGE_END.length;
    result = `${base.slice(0, after)}\n\n${block}${base.slice(after)}`;
  } else {
    const footerIdx = base.indexOf(FOOTER_ANCHOR);
    if (footerIdx !== -1) {
      result = `${base.slice(0, footerIdx)}\n\n${block}${base.slice(footerIdx)}`;
    } else {
      result = `${base.replace(/\s*$/, '')}\n\n${block}\n`;
    }
  }
  return result.replace(/\n{3,}/g, '\n\n');
}

// Read the raw memory list from the store seam, tolerating a missing/unprovisioned store
// (a fresh project may have no kernel DB yet) by degrading to an empty projection.
function readMemoryList(projectRoot, options = {}) {
  try {
    const list = adapter(options).list(projectRoot, options);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * Collect the typed entries that WOULD be projected (typed-only, ranked, bounded). Useful
 * for callers that need the selection itself (e.g. the Cursor rule renderer or reporting).
 */
function collectTypedMemoryEntries(projectRoot, options = {}) {
  return selectMemoryEntries(readMemoryList(projectRoot, options), options);
}

/**
 * Project typed memory into AGENTS.md. Idempotent; no-op (changed:false) when the file is
 * absent or the rendered block already matches. Never fails setup — resolves gracefully.
 */
function projectMemoryIntoAgentsMd(projectRoot, options = {}) {
  const agentsPath = options.agentsPath || path.join(projectRoot, 'AGENTS.md');
  if (!fs.existsSync(agentsPath)) {
    return { changed: false, entries: 0, path: agentsPath, reason: 'no-agents-md' };
  }
  const list = readMemoryList(projectRoot, options);
  const selected = selectMemoryEntries(list, options);
  const existing = fs.readFileSync(agentsPath, 'utf8');
  const next = projectMemoryIntoContent(existing, list, options);
  if (next === existing) {
    return { changed: false, entries: selected.length, path: agentsPath };
  }
  fs.writeFileSync(agentsPath, next, 'utf8');
  return { changed: true, entries: selected.length, path: agentsPath };
}

/**
 * Render a Cursor `.mdc` rule that carries the bounded memory projection as an always-on
 * rule. Returns '' when there is nothing to project.
 */
function renderCursorMemoryRule(entries, options = {}) {
  const selected = Array.isArray(entries) && entries.length && entries[0]?.category
    ? entries
    : selectMemoryEntries(entries, options);
  if (!selected || selected.length === 0) return '';
  const frontmatter = [
    '---',
    'description: Project memory — highest-confidence, most-recent typed kernel memory (auto-generated by Forge)',
    'alwaysApply: true',
    '---',
  ].join('\n');
  return `${frontmatter}\n${renderMemoryBlock(selected)}\n`;
}

/**
 * Project typed memory into .cursor/rules/forge-memory.mdc. Idempotent; skips writing when
 * there is nothing to project (and removes a stale rule if the store is now empty).
 */
function projectMemoryIntoCursorRules(projectRoot, options = {}) {
  const rulePath = options.cursorRulePath
    || path.join(projectRoot, '.cursor', 'rules', 'forge-memory.mdc');
  const selected = collectTypedMemoryEntries(projectRoot, options);

  if (selected.length === 0) {
    if (fs.existsSync(rulePath)) {
      fs.rmSync(rulePath);
      return { changed: true, entries: 0, path: rulePath, removed: true };
    }
    return { changed: false, entries: 0, path: rulePath, skipped: true };
  }

  const content = renderCursorMemoryRule(selected, options);
  const existing = fs.existsSync(rulePath) ? fs.readFileSync(rulePath, 'utf8') : null;
  if (existing === content) {
    return { changed: false, entries: selected.length, path: rulePath };
  }
  fs.mkdirSync(path.dirname(rulePath), { recursive: true });
  fs.writeFileSync(rulePath, content, 'utf8');
  return { changed: true, entries: selected.length, path: rulePath };
}

module.exports = {
  MEMORY_START,
  MEMORY_END,
  TYPED_CATEGORIES: [...TYPED_CATEGORIES],
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_CHARS,
  selectMemoryEntries,
  renderProjectMemorySection,
  renderMemoryBlock,
  projectMemoryIntoContent,
  collectTypedMemoryEntries,
  projectMemoryIntoAgentsMd,
  renderCursorMemoryRule,
  projectMemoryIntoCursorRules,
};
