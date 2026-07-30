'use strict';

/**
 * `forge hooks install --global [--harness codex|hermes|all] [--dry-run]`
 *
 * The opt-in, CONSENT-GUARDED delivery path for the last native-hooks gap
 * (kernel issue 66dd5a1f, epics 90f2f631 + 1390e1d1): Codex and Hermes have
 * real native hook surfaces, but both live in GLOBAL (home-dir) config —
 * `$CODEX_HOME/config.toml` and `~/.hermes/config.yaml` — which project
 * `forge setup` intentionally never writes.
 *
 * Consent model:
 *   - the explicit `--global` flag IS the consent — without it the command
 *     refuses with guidance and writes nothing;
 *   - the command prints exactly which files are written and the exact Forge
 *     hook block merged into each, BEFORE reporting results;
 *   - `--dry-run` shows the same plan without touching disk;
 *   - existing user config is preserved (read → merge → write, idempotent via
 *     the forge-native-hook.js marker); unmergeable config is backed up and
 *     skipped, never overwritten.
 *
 * This command is deliberately NOT wired into project `forge setup`.
 */

const {
  GLOBAL_HOOK_HARNESSES,
  renderGlobalHookBlock,
  installGlobalHooks,
} = require('../hook-global-installer');
const fs = require('node:fs');
const path = require('node:path');
const { sessionStartCapability, userPromptSubmitCapability, sessionEndCapability } = require('../hook-renderer');
const { buildMemoryDigest, defaultFetchIssues, defaultFetchNotes } = require('../memory-digest');
const { collectInbox, buildInboxNudge } = require('../inbox');
const { collectDigest } = require('../pr-monitor/digest');
const { loadDispatchText } = require('../using-forge');
const projectMemory = require('../project-memory');
const { parseHookInput, selectInjection, meaningfulTokens, DEFAULT_TOKEN_BUDGET, DEFAULT_SCORE_FLOOR } = require('../memory-recall');
const { fenceUntrusted } = require('../untrusted-content');
const { getResolvedRuntimeGraph } = require('../core/runtime-graph');
const { fireAndForget } = require('../pr-monitor/reconcile-executor');

// Default-ON rail; `forge gate disable rail.memory_recall` turns tier-2 off. Mirrors
// autoShepherdRailEnabled (lib/commands/ship.js): absent id = enabled, fail-open to true.
const MEMORY_RECALL_RAIL = 'rail.memory_recall';
// bm25 candidate pool to rank/floor down from. Wider than what we inject so the floor +
// dedupe have room (mirrors the research "widen before ranking" guidance).
const MEMORY_RECALL_CANDIDATES = 25;
// Cross-turn dedupe memory: how many recently-injected keys to remember per session.
const SEEN_KEYS_CAP = 40;
const SESSION_START_DEADLINE_MS = 9_000;
const PROMPT_RECALL_DEADLINE_MS = 4_500;

function withinDeadline(work, fallback, deadlineMs, onTimeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (onTimeout) onTimeout();
      resolve(fallback);
    }, deadlineMs);
    Promise.resolve().then(work).then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

async function collectSessionStartData(projectRoot, opts, deadlineMs) {
  const fetchNotes = opts.fetchNotes || defaultFetchNotes;
  const fetchIssues = opts.fetchIssues || defaultFetchIssues;
  const fetchInbox = opts.fetchInbox || collectInbox;
  const bounded = work => withinDeadline(work, [], deadlineMs);
  const [notes, ready, claimed, inbox] = await Promise.all([
    bounded(() => fetchNotes(projectRoot, opts)),
    bounded(() => fetchIssues(projectRoot, 'ready', opts)),
    bounded(() => fetchIssues(projectRoot, 'in_progress', opts)),
    bounded(() => fetchInbox(projectRoot, opts)),
  ]);
  return { notes, ready, claimed, inbox };
}

