const { describe, test, expect, setDefaultTimeout } = require('bun:test');
const {
	extractKeyDecisions,
	extractTestScenarios,
	getTestCoverage,
	generatePRBody,
	createPR,
	executeShip,
	getBranchReadiness,
	resolveBaseRemote,
	resolveBaseBranch,
} = require('../../lib/commands/ship.js');

setDefaultTimeout(15000);

describe('Ship Command - PR Creation', () => {
	describe('Extract key decisions from research', () => {
		test('should extract decisions from research doc', () => {
			const researchContent = `# Research: Login Authentication

## Key Decisions

- **Decision 1**: Use JWT tokens instead of sessions
  - Rationale: Stateless authentication for API scalability
  - Alternatives considered: Session cookies, OAuth2

- **Decision 2**: Store refresh tokens in httpOnly cookies
  - Rationale: XSS protection while maintaining UX
  - Security: OWASP A07 (Authentication failures)

## Test Scenarios

1. Valid login credentials → JWT token returned
2. Invalid password → 401 Unauthorized
3. Token expiry → Refresh token flow
`;

			const decisions = extractKeyDecisions(researchContent);
			expect(Array.isArray(decisions)).toBeTruthy();
			expect(decisions.length >= 2).toBeTruthy();
			expect(decisions[0].includes('JWT')).toBeTruthy();
			expect(decisions[1].includes('httpOnly cookies')).toBeTruthy();
		});

		test('should extract decisions from heading and reasoning format', () => {
			const researchContent = `# Feature - Research Document

## Key Decisions & Reasoning

### Decision 1: Use JWT tokens

**Reasoning**: Stateless auth scales better for APIs

### Decision 2: Use refresh token rotation

**Reasoning**: Limits replay risk on token theft

## TDD Test Scenarios

### Scenario 1: Happy path test
`;

			const decisions = extractKeyDecisions(researchContent);
			expect(Array.isArray(decisions)).toBeTruthy();
			expect(decisions.length).toBe(2);
			expect(decisions[0].includes('Use JWT tokens')).toBeTruthy();
			expect(decisions[0].includes('Reasoning: Stateless auth scales better for APIs')).toBeTruthy();
			expect(decisions[1].includes('Use refresh token rotation')).toBeTruthy();
		});

		test('should handle research doc with no decisions section', () => {
			const researchContent = `# Research: Simple Feature

Some research content without decisions section.`;

			const decisions = extractKeyDecisions(researchContent);
			expect(Array.isArray(decisions)).toBeTruthy();
			expect(decisions.length).toBe(0);
		});
	});

	describe('Extract test scenarios from research', () => {
		test('should extract test scenarios from research doc', () => {
			const researchContent = `# Research: Feature

## Test Scenarios

1. Happy path test case
2. Error handling test case
3. Edge case validation
`;

			const scenarios = extractTestScenarios(researchContent);
			expect(Array.isArray(scenarios)).toBeTruthy();
			expect(scenarios.length >= 3).toBeTruthy();
		});

		test('should extract scenarios from research.js heading format', () => {
			const researchContent = `# Research: Feature

## TDD Test Scenarios

### Scenario 1: Happy path test

**Test File**: test/feature.test.js

### Scenario 2: Error handling

**Test File**: test/feature.test.js
`;

			const scenarios = extractTestScenarios(researchContent);
			expect(Array.isArray(scenarios)).toBeTruthy();
			expect(scenarios).toEqual(['Happy path test', 'Error handling']);
		});

		test('should handle research doc with no test scenarios', () => {
			const researchContent = `# Research: Feature

No test scenarios section.`;

			const scenarios = extractTestScenarios(researchContent);
			expect(Array.isArray(scenarios)).toBeTruthy();
			expect(scenarios.length).toBe(0);
		});
	});

	describe('Get test coverage metrics', () => {
		test.skip('should get coverage from c8 report', async () => {
			const coverage = await getTestCoverage();
			expect(coverage.lines !== undefined).toBeTruthy();
			expect(coverage.branches !== undefined).toBeTruthy();
			expect(coverage.functions !== undefined).toBeTruthy();
			expect(coverage.statements !== undefined).toBeTruthy();
		});

		test('should handle missing coverage report gracefully', async () => {
			const coverage = await getTestCoverage();
			expect(coverage).toBeTruthy();
			// Should return default values or skip indicator
		});
	});

	describe('Generate PR body', () => {
		test('should generate complete PR body', () => {
			const context = {
				featureName: 'Login Authentication',
				researchDoc: 'docs/research/login-auth.md',
				decisions: [
					'Use JWT tokens for authentication',
					'Store refresh tokens in httpOnly cookies',
				],
				testScenarios: [
					'Valid login → JWT token',
					'Invalid password → 401',
				],
				coverage: {
					lines: 85.5,
					branches: 80.2,
					functions: 90.0,
					statements: 85.5,
				},
			};

			const body = generatePRBody(context);
			expect(typeof body === 'string').toBeTruthy();
			expect(body.includes('Login Authentication')).toBeTruthy();
			expect(body.includes('JWT tokens')).toBeTruthy();
			expect(body.includes('85.5%')).toBeTruthy(); // Coverage
			expect(body.includes('Research:')).toBeTruthy(); // Research doc link
		});

		test('should handle missing coverage data', () => {
			const context = {
				featureName: 'Simple Feature',
				decisions: ['Decision 1'],
				testScenarios: ['Test 1'],
				coverage: null, // No coverage
			};

			const body = generatePRBody(context);
			expect(typeof body === 'string').toBeTruthy();
			expect(body.includes('Simple Feature')).toBeTruthy();
			expect(!body.includes('Coverage:')).toBeTruthy(); // Should skip coverage section
		});

		test('should include all required PR sections', () => {
			const context = {
				featureName: 'Feature X',
				decisions: ['Decision 1'],
				testScenarios: ['Test 1'],
			};

			const body = generatePRBody(context);
			// Check for standard PR sections
			expect(body.includes('## Summary')).toBeTruthy();
			expect(body.includes('## Key Decisions')).toBeTruthy();
			expect(body.includes('## Test Scenarios')).toBeTruthy();
		});
	});

	describe('Create PR via gh CLI', () => {
		test('should prefer upstream as the base remote when present', () => {
			const exec = (command, args) => {
				expect(command).toBe('git');
				if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'upstream') {
					return 'https://github.com/base/repo.git\n';
				}
				if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
					return 'https://github.com/fork/repo.git\n';
				}
				if (args[0] === 'symbolic-ref' && args[1] === 'refs/remotes/upstream/HEAD') {
					return 'refs/remotes/upstream/main\n';
				}
				if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'refs/remotes/upstream/main') {
					return 'refs/remotes/upstream/main\n';
				}
				throw new Error(`Unexpected git command: ${args.join(' ')}`);
			};

			expect(resolveBaseRemote(exec, process.cwd())).toBe('upstream');
		});

		test('should use quiet git probe options during base remote resolution', () => {
			const probeOptions = [];
			const exec = (command, args, options) => {
				expect(command).toBe('git');
				probeOptions.push(options);
				if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'upstream') {
					throw new Error('missing upstream');
				}
				if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
					return 'https://github.com/fork/repo.git\n';
				}
				if (args[0] === 'symbolic-ref' && args[1] === 'refs/remotes/origin/HEAD') {
					throw new Error('missing origin HEAD');
				}
				if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'refs/remotes/origin/main') {
					return 'refs/remotes/origin/main\n';
				}
				throw new Error(`Unexpected git command: ${args.join(' ')}`);
			};

			expect(resolveBaseRemote(exec, process.cwd())).toBe('origin');
			expect(probeOptions.every((options) => options && options.stdio === 'pipe')).toBe(true);
		});

		test('should fall back to origin when upstream has no fetched tracking refs', () => {
			const exec = (command, args) => {
				expect(command).toBe('git');
				if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'upstream') {
					return 'https://github.com/base/repo.git\n';
				}
				if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
					return 'https://github.com/fork/repo.git\n';
				}
				if (args[0] === 'symbolic-ref' && args[1] === 'refs/remotes/upstream/HEAD') {
					throw new Error('missing upstream HEAD');
				}
				if (args[0] === 'rev-parse' && args[2] === 'refs/remotes/upstream/main') {
					throw new Error('missing upstream main');
				}
				if (args[0] === 'rev-parse' && args[2] === 'refs/remotes/upstream/master') {
					throw new Error('missing upstream master');
				}
				if (args[0] === 'symbolic-ref' && args[1] === 'refs/remotes/origin/HEAD') {
					return 'refs/remotes/origin/main\n';
				}
				throw new Error(`Unexpected git command: ${args.join(' ')}`);
			};

			expect(resolveBaseRemote(exec, process.cwd())).toBe('origin');
		});

		test('should fall back to origin when upstream HEAD points to a missing ref', () => {
			const exec = (command, args) => {
				expect(command).toBe('git');
				if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'upstream') {
					return 'https://github.com/base/repo.git\n';
				}
				if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
					return 'https://github.com/fork/repo.git\n';
				}
				if (args[0] === 'symbolic-ref' && args[1] === 'refs/remotes/upstream/HEAD') {
					return 'refs/remotes/upstream/trunk\n';
				}
				if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'refs/remotes/upstream/trunk') {
					throw new Error('missing upstream trunk');
				}
				if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'refs/remotes/upstream/main') {
					throw new Error('missing upstream main');
				}
				if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'refs/remotes/upstream/master') {
					throw new Error('missing upstream master');
				}
				if (args[0] === 'symbolic-ref' && args[1] === 'refs/remotes/origin/HEAD') {
					return 'refs/remotes/origin/main\n';
				}
				if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'refs/remotes/origin/main') {
					return 'refs/remotes/origin/main\n';
				}
				throw new Error(`Unexpected git command: ${args.join(' ')}`);
			};

			expect(resolveBaseRemote(exec, process.cwd())).toBe('origin');
		});

		test('should detect the default base branch from origin/HEAD', () => {
			const exec = (command, args) => {
				expect(command).toBe('git');
				if (args[0] === 'symbolic-ref') {
					expect(args).toEqual(['symbolic-ref', 'refs/remotes/origin/HEAD']);
					return 'refs/remotes/origin/main\n';
				}
				if (args[0] === 'rev-parse') {
					expect(args).toEqual(['rev-parse', '--verify', 'refs/remotes/origin/main']);
					return 'refs/remotes/origin/main\n';
				}
				throw new Error(`Unexpected git command: ${args.join(' ')}`);
			};

			expect(resolveBaseBranch(exec, process.cwd(), 'origin')).toBe('main');
		});

		test('should ignore a stale remote HEAD target and fall back to main', () => {
			const exec = (command, args) => {
				expect(command).toBe('git');
				if (args[0] === 'symbolic-ref' && args[1] === 'refs/remotes/upstream/HEAD') {
					return 'refs/remotes/upstream/trunk\n';
				}
				if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'refs/remotes/upstream/trunk') {
					throw new Error('missing upstream trunk');
				}
				if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'refs/remotes/upstream/main') {
					return 'refs/remotes/upstream/main\n';
				}
				throw new Error(`Unexpected git command: ${args.join(' ')}`);
			};

			expect(resolveBaseBranch(exec, process.cwd(), 'upstream')).toBe('main');
		});

		test('should report when the current branch has no tree diff against the base branch', () => {
			const exec = (command, args) => {
				expect(command).toBe('git');
				if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'upstream') {
					return 'https://github.com/base/repo.git\n';
				}
				if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
					return 'https://github.com/fork/repo.git\n';
				}
				if (args[0] === 'symbolic-ref') {
					return 'refs/remotes/upstream/master\n';
				}
				if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'refs/remotes/upstream/master') {
					return 'refs/remotes/upstream/master\n';
				}
				if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
					return 'feat/setup-hardening-codex-parity\n';
				}
				if (args[0] === 'fetch' && args[3] === 'upstream') {
					return '';
				}
				if (args[0] === 'rev-list') {
					return '0\t2\n';
				}
				if (args[0] === 'diff') {
					return '';
				}
				throw new Error(`Unexpected git command: ${args.join(' ')}`);
			};

			const result = getBranchReadiness({ exec, cwd: process.cwd() });
			expect(result.ready).toBe(false);
			expect(result.baseRemote).toBe('upstream');
			expect(result.error).toContain('has no diff against upstream/master');
			expect(result.error).toContain('not PR-ready');
		});

		test('should refresh the selected base ref before readiness checks', () => {
			const execCalls = [];
			const exec = (command, args) => {
				expect(command).toBe('git');
				execCalls.push(args);
				if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
					return 'feat/ship-refresh\n';
				}
				if (args[0] === 'fetch' && args[3] === 'origin') {
					return '';
				}
				if (args[0] === 'rev-list') {
					return '0\t1\n';
				}
				if (args[0] === 'diff') {
					const error = new Error('diff detected');
					error.status = 1;
					throw error;
				}
				throw new Error(`Unexpected git command: ${args.join(' ')}`);
			};

			const result = getBranchReadiness({
				exec,
				cwd: process.cwd(),
				baseRemote: 'origin',
				baseBranch: 'main',
			});

			expect(result.ready).toBe(true);
			const fetchIndex = execCalls.findIndex((args) => args[0] === 'fetch');
			const revListIndex = execCalls.findIndex((args) => args[0] === 'rev-list');
			expect(fetchIndex).toBeGreaterThanOrEqual(0);
			expect(revListIndex).toBeGreaterThan(fetchIndex);
		});

		test('should fail readiness when refreshing the base ref fails', () => {
			const exec = (command, args) => {
				expect(command).toBe('git');
				if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
					return 'feat/ship-refresh\n';
				}
				if (args[0] === 'fetch' && args[3] === 'origin') {
					throw new Error('network unavailable');
				}
				throw new Error(`Unexpected git command: ${args.join(' ')}`);
			};

			const result = getBranchReadiness({
				exec,
				cwd: process.cwd(),
				baseRemote: 'origin',
				baseBranch: 'main',
			});

			expect(result.ready).toBe(false);
			expect(result.error).toContain('Unable to refresh origin/main before comparing branch readiness');
			expect(result.error).toContain('network unavailable');
		});

		test.skip('forge-g11n: should create PR with generated body', async () => {
			const prBody = '## Summary\n\nTest PR body';
			const result = await createPR({
				title: 'feat: test feature',
				body: prBody,
				dryRun: true, // Don't actually create PR
			});

			expect(result.success).toBeTruthy();
		});

		test.skip('should handle gh CLI not found', async () => {
			// Simulate gh not installed
			const result = await createPR({
				title: 'feat: test',
				body: 'Test',
				dryRun: true,
			});

			expect(result.success !== undefined).toBeTruthy();
			if (!result.success) {
				expect(result.error).toBeTruthy();
			}
		});

		test('should validate PR title format', async () => {
			const result = await createPR({
				title: 'invalid title without prefix',
				body: 'Test',
				dryRun: true,
			});

			// Should fail validation
			expect(result.success === false || result.error).toBeTruthy();
		});

		test('should refuse to create a PR when the branch has no diff against base', async () => {
			const exec = (command, args) => {
				if (command === 'gh' && args[0] === '--version') {
					return 'gh version 2.81.0\n';
				}
				if (command === 'git' && args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'upstream') {
					return 'https://github.com/base/repo.git\n';
				}
				if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--git-dir') {
					return '.git\n';
				}
				if (command === 'git' && args[0] === 'remote' && args[1] === 'get-url') {
					return 'https://github.com/owner/repo.git\n';
				}
				if (command === 'git' && args[0] === 'symbolic-ref') {
					return 'refs/remotes/upstream/master\n';
				}
				if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'refs/remotes/upstream/master') {
					return 'refs/remotes/upstream/master\n';
				}
				if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
					return 'feat/setup-hardening-codex-parity\n';
				}
				if (command === 'git' && args[0] === 'fetch' && args[3] === 'upstream') {
					return '';
				}
				if (command === 'git' && args[0] === 'rev-list') {
					return '0\t2\n';
				}
				if (command === 'git' && args[0] === 'diff') {
					return '';
				}
				throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
			};

			const result = await createPR({
				title: 'feat: test feature branch readiness',
				body: 'Test body',
				dryRun: true,
				exec,
			});

			expect(result.success).toBe(false);
			expect(result.error).toContain('has no diff against upstream/master');
		});
	});

	describe('Full ship workflow', () => {
		test.skip('should execute complete ship workflow', async () => {
			const result = await executeShip({
				featureSlug: 'test-feature',
				title: 'feat: implement test feature',
			});

			expect(result.success).toBeTruthy();
			expect(result.prUrl || result.prNumber).toBeTruthy();
		});

		test('should validate feature slug parameter', async () => {
			const result = await executeShip({
				featureSlug: '', // Invalid
				title: 'feat: test',
			});

			expect(result.success).toBe(false);
			expect(result.error).toBeTruthy();
			expect(result.error).toMatch(/feature.*slug/i);
		});

		test('should validate PR title parameter', async () => {
			const result = await executeShip({
				featureSlug: 'test-feature',
				title: '', // Invalid
			});

			expect(result.success).toBe(false);
			expect(result.error).toBeTruthy();
			expect(result.error).toMatch(/title/i);
		});

		test('should handle missing research doc gracefully', async () => {
			const result = await executeShip({
				featureSlug: 'nonexistent-feature',
				title: 'feat: test',
			});

			expect(result.success !== undefined).toBeTruthy();
			// Should either fail or warn about missing research
		});

		test('should return PR URL on success', async () => {
			const result = await executeShip({
				featureSlug: 'test-feature',
				title: 'feat: test',
				dryRun: true, // Simulation mode
			});

			if (result.success) {
				expect(result.prUrl || result.message).toBeTruthy();
			}
		});
	});

	describe('Error handling', () => {
		test('should handle git errors gracefully', async () => {
			// Simulate not in a git repo or no remote
			const result = await createPR({
				title: 'feat: test',
				body: 'Test',
				dryRun: true,
			});

			expect(result.success !== undefined).toBeTruthy();
		});

		test('should handle file read errors', () => {
			const decisions = extractKeyDecisions(null); // Invalid input
			expect(Array.isArray(decisions)).toBeTruthy();
			expect(decisions.length).toBe(0);
		});

		test('should provide actionable error messages', async () => {
			const result = await executeShip({
				featureSlug: null, // Invalid
				title: 'test',
			});

			expect(result.success).toBe(false);
			expect(result.error).toBeTruthy();
			// Error should be actionable
			expect(result.error.length > 20).toBeTruthy(); // Not just "error"
		});
	});
});
