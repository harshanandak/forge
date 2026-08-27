/**
 * Ship Command - PR Creation with Auto-Generated Documentation
 * Creates pull requests with comprehensive body generated from research and metrics
 *
 * Security: Uses execFileSync for command execution to prevent injection
 * Automation: Extracts key decisions, test scenarios, and coverage metrics
 *
 * @module commands/ship
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { fireAndForget } = require('../pr-monitor/reconcile-executor');
const { getResolvedRuntimeGraph } = require('../core/runtime-graph');
const { resolveBaseRemote, resolveBaseBranch } = require('../base-remote');

const AUTO_SHEPHERD_RAIL = 'rail.auto_shepherd';

/**
 * Whether the default-ON `rail.auto_shepherd` rail permits auto-starting the PR
 * watcher. Reads the SAME resolved runtime graph the `forge gate enable|disable`
 * surface writes (`workflow.gates.rail.auto_shepherd.enabled`), so the toggle is
 * config-honest. FAIL-OPEN: only an explicit `enabled === false` disables it — a
 * missing rail or any resolution error falls back to enabled (the default), and
 * this NEVER throws (ship must not fail on a config read).
 *
 * @param {string} [projectRoot]
 * @param {Function} [resolveGraph] - injectable graph resolver (tests).
 * @returns {boolean}
 */
function autoShepherdRailEnabled(projectRoot = process.cwd(), resolveGraph = getResolvedRuntimeGraph) {
	try {
		const graph = resolveGraph({ projectRoot });
		const rail = [...(graph.rails || []), ...(graph.gates || [])]
			.find(entry => entry.id === AUTO_SHEPHERD_RAIL);
		return !(rail && rail.enabled === false);
	} catch {
		return true;
	}
}

function getExecOptions() {
	return { encoding: 'utf8', cwd: process.cwd(), timeout: 120000 };
}

function getGhCheckOptions() {
	return { encoding: 'utf8', cwd: process.cwd(), timeout: 3000 };
}

const VALID_PR_PREFIXES = ['feat:', 'fix:', 'docs:', 'refactor:', 'test:', 'chore:', 'perf:', 'ci:', 'build:', 'revert:'];

const MAX_SLUG_LENGTH = 100;
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

function isCommandNotFound(error) {
	return error.message.includes('ENOENT') || error.message.includes('not found');
}

function getGitExecOptions(cwd = process.cwd()) {
	return { ...getExecOptions(), cwd };
}

function getQuietGitExecOptions(cwd = process.cwd()) {
	return { ...getGitExecOptions(cwd), stdio: 'pipe' };
}

function refreshBaseReference(exec = execFileSync, cwd = process.cwd(), remoteName, baseBranch) {
	exec(
		'git',
		['fetch', '--quiet', '--no-tags', remoteName, `refs/heads/${baseBranch}:refs/remotes/${remoteName}/${baseBranch}`],
		getQuietGitExecOptions(cwd),
	);
}

function getBranchReadiness(options = {}) {
	const exec = options.exec || execFileSync;
	const cwd = options.cwd || process.cwd();
	const baseRemote = options.baseRemote || resolveBaseRemote(exec, cwd);
	const baseBranch = options.baseBranch || resolveBaseBranch(exec, cwd, baseRemote);
	const baseRef = `${baseRemote}/${baseBranch}`;
	const branchName = exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], getGitExecOptions(cwd)).trim();

	if (!branchName || branchName === 'HEAD') {
		return {
			ready: false,
			branchName: branchName || 'HEAD',
			baseRemote,
			baseBranch,
			error: 'Current HEAD is detached. Check out a feature branch before running /ship.',
		};
	}

	try {
		refreshBaseReference(exec, cwd, baseRemote, baseBranch);
	} catch (error) {
		return {
			ready: false,
			branchName,
			baseRemote,
			baseBranch,
			error: `Unable to refresh ${baseRef} before comparing branch readiness. Verify that remote '${baseRemote}' and branch '${baseBranch}' can be fetched. Git said: ${error.message}`,
		};
	}

	let counts;
	try {
		counts = exec('git', ['rev-list', '--left-right', '--count', `${baseRef}...HEAD`], getGitExecOptions(cwd)).trim();
	} catch (error) {
		return {
			ready: false,
			branchName,
			baseRemote,
			baseBranch,
			error: `Unable to compare the current branch against ${baseRef}. Verify that remote '${baseRemote}' and branch '${baseBranch}' exist. Git said: ${error.message}`,
		};
	}

	const [behindRaw = '0', aheadRaw = '0'] = counts.split(/\s+/);
	const behind = Number.parseInt(behindRaw, 10) || 0;
	const ahead = Number.parseInt(aheadRaw, 10) || 0;

	let hasDiff = false;
	try {
		exec('git', ['diff', '--quiet', `${baseRef}...HEAD`, '--'], getGitExecOptions(cwd));
	} catch (error) {
		if (error.status === 1) {
			hasDiff = true;
		} else {
			return {
				ready: false,
				branchName,
				baseRemote,
				baseBranch,
				ahead,
				behind,
				error: `Unable to inspect the tree diff against ${baseRef}. Git said: ${error.message}`,
			};
		}
	}

	if (!hasDiff) {
		return {
			ready: false,
			branchName,
			baseRemote,
			baseBranch,
			ahead,
			behind,
			error:
				`Current branch ${branchName} has no diff against ${baseRef}. ` +
				'It is not PR-ready because all changes are already upstream or the branch collapsed onto the base during rebase.',
		};
	}

	return {
		ready: true,
		branchName,
		baseRemote,
		baseBranch,
		ahead,
		behind,
	};
}