function memoryRecallRailEnabled(projectRoot, resolveGraph = getResolvedRuntimeGraph) {
  try {
    const graph = resolveGraph({ projectRoot });
    const rail = [...(graph.rails || []), ...(graph.gates || [])].find(entry => entry.id === MEMORY_RECALL_RAIL);
    return !(rail?.enabled === false);
  } catch {
    return true;
  }
}

// Read the hook's stdin payload (Claude delivers UserPromptSubmit JSON on fd 0). Never
// throws — no stdin / a closed fd yields '' so the hook fails open.
function readHookStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function seenPath(projectRoot, sessionId) {
  const safe = String(sessionId || 'nosession').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(projectRoot, '.forge', 'memory-recall', `${safe}.json`);
}

// Keys injected on recent turns of THIS session (cross-turn dedupe). Best-effort: any read
// error yields [] so a first turn or a corrupt file simply injects without exclusion.
function loadSeenKeys(projectRoot, sessionId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(seenPath(projectRoot, sessionId), 'utf8'));
    return Array.isArray(parsed) ? parsed.filter(k => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

// Append the just-injected keys to the session's seen-list (newest last, capped). Best-effort.
function saveSeenKeys(projectRoot, sessionId, keys) {
  try {
    const merged = [...loadSeenKeys(projectRoot, sessionId), ...keys].slice(-SEEN_KEYS_CAP);
    const file = seenPath(projectRoot, sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(merged), 'utf8');
  } catch {
    // Dedupe is a nicety, not a correctness gate — a failed write never breaks the prompt.
  }
}

// Shadow-log the tier-2 recall decision (kernel issue f71784d3 step-0 instrument): one JSON
// line per run records what was retrieved and what cleared the floor, so the corpus-dependent
// scoreFloor can be tuned from real data instead of guessed. Capped so it never grows unbounded.
const SHADOW_LOG_MAX_BYTES = 512 * 1024;
// A shadow record is a tuning sample, not an archive, so its variable-length fields are bounded
// at the source — otherwise one pathological prompt serializes past the file cap on its own.
const SHADOW_MAX_TOKENS = 32;
const SHADOW_MAX_TOKEN_CHARS = 64;

function shadowLogPath(projectRoot) {
  return path.join(projectRoot, '.forge', 'memory-recall', 'shadow.jsonl');
}

// Append one JSON line, then evict whole records oldest-first until the file fits the byte cap.
// Trimming by bytes (not line count) is what keeps this hook's synchronous read/write bounded: a
// record that exceeds the cap alone leaves the file empty rather than permanently oversized.
// Best-effort — any failure is swallowed by the caller so logging never affects the hook result.
function appendShadowLog(projectRoot, record) {
  const file = shadowLogPath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  let size;
  try { size = fs.statSync(file).size; } catch { size = 0; }
  if (size <= SHADOW_LOG_MAX_BYTES) return;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const keep = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const cost = Buffer.byteLength(`${lines[i]}\n`, 'utf8');
    if (bytes + cost > SHADOW_LOG_MAX_BYTES) break;
    bytes += cost;
    keep.unshift(lines[i]);
  }
  fs.writeFileSync(file, keep.length ? `${keep.join('\n')}\n` : '', 'utf8');
}

function usage() {
  return 'Usage: forge hooks install --global [--harness codex|hermes|all] [--dry-run]\n'
    + '       forge hooks session-start --harness <claude> (machine-facing; emits SessionStart context)\n'
    + '       forge hooks inbox-pickup --harness <claude> (machine-facing; emits UserPromptSubmit context)\n'
    + '       forge hooks shepherd-events --harness <claude> (machine-facing; emits UserPromptSubmit PR-monitor deltas)\n'
    + '       forge hooks memory-recall --harness <claude> (machine-facing; emits UserPromptSubmit query-relevant memory)\n'
    + '       forge hooks capture --harness <claude> --trigger <precompact|stop> (machine-facing; captures a session summary on exit)';
}

