/**
 * Plan Command - Phase 1/2/3 Coverage Tests
 *
 * Tests the gaps not covered by plan.test.js:
 *
 * Phase 1 (Design Intent):
 *  - readResearchDoc: slug validation (all invalid slug cases)
 *  - readResearchDoc: success path using a real existing file in docs/research/
 *  - detectScope: null/undefined/empty input defaults to tactical
 *  - detectScope: reason field always present
 *  - detectScope: section boundary stops at next ##
 *  - extractDesignDecisions: empty/null input, simple heading fallback, multi-decision
 *
 * Phase 2 (Technical Research):
 *  - extractTasksFromResearch: multiple scenarios → 3 tasks each (RED/GREEN/REFACTOR)
 *  - extractTasksFromResearch: null/empty/no-section inputs return []
 *  - extractTasksFromResearch: task shape (phase + description fields)
 *  - extractTasksFromResearch: section boundary (stops at next ##)
 *
 * Phase 3 (Setup):
 *  - createBeadsIssue: input validation (missing featureName, missing researchPath, invalid scope)
 *  - createFeatureBranch: slug validation (invalid slugs rejected before any git call)
 *  - executePlan: featureName type validation (null, undefined, empty, non-string)
 *  - executePlan: missing research doc returns failure (uses real fs, file doesn't exist)
 *
 * NOTE: Tests that require real git/bd execution are avoided because:
 *  - bun:test runs files in the same process; plan.js is cached with real node:fs/child_process
 *    from plan.test.js's require(), so mock.module() calls here cannot replace those references
 *  - Instead we test validation paths (which return before I/O) and pure-function behavior
 */

const { describe, test, expect } = require('bun:test');

const {
	readResearchDoc,
	detectScope,
	createBeadsIssue,
	createFeatureBranch,
	extractDesignDecisions,
	extractTasksFromResearch,
	executePlan,
} = require('../../lib/commands/plan.js');

