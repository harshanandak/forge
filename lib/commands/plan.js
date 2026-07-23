/**
 * Plan Command - Kernel Issue Integration
 * Creates implementation plan after research is complete
 *
 * Security: Uses execFileSync instead of exec/execSync to prevent command injection
 * OWASP: Mitigates A03:2021 - Injection vulnerabilities
 *
 * @module commands/plan
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { resolveIssueBackend } = require('../issue-backend');
const { runIssueOperation } = require('../forge-issues');

// Constants for security
// Note: cwd is resolved at call-time via getExecOptions() to avoid stale require-time snapshots
const EXEC_TIMEOUT = 120000; // 2 minutes max per command
function getExecOptions() {
	return { encoding: 'utf8', cwd: process.cwd(), timeout: EXEC_TIMEOUT };
}

const MAX_SLUG_LENGTH = 100;
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

/**
 * Human-readable label for the issue backend that created an issue.
 * The kernel is the only backend; anything unresolved prints a neutral label
 * rather than naming a store the issue did not come from.
 *
 * @param {string} [backend] - Resolved issue backend ('kernel').
 * @returns {string} Display label ('Kernel' or a neutral 'Issue').
 * @private
 */
function issueBackendLabel(backend) {
	if (backend === 'kernel') return 'Kernel';
	return 'Issue';
}

/**
 * Validate feature slug format
 * Ensures slug matches expected pattern and doesn't contain path traversal
 *
 * @param {string} slug - Feature slug to validate
 * @returns {{valid: boolean, error?: string}} Validation result
 * @private
 */
function validateFeatureSlug(slug) {
	if (!slug || typeof slug !== 'string') {
		return { valid: false, error: 'Feature slug must be a non-empty string' };
	}

	// Length limits (prevent DoS)
	const MIN_SLUG_LENGTH = 3;

	if (slug.length < MIN_SLUG_LENGTH) {
		return { valid: false, error: `Slug too short (minimum ${MIN_SLUG_LENGTH} characters)` };
	}

	if (slug.length > MAX_SLUG_LENGTH) {
		return { valid: false, error: `Slug too long (maximum ${MAX_SLUG_LENGTH} characters)` };
	}

	// Only allow lowercase alphanumeric and hyphens; must start and end with alphanumeric
	const slugPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;  // NOSONAR S5852 - no backtracking: anchored, alternation is possessive
	if (!slugPattern.test(slug)) {
		return {
			valid: false,
			error: `Invalid slug format '${slug}'. Only lowercase letters, numbers, and hyphens allowed.`,
		};
	}

	return { valid: true };
}

/**
 * Build the issue description used when creating the kernel tracking issue.
 * Strategic scope appends a design-doc pointer derived from a sanitized slug.
 *
 * @param {string} featureName
 * @param {string} researchPath
 * @param {'tactical'|'strategic'} scope
 * @returns {{description: string}|{error: string}}
 * @private
 */
function buildFeatureIssueDescription(featureName, researchPath, scope) {
	let description = `Research: ${researchPath}`;

	if (scope === 'strategic') {
		// Sanitize derived slug: keep only safe characters (OWASP A03)
		const featureSlug = featureName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/(?:^-+|-+$)/g, '').slice(0, MAX_SLUG_LENGTH);  // NOSONAR S5852 - non-overlapping anchors, no backtracking
		const slugValidation = validateFeatureSlug(featureSlug);
		if (!slugValidation.valid) {
			return { error: `Cannot generate valid slug from feature name: ${slugValidation.error}` };
		}
		const dateSlug = new Date().toISOString().slice(0, 10);
		description += `\n\nDesign: docs/work/${dateSlug}-${featureSlug}/plan.md`;
	}

	return { description };
}

/**
 * Read research document from file
 *
 * @param {string} featureSlug - Feature slug (must match /^[a-z0-9-]+$/)
 * @returns {{success: boolean, content?: string, path?: string, error?: string}} Research document result
 * @example
 * const research = readResearchDoc('payment-integration');
 * if (research.success) {
 *   console.log(research.content);
 * }
 */
function readResearchDoc(featureSlug) {
	// Validate slug format (OWASP A03 - Injection prevention)
	const validation = validateFeatureSlug(featureSlug);
	if (!validation.valid) {
		return {
			success: false,
			error: validation.error,
		};
	}

	try {
		const researchPath = path.join(process.cwd(), 'docs', 'research', `${featureSlug}.md`);

		if (!fs.existsSync(researchPath)) {
			return {
				success: false,
				error: `Research document not found: ${researchPath}\n\nRun /research ${featureSlug} first to create research document.`,
			};
		}

		// Check file size to prevent resource exhaustion (max 5MB)
		const stats = fs.statSync(researchPath);
		if (stats.size > MAX_FILE_SIZE) {
			return {
				success: false,
				error: `Research document too large (${Math.round(stats.size / 1024 / 1024)}MB). Maximum size: 5MB`,
			};
		}

		const content = fs.readFileSync(researchPath, 'utf8');

		return {
			success: true,
			content,
			path: `docs/research/${featureSlug}.md`,
		};
	} catch (error) {
		return {
			success: false,
			error: `Failed to read research document: ${error.message}`,
		};
	}
}