/** Parse `--harness <h>` (defaults to claude) from a session-start arg slice. */
function parseHarness(rest) {
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--harness') return rest[i + 1] || 'claude';
    if (rest[i].startsWith('--harness=')) return rest[i].slice('--harness='.length);
  }
  return 'claude';
}

/** Parse `--trigger <t>` (defaults to stop) from a capture arg slice. */
function parseTrigger(rest) {
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--trigger') return rest[i + 1] || 'stop';
    if (rest[i].startsWith('--trigger=')) return rest[i].slice('--trigger='.length);
  }
  return 'stop';
}

// Capture bounds — the snapshot is a small NUDGE, not a manual. A hard issue cap + per-title
// cap + overall body cap keep the note (which is re-injected at the NEXT session's SessionStart
// digest) token-bounded. Tags mark it a session-summary typed note AND a Forge auto-capture
// (the latter is the dedupe/idempotency key that stops per-turn Stop flooding).
const CAPTURE_ISSUE_CAP = 5;
const CAPTURE_TITLE_CAP = 80;
const CAPTURE_NOTE_CAP = 1000;
const CAPTURE_AUTO_TAG = 'forge:auto-capture';
const CAPTURE_TAGS = ['type:session-summary', CAPTURE_AUTO_TAG];

/**
 * Build the deterministic, token-bounded capture note body. PURE. The body deliberately
 * carries NO timestamp (the store stamps its own) so an unchanged session state yields a
 * byte-identical body across repeated Stops — that identity is what the dedupe keys on.
 * @param {string} trigger - 'precompact' | 'stop'
 * @param {object[]} issues - in-progress issues (title/id defensively resolved)
 * @returns {string}
 */
function buildCaptureNote(trigger, issues) {
  const capped = issues.slice(0, CAPTURE_ISSUE_CAP);
  const lines = capped.map(issue => {
    const title = String((issue && (issue.title || issue.id)) || 'untitled').replace(/\s+/g, ' ').trim();
    return `- ${title.length > CAPTURE_TITLE_CAP ? `${title.slice(0, CAPTURE_TITLE_CAP)}…` : title}`;
  });
  const more = issues.length > capped.length ? `\n- …and ${issues.length - capped.length} more` : '';
  const body = lines.length
    ? `Session boundary (${trigger}) — in-progress:\n${lines.join('\n')}${more}`
    : `Session boundary (${trigger}) — no in-progress issues.`;
  // Reserve one char for the appended ellipsis so the FINAL note (incl. '…') is ≤ the cap,
  // never CAPTURE_NOTE_CAP + 1.
  return body.length > CAPTURE_NOTE_CAP ? `${body.slice(0, CAPTURE_NOTE_CAP - 1)}…` : body;
}

/** Wrap a digest into a harness-native SessionStart payload, or '' when unsupported. */
function formatSessionStart(harness, text) {
  if (harness === 'claude') {
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
    });
  }
  // No other harness has a verified session-start context surface — emit nothing.
  return '';
}

/**
 * `forge hooks session-start --harness <h>` — the CONTEXT hook Forge PUSHES to an agent
 * at session start. Machine-facing plumbing: emits harness-native SessionStart JSON on
 * stdout (Claude: { hookSpecificOutput.additionalContext }). FAIL-OPEN by construction —
 * any failure, an unsupported harness, or an empty digest yields '' (the harness then
 * injects nothing). NEVER throws and NEVER emits malformed JSON.
 *
 * @param {string[]} rest - args after the `session-start` action.
 * @param {string} projectRoot
 * @param {object} [opts] - injectable digest fetchers ({ fetchNotes, fetchIssues }).
 * @returns {Promise<{ success: boolean, output: string }>}
 */
