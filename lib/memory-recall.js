'use strict';

/**
 * @module memory-recall
 *
 * Pure selection core for the per-turn memory-recall hook (the query-relevant tier-2
 * that complements the recency digest pushed at SessionStart). Kept free of stdin/fs so
 * it is fully testable; lib/commands/hooks.js does the I/O wiring around it.
 *
 * Design constraints (verified against the Claude Code hooks contract + external memory
 * research, kernel issue 781f6f65):
 *   - UserPromptSubmit additionalContext APPENDS to history every prompt, so a per-turn
 *     injector must stay tiny: a hard token budget, a relevance floor, and cross-turn
 *     dedupe. Below the bar -> inject NOTHING (silence is safe; a wrong memory at
 *     authority every turn is not).
 *   - Anaphora guard: a trivial query ("continue", "fix it") carries no retrieval signal,
 *     so ranking on it is worse than silence. Require a minimum of distinct content tokens.
 *   - Scope is a FILTER; relevance is the RANKER (bm25). Never sort by recency here — that
 *     is the recency digest's job, not tier-2's.
 */

// A query needs at least this many distinct content tokens to be worth ranking on.
// Below it we treat the prompt as anaphora and inject nothing.
const MIN_QUERY_TOKENS = 2;

// Default token budget for the whole tier-2 injection. Deliberately small: it rides on
// EVERY prompt, and it must never starve the always-on SessionStart digest.
const DEFAULT_TOKEN_BUDGET = 400;

// Default relevance floor for the live hook path so it never runs floor-less. bm25 is
// more-negative-is-better, so 0 keeps every token-AND FTS match: the ACTIVE relevance gate
// today is the token-AND match plus the anaphora guard, and the numeric floor is a knob to
// be tightened (made negative) once shadow-logging measurement (781f6f65 step 0) shows where
// the corpus's relevant/irrelevant boundary sits. Named + wired so the default is explicit,
// not an accidental `undefined`.
const DEFAULT_SCORE_FLOOR = 0;

// Short/function words that carry no retrieval signal. Not exhaustive — just enough to
// stop pure anaphora ("do that now", "same for it") from clearing the guard.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'to', 'of', 'in', 'on', 'at', 'by', 'is',
  'it', 'this', 'that', 'these', 'those', 'do', 'did', 'now', 'then', 'same', 'again',
  'continue', 'go', 'ok', 'okay', 'yes', 'no', 'fix', 'please', 'thanks', 'with', 'as',
  'we', 'i', 'you', 'he', 'she', 'they', 'them', 'his', 'her', 'my', 'our', 'your',
]);

// Rough token estimate: ~4 chars/token, matching lib/memory-digest.js's convention so
// the two tiers budget on the same scale.
function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

/**
 * Parse the JSON payload Claude Code delivers on a UserPromptSubmit hook's stdin. Never
 * throws — any malformed input yields an empty prompt so the hook fails open.
 *
 * @param {string} raw
 * @returns {{ prompt: string, sessionId: (string|null) }}
 */
function parseHookInput(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { prompt: '', sessionId: null };
    }
    const prompt = typeof parsed.prompt === 'string' ? parsed.prompt : '';
    const sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : null;
    return { prompt, sessionId };
  } catch {
    return { prompt: '', sessionId: null };
  }
}

/**
 * Distinct content tokens in a query — lowercased, length >= 3, minus stopwords. The
 * anaphora guard counts these; the FTS layer does its own tokenization for the actual match.
 *
 * @param {string} query
 * @returns {string[]}
 */
function meaningfulTokens(query) {
  const seen = new Set();
  // Unicode-aware split, matching the FTS tokenizer (/[\p{L}\p{N}]+/gu in the kernel driver)
  // so non-Latin prompts (Cyrillic/CJK/accented) aren't silently stripped — otherwise the
  // anaphora guard would disable recall for every non-Latin-script user.
  for (const rawToken of String(query || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!rawToken) continue;
    if (STOPWORDS.has(rawToken)) continue;
    // The length>=3 filter suppresses ASCII noise ("it", "do"), but CJK words are 1-2 chars
    // and any non-ASCII token is inherently content — keep those regardless of length.
    if (rawToken.length < 3 && /^[a-z0-9]+$/.test(rawToken)) continue;
    seen.add(rawToken);
  }
  return [...seen];
}

/**
 * Choose which memories to inject this turn. PURE.
 *
 * @param {object} args
 * @param {string} args.query — the submitted prompt
 * @param {Array<{key:string, value:string, score:number}>} args.hits — bm25-ordered
 *   (best/lowest score first), already relevance-only (token-AND matched)
 * @param {number} [args.scoreFloor] — keep only hits with score <= floor (more negative =
 *   stronger). Omit/null to rely on the FTS match alone. The VALUE is corpus-dependent and
 *   should be tuned from shadow-logging measurement, not guessed — this is the knob.
 * @param {number} [args.tokenBudget]
 * @param {string[]} [args.excludeKeys] — keys injected on recent turns (cross-turn dedupe)
 * @returns {{ lines: string[], injectedKeys: string[] }}
 */
function selectInjection({ query, hits, scoreFloor = null, tokenBudget = DEFAULT_TOKEN_BUDGET, excludeKeys = [] }) {
  // Anaphora guard: a query with too little signal ranks garbage — stay silent.
  if (meaningfulTokens(query).length < MIN_QUERY_TOKENS) {
    return { lines: [], injectedKeys: [] };
  }

  const exclude = new Set(excludeKeys || []);
  const lines = [];
  const injectedKeys = [];
  let spent = 0;

  for (const hit of hits || []) {
    if (!hit || typeof hit.key !== 'string') continue;
    if (exclude.has(hit.key)) continue;
    // Relevance floor: below the bar contributes nothing. bm25 is more-negative-is-better.
    if (typeof scoreFloor === 'number' && !(typeof hit.score === 'number' && hit.score <= scoreFloor)) {
      continue;
    }
    const body = String(hit.value == null ? '' : hit.value);
    const cost = estimateTokens(body);
    if (spent + cost > tokenBudget) {
      // Budget exhausted; stop rather than skip-and-continue so the strongest fit.
      break;
    }
    lines.push(body);
    injectedKeys.push(hit.key);
    spent += cost;
  }

  return { lines, injectedKeys };
}

module.exports = {
  MIN_QUERY_TOKENS,
  DEFAULT_TOKEN_BUDGET,
  DEFAULT_SCORE_FLOOR,
  estimateTokens,
  parseHookInput,
  meaningfulTokens,
  selectInjection,
};
