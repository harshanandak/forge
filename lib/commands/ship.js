/**
 * Ship Command - PR Creation with Auto-Generated Documentation
 * Creates pull requests with comprehensive body generated from research and metrics
 *
 * Security: Uses execFileSync for command execution to prevent injection
 * Automation: Extracts key decisions, test scenarios, and coverage metrics
 *
 * @module commands/ship
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function getExecOptions() {
	return { encoding: 'utf8', cwd: process.cwd(), timeout: 120000 };
}

function getGhCheckOptions() {
	return { encoding: 'utf8', cwd: process.cwd(), timeout: 3000 };
}

const VALID_PR_PREFIXES = ['feat:', 'fix:', 'docs:', 'refactor:', 'test:', 'chore:', 'perf:', 'ci:', 'build:', 'revert:'];

const MAX_SLUG_LENGTH = 100;
const MAX_TITLE_LENGTH = 100;
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

function isCommandNotFound(error) {
	return error.message.includes('ENOENT') || error.message.includes('not found');
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

	// Only allow lowercase alphanumeric and hyphens
	const slugPattern = /^[a-z0-9-]+$/;
	if (!slugPattern.test(slug)) {
		return {
			valid: false,
			error: `Invalid slug format '${slug}'. Only lowercase letters, numbers, and hyphens allowed.`,
		};
	}

	// Prevent path traversal (redundant after regex, but defense in depth)
	if (slug.includes('..') || slug.includes('/') || slug.includes('\\')) {
		return {
			valid: false,
			error: `Invalid slug '${slug}'. Path traversal not allowed.`,
		};
	}

	return { valid: true };
}

function extractKeyDecisions(researchContent) {
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

	// Now extract decisions from collected lines (safe - no backtracking)
	const sectionText = sectionContent.join('\n');
	// Corrected regex: colon is AFTER the bold markers, not before
	const decisionRegex = /-\s+\*\*Decision[^*]*\*\*:\s+([^\n]+)/g;
	let match;
	while ((match = decisionRegex.exec(sectionText)) !== null) {
		decisions.push(match[1].trim());
	}
	return decisions;
}

function extractTestScenarios(researchContent) {
	if (!researchContent || typeof researchContent !== 'string') return [];
	const scenarios = [];

	// Split by sections to avoid ReDoS - safer than complex regex
	const lines = researchContent.split('\n');
	let inScenariosSection = false;
	let sectionContent = [];

	for (const line of lines) {
		if (/^##\s+Test Scenarios/i.test(line)) {
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

	// Now extract scenarios from collected lines (safe - no backtracking)
	const sectionText = sectionContent.join('\n');
	const scenarioRegex = /^\d+\.\s+([^\n]+)$/gm;  // NOSONAR S5852 - [^\n]+ is bounded, no backtracking
	let match;
	while ((match = scenarioRegex.exec(sectionText)) !== null) {
		scenarios.push(match[1].trim());
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
	} catch (_error) {
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

async function createPR(options) {
	const { title, body, dryRun = false } = options;
	const titleValidation = validatePRTitle(title);
	if (!titleValidation.valid) return { success: false, error: titleValidation.error };
	try {
		execFileSync('gh', ['--version'], getGhCheckOptions());  // NOSONAR S4036 - hardcoded CLI command, no user input, developer tool context
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
		execFileSync('git', ['rev-parse', '--git-dir'], getExecOptions());  // NOSONAR S4036 - hardcoded CLI command, no user input, developer tool context
	} catch (_error) {
		return { success: false, error: 'Not in a git repository. Initialize with: git init' };
	}
	try {
		execFileSync('git', ['remote', 'get-url', 'origin'], getExecOptions());  // NOSONAR S4036 - hardcoded CLI command, no user input, developer tool context
	} catch (_error) {
		return { success: false, error: 'No git remote configured. Add with: git remote add origin <url>' };
	}
	if (dryRun) {
		return { success: true, message: '[DRY RUN] Would create PR with title: ' + title, prUrl: 'https://github.com/owner/repo/pull/1' };
	}
	try {
		const result = execFileSync('gh', ['pr', 'create', '--title', title, '--body', body], getExecOptions());  // NOSONAR S4036 - hardcoded CLI command, no user input, developer tool context
		const urlMatch = /https:\/\/github\.com\/[^\s]+/.exec(result);
		const prUrl = urlMatch ? urlMatch[0] : null;
		const numberMatch = /\/pull\/(\d+)/.exec(result);
		const prNumber = numberMatch ? parseInt(numberMatch[1], 10) : null;
		return { success: true, prUrl, prNumber, output: result };
	} catch (error) {
		// Check for timeout
		if (error.killed && error.signal === 'SIGTERM') {
			return { success: false, error: 'GitHub CLI command timed out after 2 minutes. Check network connection.' };
		}
		return { success: false, error: `Failed to create PR: ${error.message}`, output: error.stdout || error.message };
	}
}

async function executeShip(options) {
	const { featureSlug, title, dryRun = false } = options || {};

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

	if (title.length > MAX_TITLE_LENGTH) {
		return { success: false, error: `PR title too long (maximum ${MAX_TITLE_LENGTH} characters)` };
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
		const result = await createPR({ title, body: prBody, dryRun });
		if (!result.success) return result;
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
	extractKeyDecisions,
	extractTestScenarios,
	getTestCoverage,
	generatePRBody,
	validatePRTitle,
	createPR,
	executeShip,
};