async function handleSessionStart(rest, projectRoot, opts = {}) {
  const harness = parseHarness(rest);
  const capability = sessionStartCapability(harness);
  if (!capability.rendered) return { success: true, output: '', reason: capability.reason };
  try {
    (opts.fireAndForget || fireAndForget)({ projectRoot });
  } catch { /* the automatic trigger must never break session start */ }

  // The using-forge dispatch bootstrap is injected FIRST so Forge skills auto-trigger from turn
  // one (the Superpowers mechanism): a reasoning-driven system, not just harness description
  // matching. It is a deterministic file read that survives a kernel outage. The memory digest
  // (remembered notes + top open issues) is appended when present. Either alone is enough to
  // inject; a total blank yields '' (the harness injects nothing). FAIL-OPEN throughout.
  let dispatch = '';
  try {
    // No projectRoot: the dispatch skill is read from the Forge PACKAGE's canonical skills/
    // (a set-up consumer project has no root skills/, only generated mirrors).
    dispatch = (opts.loadDispatchText || loadDispatchText)() || '';
  } catch { /* keep '' — a missing dispatch skill must not break session start */ }

  let digestText = '';
  try {
    const data = await collectSessionStartData(
      projectRoot,
      opts,
      opts.sessionStartDeadlineMs || SESSION_START_DEADLINE_MS,
    );
    const digest = buildMemoryDigest(data, opts);
    if (!digest.empty) digestText = digest.text;
  } catch { /* fail-open: a kernel outage must not suppress the dispatch bootstrap */ }

  const combined = [dispatch, digestText].filter(Boolean).join('\n\n');
  if (!combined) return { success: true, output: '' };
  return { success: true, output: formatSessionStart(harness, combined) };
}

/** Wrap a digest into a harness-native UserPromptSubmit payload, or '' when unsupported. */
function formatUserPromptSubmit(harness, text) {
  if (harness === 'claude') {
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text },
    });
  }
  // No other harness has a verified UserPromptSubmit context surface — emit nothing.
  return '';
}

/**
 * `forge hooks inbox-pickup --harness <h>` — the COMPLIANT comment-back CONTEXT hook. On each
 * prompt it emits harness-native UserPromptSubmit JSON carrying a COMPACT count+pointer nudge
 * (Claude: { hookSpecificOutput.additionalContext }). It deliberately does NOT re-emit the full
 * fenced bodies: Claude APPENDS UserPromptSubmit additionalContext to history on every prompt
 * (it does not replace prior injections — a documented context-bloat limitation), so a compact
 * nudge keeps per-prompt accumulation negligible while still flagging "you have pending items,
 * run `forge inbox`". The full fenced digest surfaces once at SessionStart and on demand via
 * `forge inbox`. It reads the user's OWN kernel data via a supported hook — it NEVER injects
 * into a running session's stdin and NEVER drives the agent programmatically (Anthropic Usage
 * Policy, kernel issue 6d10c1a1). FAIL-OPEN: any failure, an unsupported harness, or nothing
 * pending yields '' (the harness injects nothing). NEVER throws, NEVER emits malformed JSON.
 *
 * @param {string[]} rest - args after the `inbox-pickup` action.
 * @param {string} projectRoot
 * @param {object} [opts] - injectable inbox fetchers ({ fetchClaims, fetchComments, ... }).
 * @returns {Promise<{ success: boolean, output: string }>}
 */
async function handleInboxPickup(rest, projectRoot, opts = {}) {
  try {
    const harness = parseHarness(rest);
    const capability = userPromptSubmitCapability(harness);
    if (!capability.rendered) return { success: true, output: '', reason: capability.reason };
    const pending = await collectInbox(projectRoot, opts);
    const nudge = buildInboxNudge(pending);
    if (nudge.empty) return { success: true, output: '' };
    return { success: true, output: formatUserPromptSubmit(harness, nudge.text) };
  } catch {
    // Fail-open: a context hook must never break a prompt.
    return { success: true, output: '' };
  }
}

