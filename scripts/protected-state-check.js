#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
	assertProtectedWriteAllowed,
	recordProtectedStateAuditEvent,
} = require('../lib/protected-state-surfaces');
const {
	authorizeAndConsumeProtectedStateWrites,
	isValidGitObjectId,
} = require('../lib/protected-state-authority');
const { verifyBunLockfileRegeneration } = require('../lib/bun-lockfile-proof');
const { resolveBaseRemote, resolveBaseBranch } = require('../lib/base-remote');
const realStagedFiles = new Set();
const deletedFiles = new Set();

function parseNameStatus(output) {
	const files = [];
	for (const line of output.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const parts = trimmed.split('\t').filter(Boolean);
		const status = parts[0] || '';
		if (/^[RC]/.test(status)) {
			if (parts[1]) deletedFiles.add(parts[1]);
			files.push(...parts.slice(1, 3));
		} else {
			if (status.startsWith('D') && parts[1]) deletedFiles.add(parts[1]);
			files.push(parts[1]);
		}
	}
	return [...new Set(files.filter(Boolean))];
}

function getStagedFiles() {
	let stagedFiles;
	if (process.env.FORGE_PROTECTED_STATE_STAGED_NAME_STATUS !== undefined) {
		stagedFiles = parseNameStatus(process.env.FORGE_PROTECTED_STATE_STAGED_NAME_STATUS);
	} else if (process.env.FORGE_PROTECTED_STATE_STAGED_FILES !== undefined) {
		stagedFiles = process.env.FORGE_PROTECTED_STATE_STAGED_FILES
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(Boolean);
	} else {
		const output = execFileSync('git', ['diff', '--cached', '--name-status', '--diff-filter=ACMRDT'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		stagedFiles = parseNameStatus(output);
		for (const file of stagedFiles) realStagedFiles.add(file);
	}

	if (process.env.FORGE_PROTECTED_STATE_STAGED_NAME_STATUS !== undefined || process.env.FORGE_PROTECTED_STATE_STAGED_FILES !== undefined) {
		try {
			execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		} catch (_error) {
			return [...new Set(stagedFiles)];
		}
		const realOutput = execFileSync('git', ['diff', '--cached', '--name-status', '--diff-filter=ACMRDT'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const indexedFiles = parseNameStatus(realOutput);
		for (const file of indexedFiles) realStagedFiles.add(file);
		stagedFiles.push(...indexedFiles);
	}
	return [...new Set(stagedFiles)];
}

function getStagedContent(file) {
	if (!realStagedFiles.has(file) && process.env.FORGE_PROTECTED_STATE_STAGED_CONTENTS_JSON) {
		const contents = JSON.parse(process.env.FORGE_PROTECTED_STATE_STAGED_CONTENTS_JSON);
		return Object.prototype.hasOwnProperty.call(contents, file) ? contents[file] : null;
	}

	try {
		return execFileSync('git', ['show', `:${file}`], {
			encoding: null,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	} catch (_error) {
		if (!deletedFiles.has(file)) return null;
		try {
			return execFileSync('git', ['show', `HEAD:${file}`], {
				encoding: null,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		} catch {
			return null;
		}
	}
}

function getCurrentHead() {
	try {
		const head = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		}).trim();
		return isValidGitObjectId(head) ? head : null;
	} catch {
		return null;
	}
}

const ABSENT_ENTRY = 'absent';
const LINE_SPLIT = /\r?\n/;

// Pathspec magic is only honoured when Git is not already in a forced pathspec
// mode. If the hook inherits GIT_LITERAL_PATHSPECS=1, `:(literal)<file>` is read
// as a filename spelled `:(literal)<file>`, every probe matches nothing, and the
// exemption predicate would compare absent against absent. The sibling GLOB /
// NOGLOB / ICASE switches distort matching the same way, so strip all four and
// keep the explicit `:(literal)` magic (paths with glob or colon characters stay
// safe). Keys are compared case-insensitively because Windows environment names
// are case-insensitive.
const PATHSPEC_ENV_KEYS = new Set([
	'GIT_LITERAL_PATHSPECS',
	'GIT_GLOB_PATHSPECS',
	'GIT_NOGLOB_PATHSPECS',
	'GIT_ICASE_PATHSPECS',
]);

function pathspecSafeEnv() {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (PATHSPEC_ENV_KEYS.has(key.toUpperCase())) delete env[key];
	}
	return env;
}

const GIT_PROBE_ENV = pathspecSafeEnv();

function gitCapture(args) {
	return execFileSync('git', args, {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		env: GIT_PROBE_ENV,
	}).trim();
}

// Resolve a commit-ish to a full object id, or null when it does not exist.
// Worktree-safe: plain `git rev-parse` already resolves per-worktree state.
function resolveCommit(revision) {
	try {
		const id = gitCapture(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]);
		return isValidGitObjectId(id) ? id : null;
	} catch {
		return null;
	}
}

// Best common ancestor of two commits, or null when there is none (unrelated
// histories) or the query fails. Used to tell "the merge side deleted this path"
// apart from "this path never existed on the merge side".
function resolveMergeBase(left, right) {
	let base;
	try {
		base = gitCapture(['merge-base', left, right]).split(LINE_SPLIT)[0].trim();
	} catch {
		return null;
	}
	return isValidGitObjectId(base) ? base : null;
}

// Git prints the mode but not the type for index entries; derive it so index and
// tree entries normalise to the same shape.
function objectTypeForMode(mode) {
	if (mode === '160000') return 'commit';
	if (mode === '040000' || mode === '40000') return 'tree';
	return 'blob';
}

// Normalised `<mode> <type> <oid>` for the staged index entry, ABSENT_ENTRY when
// the path is not in the index, or null when the answer is unknown. A conflicted
// path yields several stage lines and therefore null — fail closed.
// The mode matters: blob equality alone would exempt a real 100644 -> 100755
// index change on a protected path.
function stagedEntry(file) {
	let output;
	try {
		output = gitCapture(['ls-files', '--stage', '--', `:(literal)${file}`]);
	} catch {
		return null;
	}
	if (output === '') return ABSENT_ENTRY;
	const lines = output.split(LINE_SPLIT).filter(Boolean);
	if (lines.length !== 1) return null;
	const match = /^([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) [0-3]\t/.exec(lines[0]);
	if (!match) return null;
	return `${match[1]} ${objectTypeForMode(match[1])} ${match[2]}`;
}

// Same normalised shape for `<revision>:<file>`, so the comparison covers mode
// and object type as well as content.
function revisionEntry(revision, file) {
	let output;
	try {
		output = gitCapture(['ls-tree', revision, '--', `:(literal)${file}`]);
	} catch {
		return null;
	}
	if (output === '') return ABSENT_ENTRY;
	const lines = output.split(LINE_SPLIT).filter(Boolean);
	if (lines.length !== 1) return null;
	const match = /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40}|[0-9a-f]{64})\t/.exec(lines[0]);
	if (!match) return null;
	return `${match[1]} ${match[2]} ${match[3]}`;
}

// Adapter so the shared base-remote resolver runs through this script's
// pathspec-scrubbed git probe. The resolver ignores the options object it is
// handed here; the env scrub and quiet stdio come from `gitCapture`.
function baseRemoteProbe(_command, args) {
	return gitCapture(args);
}

// Resolve the repository's single canonical upstream ref, deterministically:
// the *base* remote (`upstream` preferred over `origin`, the same resolution
// `/ship` uses to pick a PR base), then that remote's default branch
// (`refs/remotes/<remote>/HEAD`, falling back to the conventional default
// names). Deliberately NOT the current branch's tracking remote: in a
// fork-style checkout the feature branch tracks the contributor-owned fork, and
// trusting it would let a change merged from the fork's default branch pass as
// "already published on the base" when it never reached the official repo.
// Returns a fully-qualified ref name, or null when it cannot be established.
function canonicalUpstreamRef() {
	const remote = resolveBaseRemote(baseRemoteProbe, process.cwd());
	try {
		const remotes = gitCapture(['remote']).split(/\r?\n/).map(line => line.trim());
		if (!remotes.includes(remote)) return null;
	} catch {
		return null;
	}

	const candidates = [];
	try {
		const head = gitCapture(['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`]);
		if (head) candidates.push(head);
	} catch {
		// no remote HEAD recorded; fall through to the resolved default branch
	}
	candidates.push(`refs/remotes/${remote}/${resolveBaseBranch(baseRemoteProbe, process.cwd(), remote)}`);
	candidates.push(`refs/remotes/${remote}/main`, `refs/remotes/${remote}/master`);

	for (const candidate of candidates) {
		if (resolveCommit(candidate)) return candidate;
	}
	return null;
}

// True when `commit` is contained in the canonical upstream line — not merely
// "some ref points at it". `--contains` over refs/remotes would accept an
// untrusted contributor remote or a hand-written `git update-ref
// refs/remotes/<anything>`; ancestry in the canonical ref is the property we
// actually want (these bytes are already published on the branch this repo
// integrates into, where the same gate ran).
//
// Honest limitation: refs under .git are locally writable, and anyone who can
// write .git can disable this hook outright. This gate defends against
// accidental and agent-authored protected edits and against merges from
// untrusted contributor remotes. It is NOT a security boundary against a local
// adversary — do not treat it as one.
function isCanonicalUpstreamAncestor(commit, canonicalRef) {
	if (!canonicalRef) return false;
	try {
		execFileSync('git', ['merge-base', '--is-ancestor', commit, canonicalRef], {
			stdio: ['ignore', 'ignore', 'ignore'],
		});
		return true;
	} catch {
		return false;
	}
}

// A merge is in progress when the per-worktree MERGE_HEAD exists. `--git-path`
// resolves the correct (possibly linked-worktree) git dir. Returns null unless a
// merge is genuinely in progress and every recorded id resolves; `trustedSides`
// holds only those MERGE_HEAD commits contained in the canonical upstream ref.
function readMergeProvenance() {
	let mergeHeadPath;
	try {
		mergeHeadPath = gitCapture(['rev-parse', '--git-path', 'MERGE_HEAD']);
	} catch {
		return null;
	}
	if (!mergeHeadPath) return null;
	let raw;
	try {
		raw = fs.readFileSync(path.resolve(process.cwd(), mergeHeadPath), 'utf8');
	} catch {
		return null;
	}
	const ids = raw
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(Boolean);
	if (ids.length === 0 || !ids.every(isValidGitObjectId)) return null;
	const resolved = ids.map(id => resolveCommit(id));
	if (resolved.some(commit => commit === null)) return null;
	// HEAD anchors the "no net change" half of the predicate. If it cannot be
	// resolved we know nothing about the commit being built, so there is no
	// exemption context at all — fail closed rather than fall back to the sides.
	const head = resolveCommit('HEAD');
	if (!head) return null;
	const canonicalRef = canonicalUpstreamRef();
	return {
		head,
		trustedSides: resolved.filter(commit => isCanonicalUpstreamAncestor(commit, canonicalRef)),
	};
}

// Exemption predicate. While a merge is in progress, a staged protected path is
// exempt only when the committer introduced no net change AND the content has
// trusted provenance:
//   - staged entry (mode + object) === the entry at HEAD: no net change versus the branch being
//     committed onto, so there is no provenance question at all; or
//   - staged entry === the entry on a MERGE_HEAD contained in the canonical
//     upstream ref: the bytes are already published on the line this repo
//     integrates into, where the same gate ran.
// A purely local merge side earns no exemption — otherwise anyone could smuggle a
// protected edit in on a local branch and merge it. The merge base is likewise not
// a permitted side: matching only the base means both sides were reverted, an edit.
// Anything else stays blocked, and any failed git query fails closed.
function createMergeExemption() {
	const merge = readMergeProvenance();
	if (!merge) return () => false;
	const trustedRevisions = [merge.head, ...merge.trustedSides];
	return file => {
		const staged = stagedEntry(file);
		if (staged === null) return false;
		if (staged === ABSENT_ENTRY) {
			// Git just reported this path as staged, so an absent index entry is only
			// honest for a staged deletion; otherwise the probe contradicts git and
			// the answer is unknown.
			if (!deletedFiles.has(file)) return false;
			// Absent on a trusted side is not proof that side deleted anything — a
			// path that only ever existed on HEAD is absent upstream too, so a manual
			// `git rm` during a merge would otherwise exempt itself. Demand that the
			// merge side actually removed it: present at the merge base, gone at the
			// side. Fail closed when the base or either probe is unavailable.
			return merge.trustedSides.some(side => {
				if (revisionEntry(side, file) !== ABSENT_ENTRY) return false;
				const base = resolveMergeBase(merge.head, side);
				if (!base) return false;
				const baseEntry = revisionEntry(base, file);
				return baseEntry !== null && baseEntry !== ABSENT_ENTRY;
			});
		}
		return trustedRevisions.some(revision => {
			const entry = revisionEntry(revision, file);
			return entry !== null && entry === staged;
		});
	};
}

async function main() {
	const actor =
		process.env.FORGE_PROTECTED_STATE_ACTOR ||
		process.env.FORGE_ACTOR ||
		process.env.USER ||
		process.env.USERNAME ||
		'unknown';
	const sourceHead = getCurrentHead();
	const isMergeCarryOver = createMergeExemption();
	const mergeExempt = [];
	const probes = getStagedFiles()
		.map(file => {
			const probe = assertProtectedWriteAllowed(file, { actor, operation: 'staged_edit' });
			if (!probe.requiredSurface) return { probe };
			// Deliberately after the lockfile branch: bun.lock keeps its own
			// regeneration proof, which a merge must never skip.
			if (probe.path !== 'bun.lock' && isMergeCarryOver(probe.path)) {
				mergeExempt.push(probe.path);
				return { probe: { ...probe, allowed: true, decision: 'allowed_merge_carry_over' } };
			}
			if (probe.path === 'bun.lock' && probe.requiredSurface === 'lockfiles') {
				return {
					probe,
					directDecision: {
						...probe,
						...verifyBunLockfileRegeneration(process.cwd()),
					},
				};
			}

			const content = getStagedContent(probe.path);
			if (content === null) return { probe };
			return {
				probe,
				request: {
					actor,
					surface: probe.requiredSurface,
					path: probe.path,
					content,
					operation: deletedFiles.has(probe.path) ? 'staged_delete' : 'staged_edit',
					sourceHead,
				},
			};
		});
	const protectedProbes = probes.filter(entry => entry.request);
	const authorization = await authorizeAndConsumeProtectedStateWrites(
		process.cwd(),
		protectedProbes.map(entry => entry.request),
	);
	let authorizationIndex = 0;
	const decisions = probes
		.map(entry => {
			if (entry.directDecision) return entry.directDecision;
			if (!entry.request) return entry.probe;
			const trustedDecision = authorization.decisions[authorizationIndex++];
			return trustedDecision.allowed
				? trustedDecision
				: { ...entry.probe, ...trustedDecision, repairHint: entry.probe.repairHint };
		})
		.filter(decision => !decision.allowed);

	for (const decision of decisions) {
		const audit = recordProtectedStateAuditEvent(decision, { cwd: process.cwd() });
		if (!audit.success) {
			console.error(`WARN: Failed to record protected-state audit for ${decision.path}: ${audit.error}`);
		}
	}

	for (const file of mergeExempt) {
		console.log(`OK: ${file} matches a merge side unchanged (merge in progress); no net edit introduced.`);
	}

	if (decisions.length === 0) {
		console.log('OK: No protected state edits detected.');
		process.exit(0);
	}

	console.error('ERROR: Protected state edit detected. Direct edits to these paths are blocked:');
	for (const decision of decisions) {
		console.error(`  - ${decision.path} [${decision.requiredSurface}]`);
		console.error(`    Decision: ${decision.decision}`);
		console.error(`    Reason: ${decision.reason}`);
		console.error(`    Repair: ${decision.repairHint}`);
	}
	console.error('');
	console.error('Use the owning Forge API surface, then stage the generated result if that command explicitly owns it.');
	process.exit(1);
}

main().catch(error => {
	console.error(`Protected state check failed: ${error.message}`);
	process.exit(1);
});