/**
 * Detect scope from research content
 * Determines whether feature is tactical (quick fix) or strategic (architecture change)
 *
 * Detection strategy:
 * 1. Check explicit "Scope Assessment" section first
 * 2. Fall back to keyword analysis for strategic indicators
 * 3. Default to tactical if no clear signals
 *
 * @param {string} researchContent - Research document markdown content
 * @returns {{type: 'tactical'|'strategic', requiresDesignDoc: boolean, reason: string}} Scope analysis result
 * @example
 * const scope = detectScope(researchMarkdown);
 * if (scope.type === 'strategic') {
 *   console.log('Requires design doc:', scope.reason);
 * }
 */
function detectScope(researchContent) {
	if (!researchContent || typeof researchContent !== 'string') {
		return {
			type: 'tactical',
			requiresDesignDoc: false,
			reason: 'Invalid research content (defaulting to tactical)',
		};
	}

	// Check explicit Scope Assessment section (highest priority)
	// Use line-by-line parsing to avoid ReDoS
	const lines = researchContent.split('\n');
	let scopeLine = null;
	let inScopeSection = false;

	for (const line of lines) {
		if (/##\s*Scope Assessment/i.test(line)) {
			inScopeSection = true;
			continue;
		}
		if (inScopeSection && /^##\s+/.test(line)) {
			// Hit next section, stop searching
			break;
		}
		if (inScopeSection && /\*\*Strategic\/Tactical\*\*:\s*(Strategic|Tactical)/i.test(line)) {
			scopeLine = line;
			break;
		}
	}

	const scopeMatch = scopeLine ? /\*\*Strategic\/Tactical\*\*:\s*(Strategic|Tactical)/i.exec(scopeLine) : null;

	if (scopeMatch) {
		const type = scopeMatch[1].toLowerCase();
		return {
			type,
			requiresDesignDoc: type === 'strategic',
			reason: `Explicit scope declaration: ${scopeMatch[1]}`,
		};
	}

	// Strategic keyword detection (fallback)
	const strategicKeywords = [
		'architecture',
		'architectural',
		'database schema',
		'api endpoint',
		'major',
		'breaking change',
		'migration',
		'refactor',
		'redesign',
	];

	const lowerContent = researchContent.toLowerCase();
	const foundKeywords = strategicKeywords.filter(keyword => lowerContent.includes(keyword));

	if (foundKeywords.length > 0) {
		return {
			type: 'strategic',
			requiresDesignDoc: true,
			reason: `Strategic keywords detected: ${foundKeywords.join(', ')}`,
		};
	}

	// Default to tactical (safe fallback)
	return {
		type: 'tactical',
		requiresDesignDoc: false,
		reason: 'No strategic indicators found (tactical by default)',
	};
}

/**
 * Create an issue via the Forge Kernel backend (bd-free).
 *
 * Mirrors `forge issue create` on the kernel: routes through runIssueOperation with
 * the kernel broker instead of shelling out to `bd create`. Used by `forge plan` when
 * the kernel is the only issue backend, so planning needs no bd binary installed.
 *
 * @param {string} featureName
 * @param {string} researchPath
 * @param {'tactical'|'strategic'} scope
 * @param {object} [options]
 * @param {string} [options.projectRoot] - Repo root for the kernel store (defaults to cwd)
 * @param {object} [options.kernelBroker] - Pre-built kernel broker (optional)
 * @param {Function} [options.runIssueOperation] - Injectable runner (tests)
 * @returns {Promise<{success: boolean, issueId?: string, description?: string, error?: string}>}
 */
const PLAN_ISSUE_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Parse plan's own args: extract a `--issue <id>` / `--issue=<id>` selector and
 * return the remaining positional feature name. The global flag parser only
 * recognizes an allowlist, so — like `stage`/`worktree` — plan extracts its own.
 *
 * @param {string[]} args
 * @returns {{ featureName: string|undefined, issueId: string|null }}
 * @private
 */
function parsePlanArgs(args = []) {
	let issueId = null;
	let issueFlagSeen = false;
	const positional = [];
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === '--issue') {
			issueFlagSeen = true;
			const next = i + 1 < args.length ? args[i + 1] : null;
			// A following flag (or nothing) is NOT a value — treat as a missing value
			// (F5) so we never silently fall back to CREATE a duplicate issue.
			if (typeof next === 'string' && !next.startsWith('-')) {
				issueId = next;
				i += 1;
			}
			continue;
		}
		if (typeof arg === 'string' && arg.startsWith('--issue=')) {
			issueFlagSeen = true;
			issueId = arg.slice('--issue='.length) || null;
			continue;
		}
		positional.push(arg);
	}
	return { featureName: positional[0], issueId, issueFlagError: issueFlagSeen && !issueId };
}

