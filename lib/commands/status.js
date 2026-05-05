/**
 * Status Command - Intelligent Stage Detection
 * Detects workflow stage (1-9) with confidence scoring
 */

const {
	readWorkflowState,
	getAllowedTransitionsForWorkflowState,
} = require('../workflow/state');
const { STAGE_IDS } = require('../workflow/stages');
const { detectWorktree } = require('../detect-worktree');
const { readBeadsSnapshot } = require('../status/beads-snapshot');
const { formatZeroArgStatus } = require('../status/presenter');
const {
	loadState,
	extractWorkflowStateFromComments,
	readWorkflowStateFromBeads,
} = require('../workflow/state-manager');
const { secureExecFileSync } = require('../shell-utils.js');

const WORKFLOW_STAGES = {
	1: { name: 'Fresh Start', nextCommand: 'research' },
	2: { name: 'Research', nextCommand: 'research' },
	3: { name: 'Planning', nextCommand: 'plan' },
	4: { name: 'Development', nextCommand: 'dev' },
	5: { name: 'Validation', nextCommand: 'validate' },
	6: { name: 'Shipping', nextCommand: 'ship' },
	7: { name: 'Review', nextCommand: 'review' },
	8: { name: 'Merge', nextCommand: 'merge' },
	9: { name: 'Verification', nextCommand: 'verify' },
};

const AUTHORITATIVE_STAGE_NAMES = {
	plan: 'Planning',
	dev: 'Development',
	validate: 'Validation',
	ship: 'Shipping',
	review: 'Review',
	premerge: 'Premerge',
	verify: 'Verification',
};

/**
 * Analyze branch state
 * @param {string} branch - Current branch name
 * @returns {object} Branch analysis
 */
