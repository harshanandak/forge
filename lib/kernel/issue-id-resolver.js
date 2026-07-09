'use strict';

const { ISSUE_COMMAND_EXIT_CODES } = require('./issue-command-contract');

// Git-style short issue-id resolution (kernel 9556660b). The kernel mints full
// UUIDs, which are hostile to type by hand; this module resolves an UNAMBIGUOUS
// hex prefix (>= 6 chars, e.g. `forge show 9556660b`) to the stored full id.
// It runs ONCE at the broker boundary (runIssueOperation) so every issue
// subcommand — including the batch-close fan-out and the gate.issue_verify
// read-back — consumes the RESOLVED id. Resolution is deliberately conservative:
//   * a full UUID never triggers a lookup (byte-identical fast path);
//   * non-hex tokens (legacy `forge-*` / imported Beads ids) pass through untouched;
//   * a prefix with ZERO matches passes through so the downstream not-found
//     error is unchanged;
//   * an EXACT stored id always wins over prefix expansion (a stored short
//     hex id is never mis-expanded or rejected as "too short").

const MIN_ISSUE_ID_PREFIX_LENGTH = 6;
const MAX_AMBIGUOUS_CANDIDATES = 5;

const FULL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A resolvable prefix: at least MIN hex chars, optionally continuing with hex
// and dashes (so a copied dashed UUID partial like `9556660b-a414` resolves too).
const HEX_PREFIX_PATTERN = /^[0-9a-f]{6}[0-9a-f-]*$/i;
// Pure hex but under the minimum length — candidate for the too-short guidance
// error (unless it exactly matches a stored id).
const SHORT_HEX_PATTERN = /^[0-9a-f]{1,5}$/i;

// The positional slots that carry issue ids, per kernel operation. Positions
// index the operation's positional tokens under the SAME rule every downstream
// consumer uses (firstPositionalArg / resolveDependencyEndpoints /
// buildCommentPayload): a positional is any token not starting with '-'. That
// keeps the resolved token exactly the one the downstream code reads — e.g.
// `claim --issue <id>` still resolves because `<id>` is positional 0 under this
// rule and flags.issue reads the same token. Operations absent from this map
// (list/ready/search/stats/create/...) take no issue id and pass through with
// no lookup — a search query is never mistaken for an id.
const OPERATION_ID_POSITIONS = Object.freeze({
	update: Object.freeze([0]),
	claim: Object.freeze([0]),
	release: Object.freeze([0]),
	comment: Object.freeze([0]),
	close: Object.freeze([0]),
	show: Object.freeze([0]),
	owns: Object.freeze([0]),
	children: Object.freeze([0]),
	'dep.add': Object.freeze([0, 1]),
	'dep.remove': Object.freeze([0, 1]),
});

// The `--issue=<id>` / `--blocks=<id>` =-joined flag forms carry ids inside a
// single token, invisible to the positional rule, so they are resolved by name.
const ID_FLAG_EQUALS_PATTERN = /^--(issue|blocks)=(.+)$/;

function tooShortError(token) {
	return {
		error: {
			code: 'FORGE_ISSUE_ID_PREFIX_TOO_SHORT',
			message: `Issue id prefix '${token}' is too short — use at least ${MIN_ISSUE_ID_PREFIX_LENGTH} hex characters `
				+ '(e.g. the first 8 of the id) or the full id.',
			exitCode: ISSUE_COMMAND_EXIT_CODES.validation,
			details: { prefix: token, min_length: MIN_ISSUE_ID_PREFIX_LENGTH },
		},
	};
}

function ambiguousError(token, candidates) {
	const shown = candidates.slice(0, MAX_AMBIGUOUS_CANDIDATES);
	const count = candidates.length > MAX_AMBIGUOUS_CANDIDATES
		? `${MAX_AMBIGUOUS_CANDIDATES}+`
		: String(candidates.length);
	const listing = shown
		.map(candidate => `${candidate.id} (${candidate.title ?? 'untitled'})`)
		.join('; ');
	return {
		error: {
			code: 'FORGE_ISSUE_ID_AMBIGUOUS',
			message: `Ambiguous issue id prefix '${token}' — matches ${count} issues: ${listing}. `
				+ 'Use a longer prefix or the full id.',
			exitCode: ISSUE_COMMAND_EXIT_CODES.validation,
			details: {
				prefix: token,
				candidates: shown.map(candidate => ({ id: candidate.id, title: candidate.title ?? null })),
			},
		},
	};
}

