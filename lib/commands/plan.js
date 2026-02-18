/**
 * Plan Command - OpenSpec & Beads Integration
 * Creates implementation plan after research is complete
 *
 * Security: Uses execFileSync instead of exec/execSync to prevent command injection
 * OWASP: Mitigates A03:2021 - Injection vulnerabilities
 *
 * @module commands/plan
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Constants for security
const EXEC_OPTIONS = {
	encoding: 'utf8',
	cwd: process.cwd(),
	timeout: 120000, // 2 minutes max per command
};

const MAX_SLUG_LENGTH = 100;
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

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

	// Only allow lowercase alphanumeric and hyphens
	const slugPattern = /^[a-z0-9-]+$/;
	if (!slugPattern.test(slug)) {
		return {
			valid: false,
			error: `Invalid slug format '${slug}'. Only lowercase letters, numbers, and hyphens allowed.`,
		};
	}

	// Prevent path traversal (redundant check after regex, but defense in depth)
	if (slug.includes('..') || slug.includes('/') || slug.includes('\\')) {
		return {
			valid: false,
			error: `Invalid slug '${slug}'. Path traversal not allowed.`,
		};
	}

	return { valid: true };
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
 * @returns {{type: 'tactical'|'strategic', requiresOpenSpec: boolean, reason: string}} Scope analysis result
 * @example
 * const scope = detectScope(researchMarkdown);
 * if (scope.type === 'strategic') {
 *   console.log('Requires OpenSpec proposal:', scope.reason);
 * }
 */
function detectScope(researchContent) {
	if (!researchContent || typeof researchContent !== 'string') {
		return {
			type: 'tactical',
			requiresOpenSpec: false,
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
			requiresOpenSpec: type === 'strategic',
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
			requiresOpenSpec: true,
			reason: `Strategic keywords detected: ${foundKeywords.join(', ')}`,
		};
	}

	// Default to tactical (safe fallback)
	return {
		type: 'tactical',
		requiresOpenSpec: false,
		reason: 'No strategic indicators found (tactical by default)',
	};
}

/**
 * Create Beads issue for the feature
 * Executes `bd create` command with appropriate description based on scope
 *
 * Security: Uses execFileSync (not exec) to prevent command injection
 *
 * @param {string} featureName - Feature name (human-readable)
 * @param {string} researchPath - Research document path (e.g., "docs/research/feature.md")
 * @param {'tactical'|'strategic'} scope - Scope type
 * @returns {{success: boolean, issueId?: string, description?: string, error?: string}} Beads creation result
 * @example
 * const result = createBeadsIssue('Payment Integration', 'docs/research/payment.md', 'strategic');
 * if (result.success) {
 *   console.log('Created issue:', result.issueId);
 * }
 */
function createBeadsIssue(featureName, researchPath, scope) {
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

	try {
		let description = `Research: ${researchPath}`;

		if (scope === 'strategic') {
			// Sanitize derived slug: keep only safe characters (OWASP A03)
			const featureSlug = featureName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/(?:^-+|-+$)/g, '').slice(0, MAX_SLUG_LENGTH);  // NOSONAR S5852 - non-overlapping anchors, no backtracking
			const slugValidation = validateFeatureSlug(featureSlug);
			if (!slugValidation.valid) {
				return { success: false, error: `Cannot generate valid slug from feature name: ${slugValidation.error}` };
			}
			description += `\n\nOpenSpec: openspec/changes/${featureSlug}/`;
		}

		// Execute bd create command using execFileSync for safety (OWASP A03)
		const result = execFileSync(  // NOSONAR S4036 - hardcoded CLI command, no user input, developer tool context
			'bd',  // NOSONAR S4036 - hardcoded CLI command, no user input, developer tool context
			['create', `--title=${featureName}`, `--description=${description}`, '--type=feature', '--priority=2'],
			EXEC_OPTIONS
		);

		// Extract issue ID from output (format: "Created issue: forge-xxx")
		const match = /Created issue:\s*(forge-[a-z0-9]+)/i.exec(result) || /(forge-[a-z0-9]+)/.exec(result);

		if (!match) {
			return {
				success: false,
				error: 'Failed to extract issue ID from bd create output\n\nEnsure beads is installed: bunx beads init',
			};
		}

		return {
			success: true,
			issueId: match[1],
			description,
		};
	} catch (error) {
		// Check for timeout
		if (error.killed && error.signal === 'SIGTERM') {
			return {
				success: false,
				error: 'Beads command timed out after 2 minutes.',
			};
		}

		// Provide actionable error message
		const bdNotFound = error.message.includes('ENOENT') || error.message.includes('not found');
		const errorMsg = bdNotFound
			? 'beads (bd) command not found. Install with: bunx beads init'
			: `Failed to create Beads issue: ${error.message}`;

		return {
			success: false,
			error: errorMsg,
		};
	}
}