/**
 * Validate feature slug format
 * Ensures slug matches expected pattern and doesn't contain path traversal
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

function extractKeyDecisions(researchContent) { // NOSONAR S3776
	if (!researchContent || typeof researchContent !== 'string') return [];
	const decisions = [];

	// Split by sections to avoid ReDoS - safer than complex regex
	const lines = researchContent.split('\n');
	let inDecisionsSection = false;
	let sectionContent = [];

	for (const line of lines) {
		if (/^##\s+Key Decisions/i.test(line)) {
			inDecisionsSection = true;
			continue;
		}
		if (inDecisionsSection && /^##\s+/.test(line)) {
			// Hit next section, stop
			break;
		}
		if (inDecisionsSection) {
			sectionContent.push(line);
		}
	}

	// Extract bullet format: "- **Decision N**: value"
	for (const line of sectionContent) {
		const boldStart = line.indexOf('**Decision');
		if (boldStart === -1) continue;
		const afterDecision = line.slice(boldStart + 10); // after '**Decision'
		const closingBold = afterDecision.indexOf('**:');
		if (closingBold === -1) continue;
		const value = afterDecision.slice(closingBold + 3).trim();
		if (value) decisions.push(value);
	}

	// Extract heading format:
	// "### Decision N: Title" (+ optional "**Reasoning**: ...")
	for (let i = 0; i < sectionContent.length; i++) {
		const headingMatch = /^###\s*Decision\s*\d+:\s*([^\n]+)/i.exec(sectionContent[i]); // NOSONAR S5852 - anchored with bounded capture
		if (!headingMatch) continue;

		const title = headingMatch[1].trim();
		if (!title) continue;

		let reasoning = '';
		for (let j = i + 1; j < sectionContent.length; j++) {
			const nextLine = sectionContent[j];

			// Stop when the next decision heading or a new top-level section starts
			if (/^###\s*Decision\s*\d+:/i.test(nextLine) || /^##\s+/.test(nextLine)) break;

			const reasoningMatch = /^\*\*Reasoning\*\*:\s*([^\n]+)/i.exec(nextLine); // NOSONAR S5852 - anchored with bounded capture
			if (reasoningMatch) {
				reasoning = reasoningMatch[1].trim();
				break;
			}
		}

		const formattedDecision = reasoning ? `${title} - Reasoning: ${reasoning}` : title;
		decisions.push(formattedDecision);
	}

	// Deduplicate if documents include both representations for the same decision
	return [...new Set(decisions)];
}

function extractTestScenarios(researchContent) {
	if (!researchContent || typeof researchContent !== 'string') return [];
	const scenarios = [];

	// Split by sections to avoid ReDoS - safer than complex regex
	const lines = researchContent.split('\n');
	let inScenariosSection = false;
	let sectionContent = [];

	for (const line of lines) {
		if (/^##\s+(?:TDD\s+)?Test Scenarios/i.test(line)) {
			inScenariosSection = true;
			continue;
		}
		if (inScenariosSection && /^##\s+/.test(line)) {
			// Hit next section, stop
			break;
		}
		if (inScenariosSection) {
			sectionContent.push(line);
		}
	}

	// Extract scenarios from both supported formats:
	// 1) "1. Scenario description"
	// 2) "### Scenario N: Scenario description"
	for (const line of sectionContent) {
		const numberedMatch = /^\d+\.\s+([^\n]+)$/.exec(line); // NOSONAR S5852 - anchored with bounded capture
		if (numberedMatch) {
			scenarios.push(numberedMatch[1].trim());
			continue;
		}

		const headingMatch = /^###\s*Scenario\s*\d+:\s*([^\n]+)$/i.exec(line); // NOSONAR S5852 - anchored with bounded capture
		if (headingMatch) {
			scenarios.push(headingMatch[1].trim());
		}
	}
	return scenarios;
}

async function getTestCoverage() {
	try {
		const coveragePath = path.join(process.cwd(), 'coverage', 'coverage-summary.json');
		if (!fs.existsSync(coveragePath)) {
			// Return object indicating no coverage instead of null
			return { available: false };
		}
		const coverageData = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
		const totals = coverageData.total;
		return {
			available: true,
			lines: totals.lines.pct,
			branches: totals.branches.pct,
			functions: totals.functions.pct,
			statements: totals.statements.pct,
		};
	} catch (error_) { // NOSONAR S2486 - intentional: file read failure returns unavailable
		void error_;
		// Return object indicating error instead of null
		return { available: false, error: true };
	}
}

function generatePRBody(context) {
	const { featureName, researchDoc, decisions = [], testScenarios = [], coverage } = context;
	let body = `## Summary

Implements **${featureName}**

`;
	if (researchDoc) {
		body += `**Research:** [${path.basename(researchDoc)}](${researchDoc})

`;
	}
	if (decisions.length > 0) {
		body += `## Key Decisions

`;
		decisions.forEach(decision => { body += `- ${decision}\n`; });
		body += '\n';
	}
	if (testScenarios.length > 0) {
		body += `## Test Scenarios

`;
		testScenarios.forEach(scenario => { body += `- ${scenario}\n`; });
		body += '\n';
	}
	// Include coverage if available (handles both old and new format)
	if (coverage && (coverage.available !== false) && coverage.lines !== undefined) {
		body += `## Test Coverage

- **Lines:** ${coverage.lines}%
- **Branches:** ${coverage.branches}%
- **Functions:** ${coverage.functions}%
- **Statements:** ${coverage.statements}%

`;
	}
	body += `## Development Approach

✅ **TDD (Test-Driven Development)**
- Tests written before implementation
- RED-GREEN-REFACTOR cycles
- All tests passing

---

🤖 Generated with [Forge Workflow](https://github.com/anthropics/forge)
`;
	return body;
}

function validatePRTitle(title) {
	if (!title || typeof title !== 'string') {
		return { valid: false, error: 'PR title is required' };
	}
	const hasValidPrefix = VALID_PR_PREFIXES.some(prefix => title.startsWith(prefix));
	if (!hasValidPrefix) {
		return { valid: false, error: `PR title must start with a valid prefix: ${VALID_PR_PREFIXES.join(', ')}` };
	}
	if (title.length < 10) return { valid: false, error: 'PR title too short (minimum 10 characters)' };
	if (title.length > 100) return { valid: false, error: 'PR title too long (maximum 100 characters)' };
	return { valid: true };
}

async function createPR(options) { // NOSONAR S3776
	const { title, body, dryRun = false, exec = execFileSync, cwd = process.cwd() } = options;
	const titleValidation = validatePRTitle(title);
	if (!titleValidation.valid) return { success: false, error: titleValidation.error };
	try {
		exec('gh', ['--version'], { ...getGhCheckOptions(), cwd });  // NOSONAR S4036 - hardcoded CLI command, no user input, developer tool context
	} catch (error) {
		if (isCommandNotFound(error)) {
			return { success: false, error: 'GitHub CLI (gh) not found. Install from: https://cli.github.com/' };
		}
		if (error.killed && error.signal === 'SIGTERM') {
			return { success: false, error: 'GitHub CLI version check timed out. Check gh installation.' };
		}
		// Catch-all: other errors (permissions, corrupted binary, etc.)
		return { success: false, error: `GitHub CLI check failed: ${error.message}` };
	}
	try {
		exec('git', ['rev-parse', '--git-dir'], getGitExecOptions(cwd));  // NOSONAR S4036 - hardcoded CLI command, no user input, developer tool context
	} catch (error_) { // NOSONAR S2486 - intentional: not-a-git-repo is the expected failure signal
		void error_;
		return { success: false, error: 'Not in a git repository. Initialize with: git init' };
	}
	try {
		exec('git', ['remote', 'get-url', 'origin'], getGitExecOptions(cwd));  // NOSONAR S4036 - hardcoded CLI command, no user input, developer tool context
	} catch (error_) { // NOSONAR S2486 - intentional: no-remote is the expected failure signal
		void error_;
		return { success: false, error: 'No git remote configured. Add with: git remote add origin <url>' };
	}
	try {
		const readiness = getBranchReadiness({ exec, cwd });
		if (!readiness.ready) {
			return { success: false, error: readiness.error };
		}
	} catch (error) {
		return { success: false, error: `Failed to verify branch readiness: ${error.message}` };
	}
	if (dryRun) {
		return { success: true, message: '[DRY RUN] Would create PR with title: ' + title, prUrl: 'https://github.com/owner/repo/pull/1' };
	}
	try {
		const result = exec('gh', ['pr', 'create', '--title', title, '--body', body], getGitExecOptions(cwd));  // NOSONAR S4036 - hardcoded CLI command, no user input, developer tool context
		const urlMatch = /https:\/\/github\.com\/[^\s]+/.exec(result);
		const prUrl = urlMatch ? urlMatch[0] : null;
		const numberMatch = /\/pull\/(\d+)/.exec(result);
		const prNumber = numberMatch ? Number.parseInt(numberMatch[1], 10) : null;
		return { success: true, prUrl, prNumber, output: result };
	} catch (error) {
		// Check for timeout
		if (error.killed && error.signal === 'SIGTERM') {
			return { success: false, error: 'GitHub CLI command timed out after 2 minutes. Check network connection.' };
		}
		return { success: false, error: `Failed to create PR: ${error.message}`, output: error.stdout || error.message };
	}
}

/**
 * Best-effort wake of the repository-wide singleton after a successful real ship.
 * The shared trigger owns containment and gate checks; dry-run skips before it.
 *
 * @param {{ dryRun: boolean, projectRoot?: string, fireAndForget?: Function }} params
 * @returns {{ started: boolean, reason?: string }}
 */