// Resolve one id token. `lookup(prefix, limit)` returns candidate rows
// ({ id, title }) whose id starts with `prefix`, ordered by id ascending —
// which guarantees an exact match (shortest id sharing the prefix) sorts first
// and is never pushed out by the limit. Returns { id } on success (possibly the
// untouched input) or { error: { code, message, exitCode, details } }.
// Resolve a hex ref (prefix >= 6, or short hex < 6) against the store. Returns { id } —
// the resolved full id, or `ref` untouched when nothing matches — or an { error } for the
// too-short / ambiguous cases. `reportToken` is what user-facing errors name (the original
// input the caller typed, which may be a handle rather than the bare hex).
async function resolveHexToken(ref, lookup, reportToken = ref) {
	const isPrefix = HEX_PREFIX_PATTERN.test(ref);
	const isShortHex = !isPrefix && SHORT_HEX_PATTERN.test(ref);
	if (!isPrefix && !isShortHex) return { id: ref };

	const needle = ref.toLowerCase();
	const candidates = (await lookup(needle, MAX_AMBIGUOUS_CANDIDATES + 1)) || [];
	const exact = candidates.find(
		candidate => candidate && typeof candidate.id === 'string' && candidate.id.toLowerCase() === needle,
	);
	if (exact) return { id: exact.id };
	if (isShortHex) return tooShortError(reportToken);
	if (candidates.length === 0) return { id: ref };
	if (candidates.length === 1) return { id: candidates[0].id };
	return ambiguousError(reportToken, candidates);
}

async function resolveIssueId(token, lookup) {
	if (typeof token !== 'string' || token.length === 0) return { id: token };
	if (FULL_UUID_PATTERN.test(token)) return { id: token };

	// A display handle is `<title-slug>-<short-id>` (kernel 1db53c60); its short-id is the
	// 8-char UUID prefix, so a handle ends in >= 8 trailing hex. Short legacy/Beads suffixes
	// (`forge-2a3bc9`, 6 hex) are NOT handles and pass through untouched.
	const handleSuffix = (/-([0-9a-f]{8,})$/i.exec(token) || [])[1] || null;

	if (HEX_PREFIX_PATTERN.test(token) || SHORT_HEX_PATTERN.test(token)) {
		const direct = await resolveHexToken(token, lookup);
		// A handle whose slug is all hex letters (e.g. `facade-decade-fee-add-1a2b3c4d`) also
		// matches the broad hex-prefix pattern; when the whole token matches nothing, retry
		// with its trailing short-id so the handle still resolves (CodeRabbit, PR #335).
		if (direct.id === token && handleSuffix && handleSuffix !== token) {
			const viaHandle = await resolveHexToken(handleSuffix, lookup, token);
			if (viaHandle.error || viaHandle.id !== handleSuffix) return viaHandle;
		}
		return direct;
	}

	// Non-hex token: a legacy/imported id (pass through so the store resolves it exactly),
	// or a display handle. Prefer an exact whole-token match first so imported handle-shaped
	// ids (`legacy-2a3bc9de`) still resolve; otherwise resolve by the handle's short-id.
	if (!handleSuffix) return { id: token };
	const whole = (await lookup(token.toLowerCase(), 2)) || [];
	const wholeExact = whole.find(
		candidate => candidate && typeof candidate.id === 'string' && candidate.id.toLowerCase() === token.toLowerCase(),
	);
	if (wholeExact) return { id: wholeExact.id };
	return resolveHexToken(handleSuffix, lookup, token);
}

// Resolve every id-carrying token in `args` for `operation`. Returns
// { args: resolvedArgs } (a copy; the input is never mutated) or the first
// { error } encountered. Operations without id slots return their args
// unchanged and never invoke the lookup.
async function resolveIssueIdArgs(operation, args = [], lookup) {
	const positions = OPERATION_ID_POSITIONS[operation];
	if (!positions) return { args };

	const resolved = [...args];
	let positionalIndex = 0;
	for (let index = 0; index < resolved.length; index += 1) {
		const token = resolved[index];
		if (typeof token !== 'string') continue;
		if (token.startsWith('-')) {
			const match = ID_FLAG_EQUALS_PATTERN.exec(token);
			if (match) {
				const result = await resolveIssueId(match[2], lookup);
				if (result.error) return result;
				resolved[index] = `--${match[1]}=${result.id}`;
			}
			continue;
		}
		if (positions.includes(positionalIndex)) {
			const result = await resolveIssueId(token, lookup);
			if (result.error) return result;
			resolved[index] = result.id;
		}
		positionalIndex += 1;
	}
	return { args: resolved };
}

module.exports = {
	MAX_AMBIGUOUS_CANDIDATES,
	MIN_ISSUE_ID_PREFIX_LENGTH,
	OPERATION_ID_POSITIONS,
	resolveIssueId,
	resolveIssueIdArgs,
};