/**
 * Create feature branch
 * Creates and checks out a new git branch following feat/<slug> convention
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
			execFileSync('git', ['rev-parse', '--verify', branchName], { ...EXEC_OPTIONS, stdio: 'pipe' });  // NOSONAR S4036 - hardcoded CLI command, no user input, developer tool context
			return {
				success: false,
				error: `Branch ${branchName} already exists\n\nSwitch to it with: git checkout ${branchName}`,
			};
		} catch {
			// Branch doesn't exist, continue (expected case)
		}

		// Create and checkout branch
		execFileSync('git', ['checkout', '-b', branchName], EXEC_OPTIONS);  // NOSONAR S4036 - hardcoded CLI command, no user input, developer tool context

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
function extractDesignDecisions(researchContent) {
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
		tasks.push({
			phase: 'RED',
			description: `Write test: ${scenario}`,
		});
		tasks.push({
			phase: 'GREEN',
			description: `Implement: ${scenario}`,
		});
		tasks.push({
			phase: 'REFACTOR',
			description: `Refactor: ${scenario}`,
		});
	}

	return tasks;
}

/**
 * Create OpenSpec proposal structure
 * Generates proposal.md, tasks.md, and design.md in openspec/changes/<slug>/
 *
 * OpenSpec structure for strategic features:
 * - proposal.md: Problem, solution, alternatives, impact
 * - tasks.md: TDD-ordered implementation tasks (RED-GREEN-REFACTOR)
 * - design.md: Key technical decisions from research
 *
 * @param {string} featureSlug - Feature slug (must match /^[a-z0-9-]+$/)
 * @param {string} researchContent - Research document markdown content
 * @returns {{success: boolean, proposalPath?: string, files?: string[], error?: string}} OpenSpec creation result
 * @example
 * const result = createOpenSpecProposal('payment-integration', researchMarkdown);
 * if (result.success) {
 *   console.log('Created proposal at:', result.proposalPath);
 * }
 */
function createOpenSpecProposal(featureSlug, researchContent) {
	// Validate slug format (OWASP A03 - Injection prevention)
	const validation = validateFeatureSlug(featureSlug);
	if (!validation.valid) {
		return {
			success: false,
			error: validation.error,
		};
	}

	if (!researchContent) {
		return {
			success: false,
			error: 'Research content is required to create OpenSpec proposal',
		};
	}

	try {
		const proposalPath = path.join(process.cwd(), 'openspec', 'changes', featureSlug);

		// Create directory structure
		fs.mkdirSync(proposalPath, { recursive: true });

		const files = [];

		// 1. Create proposal.md (high-level overview)
		const proposalContent = `# ${featureSlug} - Proposal

## Problem
[Extracted from research document]

## Solution
[Implementation approach]

## Alternatives
[Alternatives considered and rejected]

## Impact
[System impact and risks]

## Research
See: docs/research/${featureSlug}.md
`;
		fs.writeFileSync(path.join(proposalPath, 'proposal.md'), proposalContent, 'utf8');
		files.push('proposal.md');

		// 2. Create tasks.md (TDD-ordered implementation)
		const tasks = extractTasksFromResearch(researchContent);
		let tasksContent = `# ${featureSlug} - Tasks

## Implementation Tasks (TDD-ordered)

`;
		if (tasks.length === 0) {
			tasksContent += '_No TDD scenarios found in research document_\n';
		} else {
			tasks.forEach((task, index) => {
				tasksContent += `${index + 1}. [${task.phase}] ${task.description}\n`;
			});
		}

		fs.writeFileSync(path.join(proposalPath, 'tasks.md'), tasksContent, 'utf8');
		files.push('tasks.md');

		// 3. Create design.md (technical decisions)
		const decisions = extractDesignDecisions(researchContent);
		let designContent = `# ${featureSlug} - Design

## Key Decisions

`;
		if (decisions.decisions.length === 0) {
			designContent += '_No key decisions found in research document_\n';
		} else {
			decisions.decisions.forEach((decision, index) => {
				designContent += `### Decision ${index + 1}\n${decision}\n\n`;
			});
		}

		fs.writeFileSync(path.join(proposalPath, 'design.md'), designContent, 'utf8');
		files.push('design.md');

		return {
			success: true,
			proposalPath: `openspec/changes/${featureSlug}`,
			files,
		};
	} catch (error) {
		// Provide actionable error message
		const permissionDenied = error.message.includes('EACCES') || error.message.includes('permission denied');
		const errorMsg = permissionDenied
			? `Permission denied creating OpenSpec proposal. Check directory permissions: ${error.message}`
			: `Failed to create OpenSpec proposal: ${error.message}`;

		return {
			success: false,
			error: errorMsg,
		};
	}
}