// ---------------------------------------------------------------------------
// Phase 1: readResearchDoc — slug validation
// ---------------------------------------------------------------------------
describe('Plan Phase 1 — readResearchDoc slug validation', () => {
	test('should reject null slug', () => {
		const result = readResearchDoc(null);
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	test('should reject undefined slug', () => {
		const result = readResearchDoc(undefined);
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	test('should reject numeric slug', () => {
		const result = readResearchDoc(123);
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	test('should reject slug shorter than 3 chars', () => {
		const result = readResearchDoc('ab');
		expect(result.success).toBe(false);
		expect(result.error.toLowerCase()).toContain('short');
	});

	test('should reject slug longer than 100 chars', () => {
		const longSlug = 'a'.repeat(101);
		const result = readResearchDoc(longSlug);
		expect(result.success).toBe(false);
		expect(result.error.toLowerCase()).toContain('long');
	});

	test('should reject slug with uppercase letters', () => {
		const result = readResearchDoc('MyFeature');
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	test('should reject slug with spaces', () => {
		const result = readResearchDoc('my feature');
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	test('should reject slug starting with a hyphen', () => {
		const result = readResearchDoc('-bad-slug');
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	test('should reject slug ending with a hyphen', () => {
		const result = readResearchDoc('bad-slug-');
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	test('should reject slug with special characters', () => {
		const result = readResearchDoc('my_feature!');
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	test('should return success=false for nonexistent file with valid slug', () => {
		// This file definitely does not exist
		const result = readResearchDoc('zzz-does-not-exist-xyz');
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	test('should return success=true reading an actual existing research doc (test-feature)', () => {
		// docs/research/test-feature.md exists in the repo
		const result = readResearchDoc('test-feature');
		expect(result.success).toBe(true);
		expect(result.content).toBeTruthy();
		expect(result.path).toBe('docs/research/test-feature.md');
	});

	test('should include path matching slug in success result', () => {
		const result = readResearchDoc('new-feature');
		expect(result.success).toBe(true);
		expect(result.path).toContain('new-feature');
	});
});

// ---------------------------------------------------------------------------
// Phase 1: detectScope — edge cases and boundary behavior
// ---------------------------------------------------------------------------
describe('Plan Phase 1 — detectScope edge cases', () => {
	test('should return tactical for null input (safe default)', () => {
		const scope = detectScope(null);
		expect(scope.type).toBe('tactical');
		expect(scope.requiresOpenSpec).toBe(false);
		expect(scope.reason).toBeTruthy();
	});

	test('should return tactical for undefined input', () => {
		const scope = detectScope(undefined);
		expect(scope.type).toBe('tactical');
		expect(scope.requiresOpenSpec).toBe(false);
		expect(scope.reason).toBeTruthy();
	});

	test('should return tactical for empty string', () => {
		const scope = detectScope('');
		expect(scope.type).toBe('tactical');
		expect(scope.requiresOpenSpec).toBe(false);
		expect(scope.reason).toBeTruthy();
	});

	test('should always include a reason field for tactical results', () => {
		const tactical = detectScope('# Just a small fix');
		expect(tactical.reason).toBeTruthy();
	});

	test('should always include a reason field for strategic results', () => {
		const strategic = detectScope('This is a major architecture change.');
		expect(strategic.reason).toBeTruthy();
	});

	test('should default to tactical when no keywords and no scope section', () => {
		const content = '# My Feature\n\nA small UI fix to the button label.';
		const scope = detectScope(content);
		expect(scope.type).toBe('tactical');
		expect(scope.requiresOpenSpec).toBe(false);
	});

	test('should include detected keywords in reason string for keyword-based strategic', () => {
		const content = 'This requires a breaking change to the API.';
		const scope = detectScope(content);
		expect(scope.type).toBe('strategic');
		expect(scope.reason.toLowerCase()).toContain('breaking change');
	});

	test('should detect strategic from "migration" keyword', () => {
		const scope = detectScope('We need a full database migration.');
		expect(scope.type).toBe('strategic');
		expect(scope.requiresOpenSpec).toBe(true);
	});

	test('should detect strategic from "refactor" keyword', () => {
		const scope = detectScope('A large-scale refactor of the auth module.');
		expect(scope.type).toBe('strategic');
		expect(scope.requiresOpenSpec).toBe(true);
	});

	test('should detect strategic from "redesign" keyword', () => {
		const scope = detectScope('Complete redesign of the payment flow.');
		expect(scope.type).toBe('strategic');
		expect(scope.requiresOpenSpec).toBe(true);
	});

	test('should stop reading scope section at next ## heading', () => {
		// Tactical in Scope Assessment section, Strategic keyword in a later section
		// Only the Scope Assessment declaration should be used
		const content = `## Scope Assessment
**Strategic/Tactical**: Tactical

## Implementation Notes
**Strategic/Tactical**: Strategic
`;
		const scope = detectScope(content);
		expect(scope.type).toBe('tactical');
	});

	test('should use explicit Scope Assessment over keyword detection', () => {
		// Has "architecture" keyword but explicit Tactical declaration
		const content = `
## Scope Assessment
**Strategic/Tactical**: Tactical

The architecture will remain unchanged.
`;
		const scope = detectScope(content);
		// Explicit declaration wins
		expect(scope.type).toBe('tactical');
		expect(scope.requiresOpenSpec).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Phase 1: extractDesignDecisions — design doc output
// ---------------------------------------------------------------------------
describe('Plan Phase 1 — extractDesignDecisions', () => {
	test('should return empty array for null input', () => {
		const design = extractDesignDecisions(null);
		expect(design.decisions).toEqual([]);
	});

	test('should return empty array for undefined input', () => {
		const design = extractDesignDecisions(undefined);
		expect(design.decisions).toEqual([]);
	});

	test('should return empty array for empty string', () => {
		const design = extractDesignDecisions('');
		expect(design.decisions).toEqual([]);
	});

	test('should return empty array when no Key Decisions section exists', () => {
		const content = '# Research\n\n## TDD Test Scenarios\n### Scenario 1: Login';
		const design = extractDesignDecisions(content);
		expect(design.decisions).toEqual([]);
	});

	test('should return decisions as array of strings', () => {
		const content = `
## Key Decisions
### Decision 1: Use TypeScript
**Reasoning**: Type safety
`;
		const design = extractDesignDecisions(content);
		expect(Array.isArray(design.decisions)).toBe(true);
		expect(typeof design.decisions[0]).toBe('string');
	});

	test('should extract multiple numbered decisions with reasoning', () => {
		const content = `
## Key Decisions
### Decision 1: Use JWT tokens
**Reasoning**: Stateless auth scales better

### Decision 2: Use refresh token rotation
**Reasoning**: Limits replay risk
`;
		const design = extractDesignDecisions(content);
		expect(design.decisions.length).toBe(2);
		expect(design.decisions[0]).toContain('JWT tokens');
		expect(design.decisions[1]).toContain('refresh token rotation');
	});

	test('each numbered decision string should include the reasoning', () => {
		const content = `
## Key Decisions
### Decision 1: Use Redis
**Reasoning**: Fast in-memory caching
`;
		const design = extractDesignDecisions(content);
		expect(design.decisions[0]).toContain('Reasoning:');
		expect(design.decisions[0]).toContain('Fast in-memory caching');
	});

	test('should fall back to simple heading format when no reasoning lines present', () => {
		const content = `
## Key Decisions

### Use PostgreSQL
### Use connection pooling
### Use prepared statements
`;
		const design = extractDesignDecisions(content);
		expect(design.decisions.length).toBe(3);
		expect(design.decisions[0]).toContain('PostgreSQL');
		expect(design.decisions[1]).toContain('connection pooling');
		expect(design.decisions[2]).toContain('prepared statements');
	});

	test('should return object with decisions property', () => {
		const design = extractDesignDecisions('no decisions here');
		expect(design).toHaveProperty('decisions');
		expect(Array.isArray(design.decisions)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Phase 2: extractTasksFromResearch — TDD task list generation
// ---------------------------------------------------------------------------
describe('Plan Phase 2 — extractTasksFromResearch TDD task generation', () => {
	test('should return empty array for null input', () => {
		const tasks = extractTasksFromResearch(null);
		expect(tasks).toEqual([]);
	});

	test('should return empty array for undefined input', () => {
		const tasks = extractTasksFromResearch(undefined);
		expect(tasks).toEqual([]);
	});

	test('should return empty array for empty string', () => {
		const tasks = extractTasksFromResearch('');
		expect(tasks).toEqual([]);
	});

	test('should return empty array when no TDD Test Scenarios section present', () => {
		const content = '# Research\n\n## Key Decisions\n### Decision 1: Use Redis\n**Reasoning**: Fast';
		const tasks = extractTasksFromResearch(content);
		expect(tasks).toEqual([]);
	});

	test('should generate exactly 3 tasks per scenario (RED, GREEN, REFACTOR cycle)', () => {
		const content = `
## TDD Test Scenarios
### Scenario 1: Validate user input
`;
		const tasks = extractTasksFromResearch(content);
		expect(tasks.length).toBe(3);
		expect(tasks[0].phase).toBe('RED');
		expect(tasks[1].phase).toBe('GREEN');
		expect(tasks[2].phase).toBe('REFACTOR');
	});

	test('should generate 6 tasks for 2 scenarios', () => {
		const content = `
## TDD Test Scenarios
### Scenario 1: Validate user input
### Scenario 2: Process payment
`;
		const tasks = extractTasksFromResearch(content);
		expect(tasks.length).toBe(6);
	});

	test('should generate 9 tasks for 3 scenarios', () => {
		const content = `
## TDD Test Scenarios
### Scenario 1: Login happy path
### Scenario 2: Invalid credentials
### Scenario 3: Session expiry
`;
		const tasks = extractTasksFromResearch(content);
		expect(tasks.length).toBe(9);
	});

	test('should embed scenario name in all 3 task descriptions', () => {
		const content = `
## TDD Test Scenarios
### Scenario 1: Handle expired tokens
`;
		const tasks = extractTasksFromResearch(content);
		expect(tasks[0].description).toContain('Handle expired tokens');
		expect(tasks[1].description).toContain('Handle expired tokens');
		expect(tasks[2].description).toContain('Handle expired tokens');
	});

	test('should stop extracting at next top-level ## section', () => {
		const content = `
## TDD Test Scenarios
### Scenario 1: Valid case

## Other Section
### Scenario 2: Should not be in tasks
`;
		const tasks = extractTasksFromResearch(content);
		expect(tasks.length).toBe(3); // only Scenario 1
	});

	test('each task should have phase and description fields', () => {
		const content = `
## TDD Test Scenarios
### Scenario 1: My test
`;
		const tasks = extractTasksFromResearch(content);
		for (const task of tasks) {
			expect(task).toHaveProperty('phase');
			expect(task).toHaveProperty('description');
		}
	});

	test('phase field should only be RED, GREEN, or REFACTOR', () => {
		const content = `
## TDD Test Scenarios
### Scenario 1: Auth flow
### Scenario 2: Payment flow
`;
		const tasks = extractTasksFromResearch(content);
		const validPhases = ['RED', 'GREEN', 'REFACTOR'];
		for (const task of tasks) {
			expect(validPhases).toContain(task.phase);
		}
	});

	test('first task of each scenario should always be RED', () => {
		const content = `
## TDD Test Scenarios
### Scenario 1: Login
### Scenario 2: Logout
`;
		const tasks = extractTasksFromResearch(content);
		expect(tasks[0].phase).toBe('RED'); // Scenario 1 first
		expect(tasks[3].phase).toBe('RED'); // Scenario 2 first
	});

	test('last task of each scenario should always be REFACTOR', () => {
		const content = `
## TDD Test Scenarios
### Scenario 1: Login
`;
		const tasks = extractTasksFromResearch(content);
		expect(tasks[tasks.length - 1].phase).toBe('REFACTOR');
	});
});

// ---------------------------------------------------------------------------
// Phase 3: createBeadsIssue — input validation (no I/O paths)
// ---------------------------------------------------------------------------
describe('Plan Phase 3 — createBeadsIssue input validation', () => {
	test('should return error when featureName is empty string', () => {
		const result = createBeadsIssue('', 'docs/research/feature.md', 'tactical');
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	test('should return error when researchPath is empty string', () => {
		const result = createBeadsIssue('My Feature', '', 'tactical');
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	test('should return error for invalid scope value', () => {
		const result = createBeadsIssue('My Feature', 'docs/research/feature.md', 'invalid-scope');
		expect(result.success).toBe(false);
		expect(result.error.toLowerCase()).toContain('scope');
	});

	test('should return error when scope is empty string', () => {
		const result = createBeadsIssue('My Feature', 'docs/research/feature.md', '');
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	test('should return error when featureName is null', () => {
		const result = createBeadsIssue(null, 'docs/research/feature.md', 'tactical');
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	test('should return error when researchPath is null', () => {
		const result = createBeadsIssue('My Feature', null, 'tactical');
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	test('should return error when scope is Strategic (wrong case — must be lowercase)', () => {
		// Case-sensitive: 'Strategic' is not accepted, only 'strategic'
		const result = createBeadsIssue('My Feature', 'docs/research/feature.md', 'Strategic');
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	test('should return error when scope is Tactical (wrong case — must be lowercase)', () => {
		const result = createBeadsIssue('My Feature', 'docs/research/feature.md', 'Tactical');
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// Phase 3: createFeatureBranch — slug validation (fires before git)
// ---------------------------------------------------------------------------
describe('Plan Phase 3 — createFeatureBranch slug validation', () => {
	test('should reject null slug (returns error, no git call)', () => {
		const result = createFeatureBranch(null);
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	test('should reject undefined slug', () => {
		const result = createFeatureBranch(undefined);
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	test('should reject slug with uppercase letters', () => {
		const result = createFeatureBranch('MyFeature');
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	test('should reject slug with spaces', () => {
		const result = createFeatureBranch('my feature');
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	test('should reject slug shorter than 3 chars', () => {
		const result = createFeatureBranch('ab');
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	test('should reject slug longer than 100 chars', () => {
		const result = createFeatureBranch('a'.repeat(101));
		expect(result.success).toBe(false);
		expect(result.error.toLowerCase()).toContain('long');
	});

	test('should reject slug starting with hyphen', () => {
		const result = createFeatureBranch('-bad-slug');
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	test('should reject slug ending with hyphen', () => {
		const result = createFeatureBranch('bad-slug-');
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	test('should reject slug with underscore', () => {
		const result = createFeatureBranch('my_feature');
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// Phase 3: executePlan — featureName validation (early exit, no I/O)
// ---------------------------------------------------------------------------
describe('Plan Phase 3 — executePlan featureName validation', () => {
	test('should return error for null featureName', async () => {
		const result = await executePlan(null);
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	test('should return error for undefined featureName', async () => {
		const result = await executePlan(undefined);
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	test('should return error for empty string featureName', async () => {
		const result = await executePlan('');
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	test('should return error for numeric featureName', async () => {
		const result = await executePlan(42);
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	test('should return error for array featureName', async () => {
		const result = await executePlan(['feature']);
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	test('should always return object with success property', async () => {
		const result = await executePlan(null);
		expect(result).toHaveProperty('success');
		expect(result.success).toBe(false);
	});

	test('should return error when research doc does not exist for valid name', async () => {
		// 'zzz-does-not-exist-xyz' will not have a research doc on disk
		const result = await executePlan('zzz-does-not-exist-xyz');
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});
});