/**
 * Link an EXISTING issue instead of creating a new one (B4). Verifies the issue
 * exists via `issue show` so `plan --issue <id>` links the claim-first flow's
 * issue rather than forking a duplicate.
 *
 * @param {string} issueId
 * @param {object} [options]
 * @returns {Promise<{success: boolean, issueId?: string, error?: string}>}
 * @private
 */
async function linkExistingIssue(issueId, options = {}) {
	if (!issueId || typeof issueId !== 'string') {
		return { success: false, error: 'An issue id is required to link an existing issue' };
	}

	const run = options.runIssueOperation || runIssueOperation;
	const projectRoot = options.projectRoot || process.cwd();
	const issueBackend = options.issueBackend || 'kernel';

	try {
		const result = await run(
			'show',
			[issueId],
			projectRoot,
			{
				issueBackend,
				useKernelBroker: true,
				kernelBroker: options.kernelBroker,
			},
		);

		if (!result || result.ok === false || result.success === false) {
			const message = result?.error || 'issue not found';
			return { success: false, error: `Issue ${issueId} not found: ${message}` };
		}

		const resolvedId = result?.data?.id ?? result?.issueId ?? result?.id ?? issueId;
		return { success: true, issueId: resolvedId };
	} catch (error) {
		return { success: false, error: `Failed to look up issue ${issueId}: ${error.message}` };
	}
}

/**
 * Read the current git branch (empty string when detached / not a repo).
 * @private
 */
function getCurrentBranch() {
	try {
		return execFileSync('git', ['branch', '--show-current'], { ...getExecOptions(), stdio: 'pipe' }).trim();  // NOSONAR S4036 - hardcoded CLI command, developer tool context
	} catch {
		return '';
	}
}

function isDefaultBranch(name) {
	return name === '' || name === 'main' || name === 'master';
}

/**
 * When linking an existing issue, reuse the current feature branch instead of
 * forking a second branch (B4). Only creates a fresh `feat/<slug>` branch when
 * still sitting on a default branch.
 *
 * @param {string} featureSlug
 * @returns {{success: boolean, branchName?: string, reused?: boolean, error?: string}}
 * @private
 */
function reuseOrCreateFeatureBranch(featureSlug) {
	const current = getCurrentBranch();
	if (!isDefaultBranch(current)) {
		return { success: true, branchName: current, reused: true };
	}
	return createFeatureBranch(featureSlug);
}

/** Read `git rev-parse --git-common-dir` (null on failure). @private */
function getGitCommonDir(cwd) {
	try {
		return execFileSync('git', ['rev-parse', '--git-common-dir'], { ...getExecOptions(), cwd, stdio: 'pipe' }).trim();  // NOSONAR S4036 - hardcoded CLI command, developer tool context
	} catch {
		return null;
	}
}

/** An already-resolved kernel driver (tests / commandOpts), or null. @private */
function injectedPlanDriver(options = {}) {
	return options.kernelDriver || options.driver || null;
}

/**
 * Run `fn(driver)` with a kernel driver: an injected one (tests / commandOpts)
 * when present, otherwise a throwaway migrated driver built from the project
 * root and CLOSED afterwards, so it never leaves an open DB handle (which would
 * lock the dir on Windows). `plan` is NOT an issue command, so
 * `resolveCommandOpts` gives it no driver — building here is what lets the
 * branch->issue registry be consulted in the real CLI (both the F4c conflict
 * read and the F1 linkage write). `fn(null)` when the kernel is unavailable.
 * @private
 */
async function withPlanDriver(options, fn) {
	const injected = injectedPlanDriver(options);
	if (injected) {
		return fn(injected);
	}

	let driver;
	try {
		const { buildMigratedKernelIssueDeps } = require('../kernel/cli-broker-factory');
		const deps = await buildMigratedKernelIssueDeps({ projectRoot: options.projectRoot || process.cwd() });
		driver = deps.kernelDriver || null;
	} catch {
		return fn(null);
	}
	try {
		return fn(driver);
	} finally {
		if (driver && typeof driver.close === 'function') driver.close();
	}
}

/**
 * Which issue the CURRENT branch is already bound to: the kernel worktree
 * registry (authoritative) first, then a UUID encoded in the branch name.
 * @private
 */