/**
 * Format proposal PR body
 * Generates standardized PR description for OpenSpec proposals
 *
 * @param {string} featureName - Feature name (human-readable)
 * @param {string} proposalPath - Proposal path (e.g., "openspec/changes/feature-slug")
 * @returns {string} Formatted PR body markdown
 * @example
 * const body = formatProposalPRBody('Payment Integration', 'openspec/changes/payment-integration');
 * console.log(body); // Markdown formatted PR description
 */
function formatProposalPRBody(featureName, proposalPath) {
	return `## Proposal

This PR proposes the implementation of **${featureName}**.

**Proposal Details**: ${proposalPath}/

**Structure**:
- \`proposal.md\` - Problem, solution, alternatives, impact
- \`tasks.md\` - TDD-ordered implementation tasks
- \`design.md\` - Key technical decisions

**Review Focus**:
- Does the proposed solution address the problem?
- Are there better alternatives?
- Are the risks acceptable?

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
`;
}

/**
 * Create proposal PR
 * Executes `gh pr create` to create GitHub PR for OpenSpec proposal
 *
 * Security: Uses execFileSync (not exec) to prevent command injection
 *
 * @param {string} featureName - Feature name (human-readable)
 * @param {string} proposalPath - Proposal path (e.g., "openspec/changes/feature-slug")
 * @returns {{success: boolean, prUrl?: string, prNumber?: number, error?: string}} PR creation result
 * @example
 * const result = createProposalPR('Payment Integration', 'openspec/changes/payment-integration');
 * if (result.success) {
 *   console.log('PR created:', result.prUrl);
 * }
 */
function createProposalPR(featureName, proposalPath) {
	if (!featureName || !proposalPath) {
		return {
			success: false,
			error: 'Feature name and proposal path are required',
		};
	}

	try {
		const body = formatProposalPRBody(featureName, proposalPath);
		const title = `Proposal: ${featureName}`;

		// Create PR using gh CLI with execFileSync for safety (OWASP A03)
		const result = execFileSync(  // NOSONAR S4036 - hardcoded CLI command, no user input, developer tool context
			'gh',  // NOSONAR S4036 - hardcoded CLI command, no user input, developer tool context
			['pr', 'create', '--title', title, '--body', body],
			EXEC_OPTIONS
		);

		// Extract PR URL from output
		const urlMatch = /https:\/\/github\.com\/[^\s]+/.exec(result);
		const numberMatch = /\/pull\/(\d+)/.exec(result);

		if (!urlMatch || !numberMatch) {
			return {
				success: false,
				error: 'Failed to extract PR URL from gh pr create output\n\nEnsure gh CLI is installed and authenticated: gh auth login',
			};
		}

		return {
			success: true,
			prUrl: urlMatch[0],
			prNumber: parseInt(numberMatch[1], 10),
		};
	} catch (error) {
		// Check for timeout
		if (error.killed && error.signal === 'SIGTERM') {
			return {
				success: false,
				error: 'GitHub CLI command timed out after 2 minutes. Check network connection.',
			};
		}

		// Provide actionable error message
		const ghNotFound = error.message.includes('ENOENT') || error.message.includes('not found');
		const notAuthenticated = error.message.includes('authentication') || error.message.includes('Forbidden');

		let errorMsg = `Failed to create PR: ${error.message}`;
		if (ghNotFound) {
			errorMsg = 'GitHub CLI (gh) not found. Install from: https://cli.github.com/';
		} else if (notAuthenticated) {
			errorMsg = 'GitHub authentication required. Run: gh auth login';
		}

		return {
			success: false,
			error: errorMsg,
		};
	}
}