function analyzeBranch(branch) {
	// Guard: branch may be undefined if git command failed
	if (!branch || typeof branch !== 'string') {
		return { branch: '', isMain: false, onFeatureBranch: false, featureSlug: null };
	}
	const isMain = branch === 'master' || branch === 'main';
	const onFeatureBranch = branch.startsWith('feat/') || branch.startsWith('feature/');

	let featureSlug = null;
	if (onFeatureBranch) {
		featureSlug = branch.replace(/^(feat|feature)\//, '');
	}

	return {
		branch,
		isMain,
		onFeatureBranch,
		featureSlug,
	};
}

/**
 * Analyze file existence
 * @param {object} context - Context with file paths
 * @returns {object} File analysis
 */
function analyzeFiles(context) {
	return {
		hasResearch: !!context.researchDoc,
		hasPlan: !!context.plan,
		hasTests: context.tests && context.tests.length > 0,
		testsPass: context.testsPass === true,
		researchDoc: context.researchDoc,
		plan: context.plan,
		tests: context.tests || [],
	};
}

/**
 * Analyze PR state
 * @param {object} pr - PR object
 * @returns {object} PR analysis
 */
function analyzePR(pr) {
	if (!pr) {
		return {
			hasPR: false,
			prOpen: false,
			prMerged: false,
			prApproved: false,
			checksPass: false,
		};
	}

	return {
		hasPR: true,
		prNumber: pr.number,
		prOpen: pr.state === 'open',
		prMerged: pr.state === 'merged',
		prApproved: pr.approved === true,
		checksPass: pr.checksPass === true,
		reviews: pr.reviews || [],
	};
}

/**
 * Analyze check results
 * @param {object} context - Context with check results
 * @returns {object} Check analysis
 */
function analyzeChecks(context) {
	return {
		checksPass: context.checksPass === true,
		testsPass: context.testsPass === true,
		lintPass: context.lintPass !== false, // Assume true if not specified
		typeCheckPass: context.typeCheckPass !== false,
		allChecksPass: context.checksPass === true && context.testsPass === true,
	};
}

/**
 * Analyze Beads issue state
 * @param {object} beadsIssue - Beads issue object
 * @returns {object} Beads analysis
 */
function analyzeBeads(beadsIssue) {
	if (!beadsIssue) {
		return {
			hasActiveIssue: false,
			issueStatus: null,
			issueType: null,
		};
	}

	return {
		hasActiveIssue: true,
		issueStatus: beadsIssue.status,
		issueType: beadsIssue.type,
		isInProgress: beadsIssue.status === 'in_progress',
		isClosed: beadsIssue.status === 'closed',
	};
}

/**
 * Calculate confidence score
 * @param {object} factors - All analysis factors
 * @param {number} stage - Detected stage
 * @returns {object} Confidence result
 */
function calculateConfidence(factors, stage) {
	let score = 0;
	let maxScore = 0;

	// Weight different factors based on importance
	const weights = {
		branch: 20,
		files: 30,
		pr: 25,
		checks: 15,
		beads: 10,
	};

	// Branch state
	maxScore += weights.branch;
	if (stage === 1 && factors.branch.isMain && !factors.files.hasResearch) {
		score += weights.branch; // Clear stage 1
	} else if (stage >= 4 && factors.branch.onFeatureBranch) {
		score += weights.branch; // On feature branch for dev stages
	} else if (stage <= 3 && factors.branch.isMain) {
		score += weights.branch; // On main for early stages
	} else if ((stage === 8 || stage === 9) && factors.branch.isMain) {
		score += weights.branch; // Back on main after merge
	} else {
		score += weights.branch / 2; // Partial match
	}

	// File existence
	maxScore += weights.files;
	if (stage === 1 && !factors.files.hasResearch && !factors.files.hasPlan) {
		score += weights.files; // No files for fresh start
	} else if (stage === 3 && factors.files.hasResearch && !factors.files.hasPlan) {
		score += weights.files; // Research but no plan
	} else if (stage >= 4 && factors.files.hasResearch && factors.files.hasPlan) {
		score += weights.files; // Both research and plan exist
	} else if (stage === 2 && factors.files.hasResearch) {
		score += weights.files / 2; // Research in progress
	} else {
		score += weights.files / 3; // Weak match
	}

	// PR state
	maxScore += weights.pr;
	if (stage <= 6 && !factors.pr.hasPR) {
		score += weights.pr; // No PR before shipping
	} else if (stage === 7 && factors.pr.prOpen && !factors.pr.prApproved) {
		score += weights.pr; // PR open, awaiting review
	} else if (stage === 8 && factors.pr.prApproved) {
		score += weights.pr; // PR approved, ready to merge
	} else if (stage === 9 && factors.pr.prMerged) {
		score += weights.pr; // PR merged
	} else {
		score += weights.pr / 2; // Partial match
	}

	// Check results
	maxScore += weights.checks;
	if (stage === 6 && factors.checks.allChecksPass) {
		score += weights.checks; // All checks pass for shipping
	} else if (stage === 5 && !factors.checks.allChecksPass) {
		score += weights.checks; // Still working on checks
	} else if (stage >= 7 && factors.checks.allChecksPass) {
		score += weights.checks; // Checks pass for later stages
	} else {
		score += weights.checks / 2; // Partial match
	}

	// Beads issue
	maxScore += weights.beads;
	if (factors.beads.isInProgress && stage >= 2 && stage <= 7) {
		score += weights.beads; // Active work
	} else if (factors.beads.isClosed && stage >= 8) {
		score += weights.beads; // Closed for late stages
	} else if (!factors.beads.hasActiveIssue && stage === 1) {
		score += weights.beads; // No issue for fresh start
	} else {
		score += weights.beads / 2; // Partial match
	}

	const percentage = Math.round((score / maxScore) * 100);

	let confidence;
	if (percentage >= 90) {
		confidence = 'high';
	} else if (percentage >= 70) {
		confidence = 'medium';
	} else {
		confidence = 'low';
	}

	return {
		confidence,
		confidenceScore: percentage,
	};
}

/**
 * Detect workflow stage
 * @param {object} context - Full context object
 * @returns {object} Detection result
 */
function detectStage(context) {
	// Analyze all factors
	const branchFactors = analyzeBranch(context.branch || 'master');
	const fileFactors = analyzeFiles(context);
	const prFactors = analyzePR(context.pr);
	const checkFactors = analyzeChecks(context);
	const beadsFactors = analyzeBeads(context.beadsIssue);

	const factors = {
		branch: branchFactors,
		files: fileFactors,
		pr: prFactors,
		checks: checkFactors,
		beads: beadsFactors,
	};

	// Stage detection logic
	let stage;

	// Stage 9: PR merged, verify docs
	if (prFactors.prMerged && beadsFactors.isClosed) {
		stage = 9;
	}
	// Stage 8: PR approved, ready to merge
	else if (prFactors.prApproved && checkFactors.allChecksPass) {
		stage = 8;
	}
	// Stage 7: PR open, awaiting review
	else if (prFactors.prOpen && !prFactors.prApproved) {
		stage = 7;
	}
	// Stage 6: Ready to ship (all checks pass, no PR yet)
	else if (checkFactors.allChecksPass && fileFactors.hasTests && !prFactors.hasPR) {
		stage = 6;
	}
	// Stage 5: Dev in progress, tests failing or checks not done
	else if (fileFactors.hasTests && !checkFactors.allChecksPass) {
		stage = 5;
	}
	// Stage 4: Plan exists, no tests yet
	else if (fileFactors.hasPlan && !fileFactors.hasTests && branchFactors.onFeatureBranch) {
		stage = 4;
	}
	// Stage 3: Research exists, no plan yet
	else if (fileFactors.hasResearch && !fileFactors.hasPlan) {
		stage = 3;
	}
	// Stage 2: Research in progress
	else if (beadsFactors.issueType === 'research' && beadsFactors.isInProgress) {
		stage = 2;
	}
	// Stage 1: Fresh project (default)
	else {
		stage = 1;
	}

	// Calculate confidence
	const confidenceResult = calculateConfidence(factors, stage);

	// Get next command
	const nextCommand = WORKFLOW_STAGES[stage].nextCommand;

	return {
		stage,
		stageName: WORKFLOW_STAGES[stage].name,
		confidence: confidenceResult.confidence,
		confidenceScore: confidenceResult.confidenceScore,
		nextCommand,
		factors,
	};
}

function parseStatusInputs(args = [], flags = {}) {
	const statusArgs = Array.isArray(args) ? args : [];
	const getNextValue = (flagName) => {
		const index = statusArgs.indexOf(flagName);
		if (index !== -1 && index + 1 < statusArgs.length) {
			return statusArgs[index + 1];
		}
		return null;
	};
	const getInlineValue = (flagName) => {
		const prefix = `${flagName}=`;
		const match = statusArgs.find(arg => typeof arg === 'string' && arg.startsWith(prefix));
		return match ? match.slice(prefix.length) : null;
	};

	return {
		issueId: flags.issueId || flags['--issue-id'] || getInlineValue('--issue-id') || getNextValue('--issue-id'),
		workflowState: flags.workflowState || flags['--workflow-state'] || getInlineValue('--workflow-state') || getNextValue('--workflow-state'),
		bdComments: flags.bdComments || flags['--bd-comments'] || getInlineValue('--bd-comments') || getNextValue('--bd-comments'),
		projectRoot: flags.projectRoot || flags['--project-root'] || getInlineValue('--project-root') || getNextValue('--project-root') || null,
	};
}

function runGitCommand(projectRoot, args) {
	if (!projectRoot) {
		return '';
	}

	try {
		return secureExecFileSync('git', args, {
			encoding: 'utf8',
			cwd: projectRoot,
			stdio: ['pipe', 'pipe', 'pipe'],
		}).trim();
	} catch (_error) {
		return '';
	}
}

function detectRepoContext(projectRoot = process.cwd()) {
	const worktree = detectWorktree(projectRoot);
	const branch = worktree.branch || runGitCommand(projectRoot, ['branch', '--show-current']) || 'unknown';
	const statusOutput = runGitCommand(projectRoot, ['status', '--short']);
	const changedEntries = statusOutput ? statusOutput.split(/\r?\n/).filter(Boolean) : [];
	const clean = changedEntries.length === 0;
	const summary = clean ? 'clean' : `${changedEntries.length} uncommitted change${changedEntries.length === 1 ? '' : 's'}`;

	return {
		branch,
		inWorktree: worktree.inWorktree === true,
		worktreePath: worktree.currentWorktree || projectRoot,
		mainWorktree: worktree.mainWorktree || projectRoot,
		workingTree: {
			clean,
			summary,
		},
	};
}

function readIssueDetails(issueId, projectRoot = process.cwd()) {
	if (!issueId) {
		return null;
	}

	try {
		const raw = secureExecFileSync('bd', ['show', issueId, '--json'], {
			encoding: 'utf8',
			cwd: projectRoot,
			stdio: ['pipe', 'pipe', 'pipe'],
		}).trim();
		if (!raw) {
			return null;
		}

		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed[0] || null : parsed;
	} catch (_error) {
		return null;
	}
}

function stripDatePrefix(value) {
	const datePrefixLength = 11;
	const datePrefix =
		value.length > datePrefixLength &&
		value[4] === '-' &&
		value[7] === '-' &&
		value[10] === '-';
	return datePrefix ? value.slice(datePrefixLength) : value;
}

function trimTrailingPathPunctuation(value) {
	const trailingPunctuation = '.,;:';
	let end = value.length;
	while (end > 0 && trailingPunctuation.includes(value[end - 1])) {
		end -= 1;
	}
	return value.slice(0, end);
}

function stripMarkdownSuffixes(value) {
	let stripped = value.endsWith('.md') ? value.slice(0, -3) : value;
	for (const suffix of ['-design', '-tasks', '-decisions']) {
		if (stripped.endsWith(suffix)) {
			stripped = stripped.slice(0, -suffix.length);
			break;
		}
	}
	return stripped;
}

function extractSlugFromDesignPath(candidatePath) {
	const parts = trimTrailingPathPunctuation(candidatePath).replaceAll('\\', '/').split('/').filter(Boolean);
	const docsIndex = parts.indexOf('docs');
	if (docsIndex === -1) {
		return '';
	}
	const root = parts[docsIndex + 1];

	if (root === 'plans') {
		const fileName = parts[docsIndex + 2] || '';
		return stripDatePrefix(stripMarkdownSuffixes(fileName));
	}

	if (root === 'work') {
		return stripDatePrefix(parts[docsIndex + 2] || '');
	}

	return '';
}

function isPathCandidateChar(char) {
	return (
		(char >= 'a' && char <= 'z') ||
		(char >= 'A' && char <= 'Z') ||
		(char >= '0' && char <= '9') ||
		char === '/' ||
		char === '\\' ||
		char === '.' ||
		char === '-' ||
		char === '_'
	);
}

function extractPathCandidates(text) {
	const candidates = [];
	let index = 0;

	while (index < text.length) {
		const hasForwardPath = text.startsWith('docs/', index);
		const hasBackwardPath = text.startsWith('docs\\', index);

		if (!hasForwardPath && !hasBackwardPath) {
			index += 1;
			continue;
		}

		let end = index;
		while (end < text.length && isPathCandidateChar(text[end])) {
			end += 1;
		}
		candidates.push(text.slice(index, end));
		index = end;
	}

	return candidates;
}

function extractDesignSlugs(design) {
	if (typeof design !== 'string' || design.trim() === '') {
		return [];
	}

	const slugs = new Set();
	for (const candidate of extractPathCandidates(design)) {
		const slug = extractSlugFromDesignPath(candidate);
		if (slug) {
			slugs.add(slug);
		}
	}

	return [...slugs];
}

function designMatchesFeatureSlug(issue, featureSlug) {
	if (!issue || !featureSlug) {
		return false;
	}

	return extractDesignSlugs(issue.design).includes(featureSlug);
}

function discoverCurrentIssue(snapshot, context, projectRoot = process.cwd()) {
	const activeAssigned = snapshot.activeAssigned || [];
	if (activeAssigned.length === 0) {
		return null;
	}

	const branchInfo = analyzeBranch(context.branch || 'master');
	const hydratedIssues = new Map();

	function hydrateIssue(issue) {
		if (!issue || !issue.id) {
			return issue;
		}

		if (hydratedIssues.has(issue.id)) {
			return hydratedIssues.get(issue.id);
		}

		const details = issue.design && issue.comments ? issue : readIssueDetails(issue.id, projectRoot);
		const hydratedIssue = details ? { ...issue, ...details } : issue;
		hydratedIssues.set(issue.id, hydratedIssue);
		return hydratedIssue;
	}

	if (branchInfo.featureSlug) {
		const slugMatches = [];

		for (const issue of activeAssigned) {
			const candidate = issue.design ? issue : hydrateIssue(issue);
			if (designMatchesFeatureSlug(candidate, branchInfo.featureSlug)) {
				slugMatches.push(candidate);
			}
		}

		if (slugMatches.length === 1) {
			return hydrateIssue(slugMatches[0]);
		}

		if (slugMatches.length > 1) {
			return null;
		}
	}

	if (activeAssigned.length === 1) {
		return hydrateIssue(activeAssigned[0]);
	}

	return null;
}

function resolveWorkflowState(inputs) {
	try {
		if (inputs.workflowState) {
			return { workflowState: readWorkflowState(inputs.workflowState), fallbackReason: null };
		}

		const { state } = loadState(inputs.projectRoot, {
			issueId: inputs.issueId,
			issue: inputs.issue,
			comments: inputs.bdComments,
			preferBeads: inputs.preferBeads,
		});

		return { workflowState: state, fallbackReason: null };
	} catch (error) {
		return {
			workflowState: null,
			fallbackReason: error instanceof Error ? error.message : String(error),
		};
	}
}

function buildAuthoritativeStatus(workflowState) {
	const currentStage = workflowState.currentStage;
	const stageIndex = STAGE_IDS.indexOf(currentStage);
	const nextStages = getAllowedTransitionsForWorkflowState(workflowState);

	return {
		stage: stageIndex === -1 ? null : stageIndex + 1,
		stageId: currentStage,
		stageName: AUTHORITATIVE_STAGE_NAMES[currentStage] || currentStage,
		confidence: 'high',
		confidenceScore: 100,
		runCommand: currentStage,
		nextCommand: nextStages[0] || null,
		nextStages,
		authoritative: true,
		workflowState,
		factors: {
			files: {
				hasResearch: workflowState.completedStages.includes('plan'),
				hasPlan: workflowState.completedStages.includes('plan') || currentStage !== 'plan',
				testsPass: workflowState.completedStages.includes('validate'),
			},
			branch: {},
			pr: {},
			checks: { allChecksPass: workflowState.completedStages.includes('validate') },
			beads: { hasActiveIssue: true },
		},
	};
}

function buildMissingWorkflowStateStatus() {
	return {
		stage: null,
		stageId: null,
		stageName: 'Unknown',
		confidence: 'low',
		confidenceScore: 0,
		authoritative: false,
		missingWorkflowState: true,
		output: '\nNo authoritative workflow state available.\nProvide --workflow-state or --issue-id so /status can read recorded stage state.\n',
	};
}

function buildHeaderLines(title, detailLines = []) {
	return ['', title, ...detailLines, ''];
}

function buildSectionLines(title, items = []) {
	if (items.length === 0) {
		return [];
	}

	return [title, ...items.map(item => `  ${item}`), ''];
}

function collectCompletedChecks(result) {
	const completed = [];

	if (result.factors.files.hasResearch) completed.push('Research doc exists');
	if (result.factors.files.hasPlan) completed.push('Plan created');
	if (result.factors.branch.onFeatureBranch) completed.push('Feature branch created');
	if (result.factors.files.hasTests) completed.push('Tests written');
	if (result.factors.files.testsPass) completed.push('Tests passing');
	if (result.factors.checks.allChecksPass) completed.push('All checks passing');
	if (result.factors.pr.hasPR) completed.push(`PR created (#${result.factors.pr.prNumber})`);
	if (result.factors.pr.prApproved) completed.push('PR approved');
	if (result.factors.pr.prMerged) completed.push('PR merged');

	return completed;
}

function formatAuthoritativeStatus(result) {
	const completedStages = result.workflowState.completedStages.map(stageId => stageId);
	const allowedCommands = result.nextStages.map(stageId => '/' + stageId).join(', ');
	const nextLines = [`Run now: /${result.runCommand}`];

	if (result.nextCommand) {
		nextLines.push(`Next after this: /${result.nextCommand}`);
	}
	if (allowedCommands) {
		nextLines.push(`Allowed after this: ${allowedCommands}`);
	}

	return [
		...buildHeaderLines(`Current Stage: ${result.stageId} - ${result.stageName}`, [
			'  Source: authoritative workflow state',
			`  Classification: ${result.workflowState.workflowDecisions.classification}`,
		]),
		...buildSectionLines('Completed stages:', completedStages),
		...nextLines,
		'',
	].join('\n');
}

function formatHeuristicStatus(result) {
	const lines = [
		...buildHeaderLines(`Current Stage: ${result.stage} - ${result.stageName}`, [
			`  Confidence: ${result.confidence.toUpperCase()} (${result.confidenceScore}%)`,
		]),
		...buildSectionLines('Completed:', collectCompletedChecks(result)),
		`Next: /${result.nextCommand}`,
		'',
	];

	if (result.confidence === 'low') {
		lines.push('Low confidence - Manual verification suggested');
		lines.push('   Conflicting signals detected. Please verify current stage.');
		lines.push('');
	}

	return lines.join('\n');
}

/**
 * Format status output
 * @param {object} result - Detection result
 * @returns {string} Formatted output
 */
function formatStatus(result) {
	if (result.authoritative && result.workflowState) {
		return formatAuthoritativeStatus(result);
	}

	return formatHeuristicStatus(result);
}


module.exports = {
	name: 'status',
	description: 'Intelligent stage detection with confidence scoring',
	handler: async (args, flags, projectRoot) => {
		const inputs = parseStatusInputs(args, flags);
		const isZeroArgStatus = !inputs.issueId && !inputs.workflowState && !inputs.bdComments;
		inputs.preferBeads = !isZeroArgStatus && Boolean(inputs.issueId || inputs.bdComments);
		if (!inputs.projectRoot && projectRoot) {
			inputs.projectRoot = projectRoot;
		}
		const effectiveProjectRoot = inputs.projectRoot || process.cwd();
		let context = null;
		let snapshot = null;

		if (isZeroArgStatus) {
			context = detectRepoContext(effectiveProjectRoot);
			snapshot = readBeadsSnapshot(effectiveProjectRoot);
			const discoveredIssue = discoverCurrentIssue(snapshot, context, effectiveProjectRoot);
			if (discoveredIssue) {
				inputs.issueId = discoveredIssue.id;
				inputs.issue = discoveredIssue;
			}
		}

		const { workflowState, fallbackReason } = resolveWorkflowState(inputs);

		if (isZeroArgStatus) {
			if (workflowState) {
				const result = buildAuthoritativeStatus(workflowState);
				return {
					success: true,
					context,
					snapshot,
					issueId: inputs.issueId,
					output: formatZeroArgStatus({ context, snapshot, workflowResult: result }),
					...result,
				};
			}

			return {
				success: true,
				context,
				snapshot,
				issueId: inputs.issueId,
				missingWorkflowState: true,
				output: formatZeroArgStatus({ context, snapshot }),
				...(fallbackReason ? { fallbackReason } : {}),
			};
		}

		if (workflowState) {
			const result = buildAuthoritativeStatus(workflowState);
			return { success: true, output: formatStatus(result), ...result };
		}

		return {
			success: true,
			...buildMissingWorkflowStateStatus(),
			...(fallbackReason ? { fallbackReason } : {}),
		};
	},
	buildAuthoritativeStatus,
	buildMissingWorkflowStateStatus,
	extractWorkflowStateFromComments,
	resolveWorkflowState,
	parseStatusInputs,
	readWorkflowStateFromBeads,
	detectStage,
	detectRepoContext,
	discoverCurrentIssue,
	analyzeBranch,
	analyzeFiles,
	analyzePR,
	analyzeChecks,
	analyzeBeads,
	calculateConfidence,
	formatStatus,
	extractDesignSlugs,
};