function currentBranchIssueFromDriver(driver, currentBranch) {
	if (driver && typeof driver.listWorktrees === 'function') {
		try {
			const rows = driver.listWorktrees() || [];
			// Only an ACTIVE (live) linkage row binds the branch: a superseded/stale
			// registration for a reused branch name must not trigger a false split-state
			// conflict against the OLD issue (R4/be18881c). Tolerate a null state for
			// rows written before the state column was populated.
			const match = rows.find(row => row && row.branch === currentBranch && row.issue_id
				&& (row.state === 'active' || row.state == null));
			if (match) return match.issue_id;
		} catch {
			// fall through to branch-name parsing
		}
	}
	const encoded = PLAN_ISSUE_UUID_RE.exec(currentBranch || '');
	return encoded ? encoded[0] : null;
}

/**
 * Refuse to link issue B onto a branch already bound to issue A (F4c): otherwise
 * plan would link B while stage read/writes flow to A (split state). Consults the
 * kernel worktree registry (via a built driver when the CLI supplies none) so a
 * plan-created slug branch — whose name lacks a UUID — is still caught.
 * @returns {Promise<string|null>} an error message when there is a conflict.
 * @private
 */
async function detectBranchIssueConflict(options, explicitIssueId) {
	const current = getCurrentBranch();
	if (isDefaultBranch(current)) return null;
	const boundIssue = await withPlanDriver(options, driver => currentBranchIssueFromDriver(driver, current));
	if (boundIssue && boundIssue !== explicitIssueId) {
		return `Current branch ${current} is already bound to issue ${boundIssue}; refusing to link ${explicitIssueId} (split state). Switch branches or link the matching issue.`;
	}
	return null;
}

/**
 * Persist the branch->issue linkage into the kernel worktree registry (F1) so a
 * plan-created branch resolves to its issue for kernel-authoritative stage
 * state. Best-effort, kernel-only. @private
 */
async function registerBranchIssueLinkage(options, branch, issueId) {
	if (!branch || !issueId) return;
	const cwd = options.projectRoot || process.cwd();
	// F6 defaultStageWarn pattern: write to stderr so a dropped linkage never
	// pollutes machine-readable stdout, yet leaves a trace even under FORGE_JSON=1.
	const warn = options.warn || (message => process.stderr.write(`${message}\n`));
	await withPlanDriver(options, driver => {
		if (!driver || typeof driver.registerWorktree !== 'function') return;
		try {
			driver.registerWorktree({
				git_common_dir: getGitCommonDir(cwd) || cwd,
				path: cwd,
				branch,
				actor: null,
				issue_id: issueId,
				work_folder: null,
				registered_at: new Date().toISOString(),
				state: 'active',
			});
		} catch (error) {
			// Best-effort: linkage failure must not fail plan, but it must NOT be
			// silent (R3) — otherwise ship later fail-closes with no signal at plan
			// time about the dropped branch->issue linkage.
			warn(`[forge] could not register branch->issue linkage for ${branch} -> ${issueId}: ${error.message}`);
		}
	});
}

/**
 * Resolve the tracking issue for a plan: LINK an explicit issue, else CREATE in
 * the kernel (the only issue backend — planning needs no bd binary). Extracted to
 * avoid a nested ternary in executePlan.
 *
 * @returns {Promise<{success: boolean, issueId?: string, error?: string}>}
 * @private
 */
async function resolveTrackingIssue({ explicitIssueId, issueBackend, featureName, researchPath, scope, options }) {
	if (explicitIssueId) {
		return linkExistingIssue(explicitIssueId, { ...options, issueBackend });
	}
	return createKernelIssue(featureName, researchPath, scope, options);
}

async function createKernelIssue(featureName, researchPath, scope, options = {}) {
	if (!featureName || !researchPath) {
		return {
			success: false,
			error: 'Feature name and research path are required',
		};
	}

	if (scope !== 'tactical' && scope !== 'strategic') {
		return {
			success: false,
			error: `Invalid scope '${scope}'. Must be 'tactical' or 'strategic'`,
		};
	}

	const built = buildFeatureIssueDescription(featureName, researchPath, scope);
	if (built.error) {
		return { success: false, error: built.error };
	}
	const description = built.description;

	const run = options.runIssueOperation || runIssueOperation;
	const projectRoot = options.projectRoot || process.cwd();

	try {
		const result = await run(
			'create',
			[`--title=${featureName}`, `--description=${description}`, '--type=feature', '--priority=2'],
			projectRoot,
			{ issueBackend: 'kernel', useKernelBroker: true, kernelBroker: options.kernelBroker },
		);

		// The kernel returns the issue-command contract ({ ok, data: { id } }); a failure
		// is { ok:false, error }. Guard both the contract shape and any { success:false }.
		if (!result || result.ok === false || result.success === false) {
			const message = result?.error || 'Kernel issue creation failed';
			return { success: false, error: `Failed to create kernel issue: ${message}` };
		}

		const issueId = result?.data?.id ?? result?.issueId ?? result?.id;
		if (!issueId) {
			return {
				success: false,
				error: 'Failed to extract issue ID from kernel create result',
			};
		}

		return { success: true, issueId, description };
	} catch (error) {
		return {
			success: false,
			error: `Failed to create kernel issue: ${error.message}`,
		};
	}
}