/**
 * `forge hooks shepherd-events --harness <h>` — the PR-shepherd CONTEXT hook. On each
 * prompt it emits harness-native UserPromptSubmit JSON carrying a COMPACT, capped digest
 * of NEW PR-monitor events (verdict changes, failed checks, new threads, merged/closed)
 * since the last read across all open-PR journals, then advances the per-PR consumer
 * cursor so nothing re-surfaces. This is the CONSUMER side of the constant watcher: the
 * watch loop writes the journal, this pushes the deltas to the working agent. It reads the
 * user's OWN local journal via a supported hook — it NEVER injects into stdin and NEVER
 * drives the agent (Anthropic Usage Policy). FAIL-OPEN: any failure, an unsupported
 * harness, or no new events yields '' (the harness injects nothing). NEVER throws.
 *
 * @param {string[]} rest - args after the `shepherd-events` action.
 * @param {string} projectRoot
 * @param {object} [opts] - injectable digest collector ({ collectDigest }).
 * @returns {{ success: boolean, output: string }}
 */
function handleShepherdEvents(rest, projectRoot, opts = {}) {
  try {
    const harness = parseHarness(rest);
    const capability = userPromptSubmitCapability(harness);
    // Honest capability matrix: a non-Claude harness gets an explicit skip
    // reason as surface-only result metadata (for callers/telemetry) but NEVER
    // any injected output — `reason` must not drive the agent.
    if (!capability.rendered) return { success: true, output: '', reason: capability.reason };
    const collect = opts.collectDigest || collectDigest;
    const { text } = collect({ root: projectRoot });
    if (!text) return { success: true, output: '' };
    return { success: true, output: formatUserPromptSubmit(harness, text) };
  } catch {
    // Fail-open: a context hook must never break a prompt.
    return { success: true, output: '' };
  }
}

/**
 * `forge hooks memory-recall --harness <h>` — the QUERY-RELEVANT memory tier (tier-2). On each
 * prompt it reads the submitted prompt from the hook's stdin, ranks stored memories by BM25
 * relevance to it (NOT recency — that is the SessionStart digest's job), applies a relevance
 * floor + anaphora guard + cross-turn dedupe + a hard token budget, and emits the survivors as
 * harness-native UserPromptSubmit context. Complements the always-on recency digest: this one
 * answers "what memory is relevant to THIS turn".
 *
 * Compliance + safety (verified against the Claude Code hooks contract, kernel issue 781f6f65):
 *   - It READS its own hook stdin (the supported input channel) — it does NOT inject into a
 *     running session's stdin and never drives the agent (Anthropic Usage Policy).
 *   - additionalContext APPENDS to history every prompt, so the injection is tiny and gated:
 *     below the relevance floor, or on a low-signal (anaphora) prompt, it injects NOTHING.
 *   - Injected memory bodies are UNTRUSTED (a planted note could carry directives), so each is
 *     provenance-fenced.
 *   - UserPromptSubmit has a 30s timeout and blocks the prompt; the read is local BM25 over
 *     SQLite (sub-ms) and FAIL-OPEN — any error, a disabled rail, an unsupported harness, or
 *     nothing relevant yields '' and the prompt proceeds untouched. NEVER throws.
 *   - Kill-switch: `forge gate disable rail.memory_recall`.
 *
 * @param {string[]} rest - args after the `memory-recall` action.
 * @param {string} projectRoot
 * @param {object} [opts] - injectable seams for tests: { railEnabled, readInput, search,
 *   loadSeen, saveSeen, scoreFloor, tokenBudget }.
 * @returns {{ success: boolean, output: string }}
 */