function maybeTriggerShepherdAfterShip({ dryRun, projectRoot = process.cwd(), fireAndForget: trigger = fireAndForget }) {
	if (dryRun) return { started: false, reason: 'skipped' };
	try {
		trigger({ projectRoot, dryRun });
		return { started: true };
	} catch (err) {
		return { started: false, reason: err.message };
	}
}

async function executeShip(options) {
	const {
		featureSlug,
		title,
		dryRun = false,
		projectRoot = process.cwd(),
		fireAndForget: trigger = fireAndForget,
		createPr = createPR,
	} = options || {};

	// Validate feature slug
	if (!featureSlug || typeof featureSlug !== 'string' || featureSlug.trim() === '') {
		return { success: false, error: 'Feature slug is required and must be a non-empty string' };
	}

	const slugValidation = validateFeatureSlug(featureSlug);
	if (!slugValidation.valid) {
		return { success: false, error: slugValidation.error };
	}

	// Validate PR title
	if (!title || typeof title !== 'string' || title.trim() === '') {
		return { success: false, error: 'PR title is required and must be a non-empty string' };
	}

	const titleValidation = validatePRTitle(title);
	if (!titleValidation.valid) {
		return { success: false, error: titleValidation.error };
	}

	try {
		const researchPath = path.join(process.cwd(), 'docs', 'research', `${featureSlug}.md`);
		let researchContent = null;
		let decisions = [];
		let testScenarios = [];
		if (fs.existsSync(researchPath)) {
			// Check file size to prevent resource exhaustion (max 5MB)
			const stats = fs.statSync(researchPath);
			if (stats.size > MAX_FILE_SIZE) {
				return {
					success: false,
					error: `Research document too large (${Math.round(stats.size / 1024 / 1024)}MB). Maximum size: 5MB`,
				};
			}

			researchContent = fs.readFileSync(researchPath, 'utf8');
			decisions = extractKeyDecisions(researchContent);
			testScenarios = extractTestScenarios(researchContent);
		}
		const coverage = await getTestCoverage();
		const featureName = featureSlug.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
		const prBody = generatePRBody({
			featureName,
			researchDoc: researchContent ? `docs/research/${featureSlug}.md` : null,
			decisions,
			testScenarios,
			coverage,
		});
		const result = await createPr({ title, body: prBody, dryRun });
		if (!result.success) return result;
		maybeTriggerShepherdAfterShip({ dryRun, projectRoot, fireAndForget: trigger });
		return {
			success: true,
			prUrl: result.prUrl,
			prNumber: result.prNumber,
			message: dryRun ? 'Dry run successful - PR body generated' : `Pull request created successfully: ${result.prUrl}`,
		};
	} catch (error) {
		return { success: false, error: `Failed to execute ship command: ${error.message}` };
	}
}

module.exports = {
	name: 'ship',
	description: 'Create a pull request from validated feature work',
	handler: async (args, flags = {}, projectRoot = process.cwd(), deps = {}) => {
		const result = await executeShip({
			featureSlug: args[0],
			title: args[1],
			dryRun: Boolean(flags.dryRun || flags['--dry-run']),
			projectRoot,
			fireAndForget: deps.fireAndForget,
		});
		if (!result.success) {
			return result;
		}

		const lines = [result.message];
		if (result.prUrl) lines.push(`PR: ${result.prUrl}`);

		return {
			...result,
			output: lines.join('\n'),
		};
	},
	maybeTriggerShepherdAfterShip,
	autoShepherdRailEnabled,
	extractKeyDecisions,
	extractTestScenarios,
	getTestCoverage,
	generatePRBody,
	validatePRTitle,
	createPR,
	executeShip,
	getBranchReadiness,
	resolveBaseRemote,
	resolveBaseBranch,
};
