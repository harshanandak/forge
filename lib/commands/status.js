/**
 * Status Command - Intelligent Stage Detection
 * Detects workflow stage (1-9) with confidence scoring
 */

const WORKFLOW_STAGES = {
	1: { name: 'Fresh Start', nextCommand: 'research' },
	2: { name: 'Research', nextCommand: 'research' },
	3: { name: 'Planning', nextCommand: 'plan' },
	4: { name: 'Development', nextCommand: 'dev' },
	5: { name: 'Validation', nextCommand: 'check' },
	6: { name: 'Shipping', nextCommand: 'ship' },
	7: { name: 'Review', nextCommand: 'review' },
	8: { name: 'Merge', nextCommand: 'merge' },
	9: { name: 'Verification', nextCommand: 'verify' },
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

/**
 * Format status output
 * @param {object} result - Detection result
 * @returns {string} Formatted output
 */
function formatStatus(result) {
	const lines = [];

	// Header
	lines.push('');
	lines.push(`✓ Current Stage: ${result.stage} - ${result.stageName}`);
	lines.push(`  Confidence: ${result.confidence.toUpperCase()} (${result.confidenceScore}%)`);
	lines.push('');

	// Completed checks
	const completed = [];
	if (result.factors.files.hasResearch) {
		completed.push('✓ Research doc exists');
	}
	if (result.factors.files.hasPlan) {
		completed.push('✓ Plan created');
	}
	if (result.factors.branch.onFeatureBranch) {
		completed.push('✓ Feature branch created');
	}
	if (result.factors.files.hasTests) {
		completed.push('✓ Tests written');
	}
	if (result.factors.files.testsPass) {
		completed.push('✓ Tests passing');
	}
	if (result.factors.checks.allChecksPass) {
		completed.push('✓ All checks passing');
	}
	if (result.factors.pr.hasPR) {
		completed.push(`✓ PR created (#${result.factors.pr.prNumber})`);
	}
	if (result.factors.pr.prApproved) {
		completed.push('✓ PR approved');
	}
	if (result.factors.pr.prMerged) {
		completed.push('✓ PR merged');
	}

	if (completed.length > 0) {
		lines.push('Completed:');
		completed.forEach(item => lines.push(`  ${item}`));
		lines.push('');
	}

	// Next command
	lines.push(`Next: /${result.nextCommand}`);
	lines.push('');

	// Low confidence warning
	if (result.confidence === 'low') {
		lines.push('⚠️  Low confidence - Manual verification suggested');
		lines.push('   Conflicting signals detected. Please verify current stage.');
		lines.push('');
	}

	return lines.join('\n');
}

module.exports = {
	detectStage,
	analyzeBranch,
	analyzeFiles,
	analyzePR,
	analyzeChecks,
	analyzeBeads,
	calculateConfidence,
	formatStatus,
};