async function runMemoryRecall(rest, projectRoot, opts = {}) {
  try {
    const harness = parseHarness(rest);
    const capability = userPromptSubmitCapability(harness);
    if (!capability.rendered) return { success: true, output: '', reason: capability.reason };

    const railEnabled = opts.railEnabled || memoryRecallRailEnabled;
    if (!railEnabled(projectRoot)) return { success: true, output: '' };

    const readInput = opts.readInput || readHookStdin;
    const { prompt, sessionId } = parseHookInput(readInput());
    if (!prompt) return { success: true, output: '' };

    const search = opts.search
      || ((root, query, limit, options) => projectMemory.searchRankedScored(root, query, limit, options));
    const loadSeen = opts.loadSeen || loadSeenKeys;
    const saveSeen = opts.saveSeen || saveSeenKeys;
    const appendShadow = opts.appendShadow || appendShadowLog;

    // Stopword-aware, unicode-safe tokenization lives HERE (single source); the driver's
    // buildMemoryFtsMatchOr only quotes+ORs whatever tokens it receives. Passing the raw prompt
    // to a token-AND match was the 0-recall bug (kernel issue f71784d3).
    const tokens = meaningfulTokens(prompt);
    const excludeKeys = await loadSeen(projectRoot, sessionId) || [];
      const hits = await search(
      projectRoot,
      tokens.join(' '),
      MEMORY_RECALL_CANDIDATES,
        { excludeKeys: excludeKeys.slice(0, 256) },
      ) || [];
      if (opts.deadline?.expired) return { success: true, output: '', reason: 'timeout' };
    const scoreFloor = typeof opts.scoreFloor === 'number' ? opts.scoreFloor : DEFAULT_SCORE_FLOOR;
    const { lines, injectedKeys } = selectInjection({
      query: prompt,
      hits,
      scoreFloor,
      tokenBudget: opts.tokenBudget || DEFAULT_TOKEN_BUDGET,
      excludeKeys,
    });

    // Step-0 instrument: record every real query (even ones that inject nothing) so the floor is
    // tuned from data. Own try/catch — a logging failure must NEVER fall through to the fail-open
    // outer catch (which would suppress a legitimate injection).
    if (tokens.length) {
      try {
        appendShadow(projectRoot, {
          sessionId,
          tokens: tokens.slice(0, SHADOW_MAX_TOKENS).map(t => t.slice(0, SHADOW_MAX_TOKEN_CHARS)),
          candidateCount: hits.length,
          candidates: hits.slice(0, 10).map(h => ({
            key: h && (h.memory_id || h.key),
            score: h && h.score,
          })),
          injectedKeys,
          scoreFloor,
        });
      } catch { /* best-effort: shadow logging never affects the hook result */ }
    }

    if (!lines.length) return { success: true, output: '' };

    if (opts.deadline?.expired) return { success: true, output: '', reason: 'timeout' };
    try {
      const pending = saveSeen(projectRoot, sessionId, injectedKeys);
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch { /* dedupe persistence never suppresses an injection */ }
    const fenced = lines.map(line => fenceUntrusted(line, { source: 'memory' })).join('\n');
    return { success: true, output: formatUserPromptSubmit(harness, fenced) };
  } catch {
    // Fail-open: a context hook must never break a prompt.
    return { success: true, output: '' };
  }
}

async function handleMemoryRecall(rest, projectRoot, opts = {}) {
  const harness = parseHarness(rest);
  const capability = userPromptSubmitCapability(harness);
  if (!capability.rendered) return { success: true, output: '', reason: capability.reason };
  const deadline = { expired: false };
  return withinDeadline(
    () => runMemoryRecall(rest, projectRoot, { ...opts, deadline }),
    { success: true, output: '', reason: 'timeout' },
    opts.promptRecallDeadlineMs || PROMPT_RECALL_DEADLINE_MS,
    () => { deadline.expired = true; },
  );
}

/**
 * `forge hooks capture --harness <h> --trigger <precompact|stop>` — the CAPTURE-on-exit hook.
 * PreCompact (before context compaction) and Stop (turn end) fire it; it snapshots a bounded
 * session-summary note into the memory store BEFORE learnings are lost. This is the WRITE half
 * of Forge memory (SessionStart only INJECTS). It PERSISTS to the store and emits NO stdout — a
 * Stop hook that printed text would inject into the turn, and it never drives the agent
 * (Anthropic Usage Policy). FAIL-OPEN: any failure, an unsupported harness, or nothing worth
 * capturing yields '' and no write. NEVER throws.
 *
 * Flooding guard: a plain Stop with nothing in progress is skipped (Stop fires every turn), and
 * a byte-identical repeat of the newest auto-capture note is skipped — so only meaningful,
 * changed session state is written. PreCompact records a boundary even when nothing is in
 * progress (unlike Stop), but it still goes through the same dedupe — a byte-identical
 * PreCompact repeat is skipped too.
 *
 * @param {string[]} rest - args after the `capture` action.
 * @param {string} projectRoot
 * @param {object} [opts] - injectable { fetchIssues, fetchNotes, append } for tests.
 * @returns {Promise<{ success: boolean, output: string }>}
 */
async function handleCapture(rest, projectRoot, opts = {}) {
  try {
    const harness = parseHarness(rest);
    const capability = sessionEndCapability(harness);
    if (!capability.rendered) return { success: true, output: '', reason: capability.reason };
    const trigger = parseTrigger(rest);

    const fetchIssues = opts.fetchIssues || defaultFetchIssues;
    const claimed = await fetchIssues(projectRoot, 'in_progress', opts);
    const issues = Array.isArray(claimed) ? claimed : [];

    // Stop fires every turn; a plain Stop with nothing in progress is not worth a note.
    // PreCompact is rare and precedes real context loss, so it records a boundary even with
    // nothing in progress — but it is NOT exempt from the byte-identical dedupe below.
    if (trigger !== 'precompact' && issues.length === 0) return { success: true, output: '' };

    const body = buildCaptureNote(trigger, issues);

    // Content dedupe: if the newest auto-capture note is byte-identical, this is a repeat of
    // an unchanged session — skip the write so the store never floods with duplicates.
    const fetchNotes = opts.fetchNotes || defaultFetchNotes;
    const recent = await fetchNotes(projectRoot, { ...opts, noteLimit: 10 });
    const lastCapture = (Array.isArray(recent) ? recent : [])
      .find(note => Array.isArray(note && note.tags) && note.tags.includes(CAPTURE_AUTO_TAG));
    if (lastCapture && lastCapture.note === body) return { success: true, output: '' };

    const append = opts.append || require('../memory/router').append;
    append(projectRoot, body, { tags: CAPTURE_TAGS });
    return { success: true, output: '' };
  } catch {
    // Fail-open: a capture hook must never break a session.
    return { success: true, output: '' };
  }
}

function parseInstallArgs(rest) {
  const parsed = { global: false, dryRun: false, harness: 'all', unknown: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--global') parsed.global = true;
    else if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '--harness') { parsed.harness = rest[i + 1]; i += 1; }
    else if (arg.startsWith('--harness=')) parsed.harness = arg.slice('--harness='.length);
    else parsed.unknown.push(arg);
  }
  return parsed;
}

