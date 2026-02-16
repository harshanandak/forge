/**
 * Plan Command - OpenSpec & Beads Integration
 * Creates implementation plan after research is complete
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Read research document from file
 * @param {string} featureSlug - Feature slug
 * @returns {object} Research document result
 */
function readResearchDoc(featureSlug) {
	try {
		const researchPath = path.join(process.cwd(), 'docs', 'research', `${featureSlug}.md`);

		if (!fs.existsSync(researchPath)) {
			return {
				success: false,
				error: `Research document not found: ${researchPath}`,
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
			error: error.message,
		};
	}
}

/**
 * Detect scope from research content
 * @param {string} researchContent - Research document content
 * @returns {object} Scope result
 */
function detectScope(researchContent) {
	// Check explicit Scope Assessment section
	const scopeMatch = researchContent.match(/##\s*Scope Assessment[\s\S]*?\*\*Strategic\/Tactical\*\*:\s*(Strategic|Tactical)/i);

	if (scopeMatch) {
		const type = scopeMatch[1].toLowerCase();
		return {
			type,
			requiresOpenSpec: type === 'strategic',
			reason: `Explicit scope: ${scopeMatch[1]}`,
		};
	}

	// Keyword-based detection for strategic scope
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

	// Default to tactical
	return {
		type: 'tactical',
		requiresOpenSpec: false,
		reason: 'No strategic indicators found',
	};
}

/**
 * Create Beads issue for the feature
 * @param {string} featureName - Feature name
 * @param {string} researchPath - Research document path
 * @param {string} scope - Scope type (tactical/strategic)
 * @returns {object} Beads creation result
 */
function createBeadsIssue(featureName, researchPath, scope) {
	try {
		let description = `Research: ${researchPath}`;

		if (scope === 'strategic') {
			const featureSlug = featureName.toLowerCase().replace(/\s+/g, '-');
			description += `\n\nOpenSpec: openspec/changes/${featureSlug}/`;
		}

		// Execute bd create command using execFileSync for safety
		const result = execFileSync(
			'bd',
			['create', `--title=${featureName}`, `--description=${description}`, '--type=feature', '--priority=2'],
			{ encoding: 'utf8' }
		);

		// Extract issue ID from output (format: "Created issue: forge-xxx")
		const match = result.match(/Created issue:\s*(forge-[a-z0-9]+)/i) || result.match(/(forge-[a-z0-9]+)/);

		if (!match) {
			return {
				success: false,
				error: 'Failed to extract issue ID from bd create output',
			};
		}

		return {
			success: true,
			issueId: match[1],
			description,
		};
	} catch (error) {
		return {
			success: false,
			error: error.message,
		};
	}
}

/**
 * Create feature branch
 * @param {string} featureSlug - Feature slug
 * @returns {object} Branch creation result
 */
function createFeatureBranch(featureSlug) {
	try {
		const branchName = `feat/${featureSlug}`;

		// Check if branch already exists
		try {
			execFileSync('git', ['rev-parse', '--verify', branchName], { encoding: 'utf8', stdio: 'pipe' });
			return {
				success: false,
				error: `Branch ${branchName} already exists`,
			};
		} catch {
			// Branch doesn't exist, continue
		}

		// Create and checkout branch
		execFileSync('git', ['checkout', '-b', branchName], { encoding: 'utf8' });

		return {
			success: true,
			branchName,
		};
	} catch (error) {
		return {
			success: false,
			error: error.message,
		};
	}
}

/**
 * Extract design decisions from research content
 * @param {string} researchContent - Research document content
 * @returns {object} Design decisions result
 */
function extractDesignDecisions(researchContent) {
	const decisions = [];

	// Match sections like "### Decision 1: Use Stripe SDK v4"
	const decisionPattern = /###\s*Decision\s*\d+:\s*([^\n]+)\n\*\*Reasoning\*\*:\s*([^\n]+)/gi;
	let match;

	while ((match = decisionPattern.exec(researchContent)) !== null) {
		decisions.push(`${match[1]}\nReasoning: ${match[2]}`);
	}

	// Also try to match Key Decisions section without numbered format
	if (decisions.length === 0) {
		const keyDecisionsMatch = researchContent.match(/##\s*Key Decisions[\s\S]*?(?=##|$)/i);
		if (keyDecisionsMatch) {
			const content = keyDecisionsMatch[0];
			const subsections = content.match(/###\s*([^\n]+)/g);
			if (subsections) {
				subsections.forEach(sub => {
					const cleaned = sub.replace(/###\s*/, '');
					decisions.push(cleaned);
				});
			}
		}
	}

	return {
		decisions,
	};
}

/**
 * Extract TDD tasks from research content
 * @param {string} researchContent - Research document content
 * @returns {Array} Tasks array
 */
function extractTasksFromResearch(researchContent) {
	const tasks = [];

	// Match TDD Test Scenarios section - more flexible regex
	const scenariosMatch = researchContent.match(/##[^#]*TDD Test Scenarios[^#]*(###[\s\S]*?)(?=##|$)/i);

	if (scenariosMatch) {
		const content = scenariosMatch[0];
		// Match scenario headings like "### Scenario 1: Validate payment input"
		const scenarioPattern = /###\s*Scenario\s*\d+:\s*([^\n]+)/gi;
		let match;

		while ((match = scenarioPattern.exec(content)) !== null) {
			const scenario = match[1].trim();

			// Each scenario becomes 3 tasks (RED-GREEN-REFACTOR)
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
	}

	return tasks;
}

/**
 * Create OpenSpec proposal structure
 * @param {string} featureSlug - Feature slug
 * @param {string} researchContent - Research document content
 * @returns {object} OpenSpec creation result
 */
function createOpenSpecProposal(featureSlug, researchContent) {
	try {
		const proposalPath = path.join(process.cwd(), 'openspec', 'changes', featureSlug);

		// Create directory structure
		fs.mkdirSync(proposalPath, { recursive: true });

		const files = [];

		// 1. Create proposal.md
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

		// 2. Create tasks.md
		const tasks = extractTasksFromResearch(researchContent);
		let tasksContent = `# ${featureSlug} - Tasks

## Implementation Tasks (TDD-ordered)

`;
		tasks.forEach((task, index) => {
			tasksContent += `${index + 1}. [${task.phase}] ${task.description}\n`;
		});

		fs.writeFileSync(path.join(proposalPath, 'tasks.md'), tasksContent, 'utf8');
		files.push('tasks.md');

		// 3. Create design.md
		const decisions = extractDesignDecisions(researchContent);
		let designContent = `# ${featureSlug} - Design

## Key Decisions

`;
		decisions.decisions.forEach((decision, index) => {
			designContent += `### Decision ${index + 1}\n${decision}\n\n`;
		});

		fs.writeFileSync(path.join(proposalPath, 'design.md'), designContent, 'utf8');
		files.push('design.md');

		return {
			success: true,
			proposalPath: `openspec/changes/${featureSlug}`,
			files,
		};
	} catch (error) {
		return {
			success: false,
			error: error.message,
		};
	}
}

/**
 * Format proposal PR body
 * @param {string} featureName - Feature name
 * @param {string} proposalPath - Proposal path
 * @returns {string} Formatted PR body
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
 * @param {string} featureName - Feature name
 * @param {string} proposalPath - Proposal path
 * @returns {object} PR creation result
 */
function createProposalPR(featureName, proposalPath) {
	try {
		const body = formatProposalPRBody(featureName, proposalPath);
		const title = `Proposal: ${featureName}`;

		// Create PR using gh CLI with execFileSync for safety
		const result = execFileSync(
			'gh',
			['pr', 'create', '--title', title, '--body', body],
			{ encoding: 'utf8' }
		);

		// Extract PR URL from output
		const urlMatch = result.match(/https:\/\/github\.com\/[^\s]+/);
		const numberMatch = result.match(/\/pull\/(\d+)/);

		if (!urlMatch || !numberMatch) {
			return {
				success: false,
				error: 'Failed to extract PR URL from gh pr create output',
			};
		}

		return {
			success: true,
			prUrl: urlMatch[0],
			prNumber: parseInt(numberMatch[1], 10),
		};
	} catch (error) {
		return {
			success: false,
			error: error.message,
		};
	}
}

/**
 * Execute full plan workflow
 * @param {string} featureName - Feature name
 * @returns {Promise<object>} Execution result
 */
async function executePlan(featureName) {
	const featureSlug = featureName.toLowerCase().replace(/\s+/g, '-');

	try {
		// Step 1: Read research document
		const research = readResearchDoc(featureSlug);
		if (!research.success) {
			return {
				success: false,
				error: `Research document not found: ${research.error}`,
			};
		}

		// Step 2: Detect scope
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

			// Commit proposal
			try {
				execFileSync('git', ['add', 'openspec/', 'docs/research/'], { encoding: 'utf8' });
				execFileSync('git', ['commit', '-m', `proposal: ${featureName}\n\nResearch: ${research.path}\nOpenSpec: ${proposal.proposalPath}/`], { encoding: 'utf8' });
				execFileSync('git', ['push', '-u', 'origin', branch.branchName], { encoding: 'utf8' });
			} catch (error) {
				return {
					success: false,
					error: `Failed to commit proposal: ${error.message}`,
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

		// Build result
		const result = {
			success: true,
			scope: scope.type,
			beadsIssueId: beads.issueId,
			branchName: branch.branchName,
			openSpecCreated,
			summary: `Plan created for ${featureName} (${scope.type})`,
			nextCommand: scope.type === 'strategic' ? 'wait' : '/dev',
		};

		if (proposalPR) {
			result.proposalPR = proposalPR;
		}

		return result;
	} catch (error) {
		return {
			success: false,
			error: error.message,
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