/**
 * Create feature branch
 * Creates a new git branch following feat/<slug> convention WITHOUT switching
 * the shared checkout's HEAD (uses `git branch`, not `git checkout -b`).
 * Switching HEAD in the shared working tree corrupts concurrent agents
 * (kernel issue aa14966c); isolated work happens in a dedicated worktree.
 *
 * Security: Uses execFileSync with array args to prevent command injection
 *
 * @param {string} featureSlug - Feature slug (must match /^[a-z0-9-]+$/)
 * @returns {{success: boolean, branchName?: string, error?: string}} Branch creation result
 * @example
 * const result = createFeatureBranch('payment-integration');
 * if (result.success) {
 *   console.log('Created branch:', result.branchName);
 * }
 */
function createFeatureBranch(featureSlug) {
	// Validate slug format (OWASP A03 - Injection prevention)
	const validation = validateFeatureSlug(featureSlug);
	if (!validation.valid) {
		return {
			success: false,
			error: validation.error,
		};
	}

	try {
		const branchName = `feat/${featureSlug}`;

		// Check if branch already exists
		try {
			execFileSync('git', ['rev-parse', '--verify', branchName], { ...getExecOptions(), stdio: 'pipe' });  // NOSONAR S4036 - hardcoded CLI command, no user input, developer tool context
			return {
				success: false,
				error: `Branch ${branchName} already exists\n\nWork on it in an isolated checkout: forge worktree create ${featureSlug}\n(or, working solo: git switch ${branchName})`,
			};
		} catch {
			// Branch doesn't exist, continue (expected case)
		}

		// Create the branch WITHOUT switching the shared checkout's HEAD.
		// Historically this used `git checkout -b`, which flipped the shared
		// working tree onto the new branch and corrupted concurrent agents
		// (kernel issue aa14966c). `git branch` creates the ref at the current
		// HEAD without touching the working tree; isolated work happens in a
		// dedicated worktree (`forge worktree create`), never the shared tree.
		execFileSync('git', ['branch', branchName], getExecOptions());  // NOSONAR S4036 - hardcoded CLI command, no user input, developer tool context

		return {
			success: true,
			branchName,
		};
	} catch (error) {
		// Check for timeout
		if (error.killed && error.signal === 'SIGTERM') {
			return {
				success: false,
				error: 'Git command timed out after 2 minutes.',
			};
		}

		// Provide actionable error message
		const gitNotFound = error.message.includes('ENOENT') || error.message.includes('not found');
		const errorMsg = gitNotFound
			? 'git command not found. Ensure git is installed and in PATH'
			: `Failed to create branch: ${error.message}`;

		return {
			success: false,
			error: errorMsg,
		};
	}
}

/**
 * Extract design decisions from research content
 * Parses "Key Decisions" section from research markdown
 *
 * Supports two formats:
 * 1. Numbered with reasoning: "### Decision 1: Title\n**Reasoning**: ..."
 * 2. Simple headings: "### Decision Title"
 *
 * @param {string} researchContent - Research document markdown content
 * @returns {{decisions: string[]}} Extracted design decisions
 * @example
 * const design = extractDesignDecisions(researchMarkdown);
 * design.decisions.forEach(d => console.log(d));
 */