function indent(text, prefix) {
  return String(text).replace(/\s+$/, '').split('\n').map(l => prefix + l).join('\n');
}

const GLOBAL_CONSENT_ERROR = [
  'forge hooks install writes GLOBAL (home-directory) harness config:',
  '  - Codex : $CODEX_HOME/config.toml (default ~/.codex/config.toml)',
  '  - Hermes: ~/.hermes/config.yaml',
  'Global config affects EVERY project on this machine, so Forge never writes it',
  'silently — re-run with the explicit --global flag to consent, and add --dry-run',
  'first to preview exactly what would be written.',
  usage(),
].join('\n');

const INSTALL_FOOTER = [
  '',
  'Note: the hook commands invoke `node .forge/hooks/forge-native-hook.js` relative',
  'to the workspace root (Codex and Hermes run hooks from there), so enforcement',
  'applies inside Forge-initialized projects; elsewhere the adapter is absent and',
  'the hook fails open (no deny decision is emitted), leaving tool calls untouched.',
];

/** Validate parsed install args; returns an error string or null when valid. */
function validateInstallArgs(parsed) {
  if (parsed.unknown.length > 0) return `Unknown argument(s): ${parsed.unknown.join(' ')}\n${usage()}`;
  if (!parsed.global) return GLOBAL_CONSENT_ERROR;
  const harnesses = parsed.harness === 'all' ? GLOBAL_HOOK_HARNESSES : [parsed.harness];
  if (!harnesses.every(h => GLOBAL_HOOK_HARNESSES.includes(h))) {
    return `Unknown --harness '${parsed.harness}'. Allowed: codex, hermes, all.\n${usage()}`;
  }
  return null;
}