/**
 * Execute full plan workflow
 * Orchestrates tactical or strategic planning workflow
 *
 * Tactical workflow (quick fixes, <1 day):
 * 1. Read research document
 * 2. Detect scope (tactical)
 * 3. Create Beads issue
 * 4. Create feature branch
 * → Next: /dev command
 *
 * Strategic workflow (architecture changes, >1 day):
 * 1. Read research document
 * 2. Detect scope (strategic)
 * 3. Create Beads issue with OpenSpec link
 * 4. Create feature branch
 * 5. Generate OpenSpec proposal (proposal.md, tasks.md, design.md)
 * 6. Commit and push proposal
 * 7. Create proposal PR
 * → Next: Wait for proposal approval
 *
 * @param {string} featureName - Feature name (human-readable, e.g., "Payment Integration")
 * @returns {Promise<{
 *   success: boolean,
 *   scope?: 'tactical'|'strategic',
 *   beadsIssueId?: string,
 *   branchName?: string,
 *   openSpecCreated?: boolean,
 *   proposalPR?: {url: string, number: number},
 *   summary?: string,
 *   nextCommand?: string,
 *   error?: string
 * }>} Execution result
 * @example
 * const result = await executePlan('Payment Integration');
 * if (result.success) {
 *   console.log(result.summary);
 *   console.log('Next:', result.nextCommand);
 * }
 */
async function executePlan(featureName) {
	if (!featureName || typeof featureName !== 'string') {
		return {
			success: false,
			error: 'Feature name is required and must be a string',
		};
	}

	const featureSlug = featureName.toLowerCase()
		.replace(/[^a-z0-9-]/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-/, '')
		.replace(/-$/, '');

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

		// Step 3: Create Beads issue
		const beads = createBeadsIssue(featureName, research.path, scope.type);
		if (!beads.success) {
			return {
				success: false,
				error: `Failed to create Beads issue: ${beads.error}`,
			};
		}

		// Step 4: Create feature branch
		const branch = createFeatureBranch(featureSlug);
		if (!branch.success) {
			return {
				success: false,
				error: `Failed to create branch: ${branch.error}`,
			};
		}

		let proposalPR = null;
		let openSpecCreated = false;

		// Step 5: If strategic, create OpenSpec proposal
		if (scope.type === 'strategic') {
			const proposal = createOpenSpecProposal(featureSlug, research.content);
			if (!proposal.success) {
				return {
					success: false,
					error: `Failed to create OpenSpec proposal: ${proposal.error}`,
				};
			}

			openSpecCreated = true;

			// Commit and push proposal
			try {
				execFileSync('git', ['add', 'openspec/', 'docs/research/'], EXEC_OPTIONS);  // NOSONAR S4036 - hardcoded CLI command, no user input, developer tool context
				execFileSync('git', ['commit', '-m', `proposal: ${featureName}\n\nResearch: ${research.path}\nOpenSpec: ${proposal.proposalPath}/`], EXEC_OPTIONS);  // NOSONAR S4036 - hardcoded CLI command, no user input, developer tool context
				execFileSync('git', ['push', '-u', 'origin', branch.branchName], EXEC_OPTIONS);  // NOSONAR S4036 - hardcoded CLI command, no user input, developer tool context
			} catch (error) {
				// Check for timeout
				if (error.killed && error.signal === 'SIGTERM') {
					return {
						success: false,
						error: 'Git operation timed out after 2 minutes. Check network connection.',
					};
				}
				return {
					success: false,
					error: `Failed to commit/push proposal: ${error.message}`,
				};
			}

			// Create proposal PR
			const pr = createProposalPR(featureName, proposal.proposalPath);
			if (!pr.success) {
				return {
					success: false,
					error: `Failed to create proposal PR: ${pr.error}`,
				};
			}

			proposalPR = {
				url: pr.prUrl,
				number: pr.prNumber,
			};
		}

		// Build result summary
		const result = {
			success: true,
			scope: scope.type,
			beadsIssueId: beads.issueId,
			branchName: branch.branchName,
			openSpecCreated,
			summary: `Plan created for ${featureName} (${scope.type} scope)`,
			nextCommand: scope.type === 'strategic' ? 'wait' : '/dev',
		};

		if (proposalPR) {
			result.proposalPR = proposalPR;
			result.summary += `\nProposal PR: ${proposalPR.url}`;
		}

		return result;
	} catch (error) {
		return {
			success: false,
			error: `Unexpected error in executePlan: ${error.message}`,
		};
	}
}

module.exports = {
	readResearchDoc,
	detectScope,
	createBeadsIssue,
	createFeatureBranch,
	extractDesignDecisions,
	extractTasksFromResearch,
	createOpenSpecProposal,
	formatProposalPRBody,
	createProposalPR,
	executePlan,
};