function extractDesignDecisions(researchContent) { // NOSONAR S3776
	if (!researchContent || typeof researchContent !== 'string') {
		return { decisions: [] };
	}

	const decisions = [];

	// Match numbered decisions with reasoning (preferred format)
	const decisionPattern = /###\s*Decision\s*\d+:\s*([^\r\n]+)[\r\n]+\*\*Reasoning\*\*:\s*([^\r\n]+)/gi; // NOSONAR S5852 - uses [^\r\n]+ (bounded), handles both LF and CRLF
	let match;

	while ((match = decisionPattern.exec(researchContent)) !== null) {
		decisions.push(`${match[1]}\nReasoning: ${match[2]}`);
	}

	// Fall back to simpler format if no numbered decisions found
	// Uses line-by-line parsing to avoid ReDoS from [\s\S]*? patterns
	if (decisions.length === 0) {
		const lines = researchContent.split('\n');
		let inDecisionsSection = false;
		for (const line of lines) {
			if (/^##\s+Key Decisions/i.test(line)) {
				inDecisionsSection = true;
				continue;
			}
			if (inDecisionsSection && /^##\s+/.test(line)) break;
			if (inDecisionsSection && /^###\s+/.test(line)) {
				const cleaned = line.replace(/^###\s+/, '').trim();
				if (cleaned) decisions.push(cleaned);
			}
		}
	}

	return {
		decisions,
	};
}

/**
 * Extract TDD tasks from research content
 * Parses "TDD Test Scenarios" section and converts to RED-GREEN-REFACTOR tasks
 *
 * Each scenario generates 3 tasks:
 * - RED: Write test for scenario
 * - GREEN: Implement scenario
 * - REFACTOR: Refactor scenario code
 *
 * @param {string} researchContent - Research document markdown content
 * @returns {Array<{phase: 'RED'|'GREEN'|'REFACTOR', description: string}>} TDD-ordered tasks
 * @example
 * const tasks = extractTasksFromResearch(researchMarkdown);
 * tasks.forEach(t => console.log(`[${t.phase}] ${t.description}`));
 */
function extractTasksFromResearch(researchContent) {
	if (!researchContent || typeof researchContent !== 'string') {
		return [];
	}

	const tasks = [];

	// Split by lines to avoid ReDoS - safer than complex regex
	const lines = researchContent.split('\n');
	let inScenariosSection = false;
	const scenarioLines = [];

	for (const line of lines) {
		if (/##[^#]*TDD Test Scenarios/i.test(line)) {
			inScenariosSection = true;
			continue;
		}
		if (inScenariosSection && /^##\s+[^#]/.test(line)) {
			// Hit next top-level section (## but not ###), stop
			break;
		}
		if (inScenariosSection) {
			scenarioLines.push(line);
		}
	}

	// Extract scenario headings (safe - simple pattern, no backtracking)
	const scenarioPattern = /###\s*Scenario\s*\d+:\s*([^\n]+)/gi;
	const sectionContent = scenarioLines.join('\n');
	let match;

	while ((match = scenarioPattern.exec(sectionContent)) !== null) {
		const scenario = match[1].trim();

		if (!scenario) {
			continue; // Skip empty scenarios
		}

		// Each scenario becomes 3 tasks (RED-GREEN-REFACTOR cycle)
		tasks.push(
			{ phase: 'RED', description: `Write test: ${scenario}` },
			{ phase: 'GREEN', description: `Implement: ${scenario}` },
			{ phase: 'REFACTOR', description: `Refactor: ${scenario}` },
		);
	}

	return tasks;
}

/**
 * Detect DRY (Don't Repeat Yourself) violations during Phase 2 codebase exploration
 * Checks whether an existing implementation already covers the planned feature.
 * If a match is found, the design doc's approach section must be updated to
 * "extend existing [file/function]" rather than "create new".
 *
 * @param {{ searchTerm: string, matches: Array<{ file: string, line: number }> }} params
 * @returns {{ violation: boolean, existingFile?: string, existingLine?: number }}
 * @example
 * const result = detectDRYViolation({ searchTerm: 'validateSlug', matches: [{ file: 'lib/utils.js', line: 42 }] });
 * // => { violation: true, existingFile: 'lib/utils.js', existingLine: 42 }
 *
 * const empty = detectDRYViolation({ searchTerm: 'foo', matches: [] });
 * // => { violation: false }
 */
function detectDRYViolation({ searchTerm: _searchTerm, matches } = {}) {
	if (!Array.isArray(matches) || matches.length === 0) {
		return { violation: false };
	}

	const first = matches[0];
	return {
		violation: true,
		existingFile: first.file,
		existingLine: first.line,
		allMatches: matches,
	};
}

/**
 * Apply YAGNI (You Aren't Gonna Need It) filter to planned tasks
 * Checks whether each task maps to a specific requirement, success criterion,
 * or edge case in the design doc. Tasks with no anchor are flagged as potential scope creep.
 *
 * Supports two call modes:
 * - Single task: { task: string, designDoc: string } → { flagged, anchor?, reason? }
 * - Multi-task:  { tasks: string[], designDoc: string } → { allFlagged, flaggedTasks, message? }
 *
 * Matching logic: any keyword from the task title found in the designDoc (case-insensitive).
 *
 * @param {{ task?: string, tasks?: string[], designDoc: string }} params
 * @returns {{ flagged?: boolean, anchor?: string, reason?: string, allFlagged?: boolean, flaggedTasks?: string[], message?: string }}
 * @example
 * applyYAGNIFilter({ task: 'Add validateSlug function', designDoc: '## Success Criteria\n- validateSlug validates slug format' })
 * // => { flagged: false, anchor: 'validateSlug' }
 *
 * applyYAGNIFilter({ task: 'Add dark mode toggle', designDoc: '## Success Criteria\n- validateSlug validates slug format' })
 * // => { flagged: true, reason: 'No matching requirement found in design doc' }
 *
 * applyYAGNIFilter({ tasks: ['Task A', 'Task B'], designDoc: '## Purpose\nFoo' })
 * // => { allFlagged: true, flaggedTasks: ['Task A', 'Task B'], message: "Design doc doesn't cover all tasks — needs amendment" }
 *
 * applyYAGNIFilter({ tasks: ['validateSlug function', 'dark mode toggle'], designDoc: '## Success Criteria\n- validateSlug validates slug' })
 * // => { allFlagged: false, flaggedTasks: ['dark mode toggle'] }
 */
const YAGNI_STOP_WORDS = new Set(['a', 'an', 'the', 'add', 'in', 'of', 'to', 'for', 'is', 'it', 'and', 'or', 'with', 'that', 'this', 'be', 'as', 'by', 'at', 'on', 'if']);

function meaningfulKeywords(title) {
	return String(title).toLowerCase().split(/\s+/)
		.map(kw => kw.replace(/^[`'"()[\]{},]+|[`'"()[\]{},.:;!?]+$/g, '')) // NOSONAR S5852 — literal character class, no backtracking
		.filter(kw => kw.length > 2 && !YAGNI_STOP_WORDS.has(kw));
}

function applyYAGNIFilter({ task, tasks, designDoc } = {}) {
	const lowerDoc = typeof designDoc === 'string' ? designDoc.toLowerCase() : '';

	// Multi-task mode: returns allFlagged + flaggedTasks list for partial violations
	if (Array.isArray(tasks)) {
		if (tasks.length === 0) return { allFlagged: false, flaggedTasks: [] };

		const flaggedTasks = tasks.filter(t => {
			const keywords = meaningfulKeywords(t);
			return keywords.length === 0 || !keywords.some(kw => lowerDoc.includes(kw));
		});

		if (flaggedTasks.length === tasks.length) {
			return {
				allFlagged: true,
				flaggedTasks,
				message: "Design doc doesn't cover all tasks — needs amendment",
			};
		}

		return { allFlagged: false, flaggedTasks };
	}

	// Single-task mode
	const keywords = meaningfulKeywords(task || '');
	const matchedKeyword = keywords.find(kw => lowerDoc.includes(kw));

	if (matchedKeyword) {
		return { flagged: false, anchor: matchedKeyword };
	}

	return { flagged: true, reason: 'No matching requirement found in design doc' };
}

/**
 * Execute full plan workflow
 * Orchestrates tactical or strategic planning workflow
 *
 * Tactical workflow (quick fixes, <1 day):
 * 1. Read research document
 * 2. Detect scope (tactical)
 * 3. Create kernel issue
 * 4. Create feature branch
 * → Next: /dev command
 *
 * Strategic workflow (architecture changes, >1 day):
 * 1. Read research document
 * 2. Detect scope (strategic)
 * 3. Create kernel issue with design doc link
 * 4. Create feature branch
 * → Next: Create design doc, then /dev command
 *
 * @param {string} featureName - Feature name (human-readable, e.g., "Payment Integration")
 * @returns {Promise<{
 *   success: boolean,
 *   scope?: 'tactical'|'strategic',
 *   issueBackend?: 'kernel',
 *   issueId?: string,
 *   beadsIssueId?: string,
 *   branchName?: string,
 *
 *   summary?: string,
 *   nextCommand?: string,
 *   error?: string
 * }>} Execution result. `issueId` is the created kernel issue id, and
 *   `issueBackend` names the backend ('kernel'). `beadsIssueId` is a deprecated
 *   alias of `issueId` kept for output-shape compatibility — it never implied a
 *   Beads store and now always holds the kernel issue id.
 * @example
 * const result = await executePlan('Payment Integration');
 * if (result.success) {
 *   console.log(result.summary);
 *   console.log('Next:', result.nextCommand);
 * }
 */
async function executePlan(featureName, options = {}) { // NOSONAR S3776
	if (!featureName || typeof featureName !== 'string') {
		return {
			success: false,
			error: 'Feature name is required and must be a string',
		};
	}

	// Resolve the active issue backend (explicit opts > env > .forge/config.yaml >
	// default 'kernel'). The kernel is bd-free, so planning needs no bd binary.
	const issueBackend = resolveIssueBackend({
		deps: options,
		env: options.env || process.env,
		projectRoot: options.projectRoot,
		warn: () => {},
	});

	const featureSlug = featureName.toLowerCase()
		.replaceAll(/[^a-z0-9-]/g, '-')
		.split('-').filter(Boolean).join('-');

	// Validate generated slug
	const validation = validateFeatureSlug(featureSlug);
	if (!validation.valid) {
		return {
			success: false,
			error: `Invalid feature name generates invalid slug '${featureSlug}': ${validation.error}`,
		};
	}

	try {
		// Step 1: Read research document
		const research = readResearchDoc(featureSlug);
		if (!research.success) {
			return {
				success: false,
				error: `Research document not found: ${research.error}`,
			};
		}

		// Step 2: Detect scope (tactical vs strategic)
		const scope = detectScope(research.content);

		// Step 3: Resolve the tracking issue. `--issue <id>` LINKS an existing issue
		// (claim-first flow) instead of creating a duplicate (B4). Otherwise create
		// through the kernel broker (no bd binary involved).
		const explicitIssueId = options.issue || options.issueId || null;

		// F4c: never link issue B onto a branch already bound to issue A.
		if (explicitIssueId) {
			const conflict = await detectBranchIssueConflict({ ...options, issueBackend }, explicitIssueId);
			if (conflict) {
				return { success: false, error: conflict };
			}
		}

		const issue = await resolveTrackingIssue({
			explicitIssueId, issueBackend, featureName, researchPath: research.path, scope: scope.type, options,
		});
		if (!issue.success) {
			return {
				success: false,
				error: explicitIssueId
					? `Failed to link issue: ${issue.error}`
					: `Failed to create issue: ${issue.error}`,
			};
		}

		// Step 4: Resolve the feature branch. When linking, reuse the current
		// feature branch instead of forking a second branch (B4).
		const branch = explicitIssueId
			? reuseOrCreateFeatureBranch(featureSlug)
			: createFeatureBranch(featureSlug);
		if (!branch.success) {
			return {
				success: false,
				error: `Failed to create branch: ${branch.error}`,
			};
		}

		// F1: persist the branch->issue linkage so a plan-created branch resolves
		// to its issue for kernel-authoritative stage state (dev/validate/ship).
		// Kernel-only, best-effort.
		if (issueBackend === 'kernel') {
			await registerBranchIssueLinkage({ ...options, issueBackend }, branch.branchName, issue.issueId);
		}

		// Build result summary
		const result = {
			success: true,
			scope: scope.type,
			issueBackend,
			issueId: issue.issueId,
			// Deprecated alias of issueId, retained for output-shape compatibility.
			// It never implied a Beads store and now always holds the kernel id.
			beadsIssueId: issue.issueId,
			branchName: branch.branchName,
			linked: Boolean(explicitIssueId),
			// A FRESH branch was created (HEAD did NOT move — aa14966c). Stage
			// commands resolve the CHECKED-OUT branch, so the user must enter an
			// isolated checkout on this branch before /dev, or stage state resolves
			// against the default branch (no linkage → ship dead-ends). When the
			// branch was reused, HEAD is already on it and /dev works directly.
			branchCreated: !branch.reused,
			summary: explicitIssueId
				? `Plan linked to existing issue ${issue.issueId} (${scope.type} scope)`
				: `Plan created for ${featureName} (${scope.type} scope)`,
			// Strategic path: /propose not yet implemented — falls through to /dev until it is
			nextCommand: '/dev',
		};

		return result;
	} catch (error) {
		return {
			success: false,
			error: `Unexpected error in executePlan: ${error.message}`,
		};
	}
}

module.exports = {
	name: 'plan',
	description: 'Create implementation plan from researched feature context',
	handler: async (args, _flags, projectRoot, opts = {}) => {
		const { featureName, issueId, issueFlagError } = parsePlanArgs(args);
			// F5: `--issue` with no value must ERROR, never silently create a duplicate.
			if (issueFlagError) {
				return { success: false, error: '--issue requires a value (an existing issue id to link).' };
			}
		const result = await executePlan(featureName, {
			...opts,
			projectRoot,
			issue: issueId ?? opts.issue ?? opts.issueId,
		});
		if (!result.success) {
			return result;
		}

		const header = result.linked ? 'Plan linked' : 'Plan created';
		const lines = [`${header}: ${result.summary || result.branchName || featureName}`];
		if (result.issueId) lines.push(`${issueBackendLabel(result.issueBackend)}: ${result.issueId}`);
		if (result.branchName) lines.push(`Branch: ${result.branchName}`);
		if (result.branchCreated) {
			// A fresh branch was created but HEAD was NOT switched (aa14966c). Stage
			// commands (/dev, /validate, /ship) resolve the CHECKED-OUT branch — from
			// the shared tree that is still the default branch, which has no
			// branch->issue linkage, so ship would dead-end. Direct the user into an
			// isolated checkout on the new branch first.
			const slug = String(result.branchName).replace(/^feat\//, '');
			lines.push('Next: work on this branch in an isolated checkout (HEAD stays put in the shared tree):');
			lines.push(`  forge worktree create ${slug}    # concurrent-safe; checks out the existing ${result.branchName}`);
			lines.push(`  # or, working solo:  git switch ${result.branchName}`);
			lines.push(`Then run ${result.nextCommand || '/dev'} from that checkout.`);
		} else if (result.nextCommand) {
			lines.push(`Next: ${result.nextCommand}`);
		}

		return {
			...result,
			output: lines.join('\n'),
		};
	},
	readResearchDoc,
	detectScope,
	createKernelIssue,
	createFeatureBranch,
	extractDesignDecisions,
	extractTasksFromResearch,
	detectDRYViolation,
	applyYAGNIFilter,
	executePlan,
	issueBackendLabel,
	registerBranchIssueLinkage,
	currentBranchIssueFromDriver,
};