/** Format the output lines for a single install result. */
function renderInstallResult(res, dryRun) {
  const lines = ['', `${res.harness} -> ${res.file}`];
  if (res.skipped) {
    lines.push(`  SKIPPED (left untouched): ${res.reason}`);
    if (res.backup) lines.push(`  Backed up existing file to: ${res.backup} (.bak)`);
    else if (dryRun) lines.push('  (dry-run: existing file would be backed up to a .bak and skipped)');
    return lines;
  }
  lines.push(indent(renderGlobalHookBlock(res.harness), '    '));
  if (dryRun) {
    lines.push(res.changed === false
      ? '  [dry-run] already up to date — a real run would change nothing'
      : '  [dry-run] would merge the block above into this file');
  } else {
    lines.push(res.changed === false
      ? '  Already up to date (no changes written).'
      : `  Merged Forge hooks into ${res.existed ? 'existing' : 'new'} config.`);
  }
  return lines;
}

/** The `install` action — consent-guarded GLOBAL hook install (Codex/Hermes). */
function handleInstall(args, flags, opts) {
  const parsed = parseInstallArgs(args.slice(1));
  const dryRun = parsed.dryRun || Boolean(flags.dryRun);

  const validationError = validateInstallArgs(parsed);
  if (validationError) return { success: false, error: validationError };

  const harnesses = parsed.harness === 'all' ? GLOBAL_HOOK_HARNESSES : [parsed.harness];
  // env/homeDir are injectable through the command opts so tests never touch the
  // real home directory; real dispatch passes neither and gets the defaults.
  const results = installGlobalHooks({ harnesses, dryRun, env: opts.env || process.env, homeDir: opts.homeDir });

  const out = [
    dryRun ? 'forge hooks install --global (dry-run — nothing will be written)' : 'forge hooks install --global',
    '',
    'This merges the following Forge hook block into each GLOBAL config,',
    'preserving all existing user config (idempotent re-runs):',
    ...results.flatMap(res => renderInstallResult(res, dryRun)),
    ...INSTALL_FOOTER,
  ];
  return { success: true, output: out.join('\n'), results };
}

async function handler(args, flags = {}, projectRoot, opts = {}) {
  const action = args[0];
  if (action === 'session-start') return handleSessionStart(args.slice(1), projectRoot, opts);
  if (action === 'inbox-pickup') return handleInboxPickup(args.slice(1), projectRoot, opts);
  if (action === 'shepherd-events') return handleShepherdEvents(args.slice(1), projectRoot, opts);
  if (action === 'memory-recall') return handleMemoryRecall(args.slice(1), projectRoot, opts);
  if (action === 'capture') return handleCapture(args.slice(1), projectRoot, opts);
  if (action === 'install') return handleInstall(args, flags, opts);
  return {
    success: false,
    error: `forge hooks supports: install, session-start, inbox-pickup, shepherd-events, capture.\n${usage()}`,
  };
}

module.exports = {
  name: 'hooks',
  description: 'Opt-in install of Forge native hooks into GLOBAL harness config (Codex/Hermes)',
  usage: usage(),
  flags: {
    '--global': 'Required consent flag — this command writes home-directory config',
    '--harness': 'codex | hermes | all (default: all)',
    '--dry-run': 'Preview the merge without writing anything',
  },
  handler,
  _internal: { appendShadowLog, SHADOW_LOG_MAX_BYTES },
};
