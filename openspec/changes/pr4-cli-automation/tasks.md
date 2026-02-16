# Tasks: CLI Command Automation

TDD-ordered implementation checklist for PR4.

---

## Phase 1: Foundation (Day 1)

### Task 1: Command Dispatcher Structure

**Test (RED)**:
- [ ] Create test/cli/forge-cmd.test.js
- [ ] Test: should parse command and arguments
- [ ] Test: should show help for unknown command
- [ ] Test: should return error for missing arguments
- [ ] Run tests → FAIL

**Implement (GREEN)**:
- [ ] Create bin/forge-cmd.js
- [ ] Implement argument parsing
- [ ] Implement switch-based command dispatch
- [ ] Add help text
- [ ] Run tests → PASS

**Refactor**:
- [ ] Extract parseArgs() function
- [ ] Add input validation
- [ ] Commit: "feat: add CLI command dispatcher"

### Task 2: Status Command with Stage Detection

**Test (RED)**:
- [ ] Create test/commands/status.test.js
- [ ] Test: detect stage 1 (fresh project)
- [ ] Test: detect stage 3 (research exists)
- [ ] Test: detect stage 6 (ready to ship)
- [ ] Test: calculate confidence score
- [ ] Run tests → FAIL

**Implement (GREEN)**:
- [ ] Create lib/commands/status.js
- [ ] Implement detectStage() function
- [ ] Check branch, files, PR, Beads state
- [ ] Calculate confidence score
- [ ] Format output
- [ ] Run tests → PASS

**Refactor**:
- [ ] Extract factor checking functions
- [ ] Add caching for file checks
- [ ] Commit: "feat: add intelligent stage detection"

---

## Phase 2: Research & Plan Automation (Day 2)

### Task 3: Research Command

**Test (RED)**:
- [ ] Create test/commands/research.test.js
- [ ] Test: validate feature slug format
- [ ] Test: create research doc from parallel-ai
- [ ] Test: handle API timeout gracefully
- [ ] Test: reject invalid slugs
- [ ] Run tests → FAIL

**Implement (GREEN)**:
- [ ] Create lib/commands/research.js
- [ ] Implement validateInput()
- [ ] Implement invokeParallelAI()
- [ ] Implement createResearchDoc()
- [ ] Add error handling
- [ ] Run tests → PASS

**Refactor**:
- [ ] Extract template formatting
- [ ] Add retry logic for API
- [ ] Commit: "feat: automate research command"

### Task 4: Plan Command

**Test (RED)**:
- [ ] Create test/commands/plan.test.js
- [ ] Test: detect tactical vs strategic
- [ ] Test: create Beads issue
- [ ] Test: create feature branch
- [ ] Test: create OpenSpec (if strategic)
- [ ] Run tests → FAIL

**Implement (GREEN)**:
- [ ] Create lib/commands/plan.js
- [ ] Implement detectScope()
- [ ] Implement createBeadsIssue()
- [ ] Implement createBranch()
- [ ] Implement createOpenSpec()
- [ ] Run tests → PASS

**Refactor**:
- [ ] Extract OpenSpec template
- [ ] Add branch name validation
- [ ] Commit: "feat: automate plan command"

---

## Phase 3: Ship & Review Automation (Day 3)

### Task 5: Ship Command (PR Body Generation)

**Test (RED)**:
- [ ] Create test/commands/ship.test.js
- [ ] Test: generate PR body from research
- [ ] Test: extract key decisions
- [ ] Test: calculate test coverage
- [ ] Test: handle missing research doc
- [ ] Run tests → FAIL

**Implement (GREEN)**:
- [ ] Create lib/commands/ship.js
- [ ] Implement extractDecisions()
- [ ] Implement calculateCoverage()
- [ ] Implement generatePRBody()
- [ ] Implement createPR()
- [ ] Run tests → PASS

**Refactor**:
- [ ] Extract PR template
- [ ] Add coverage formatting
- [ ] Commit: "feat: automate PR creation"

### Task 6: Review Command (Aggregation)

**Test (RED)**:
- [ ] Create test/commands/review.test.js
- [ ] Test: aggregate all review sources
- [ ] Test: prioritize by severity
- [ ] Test: deduplicate similar issues
- [ ] Test: handle API failures gracefully
- [ ] Run tests → FAIL

**Implement (GREEN)**:
- [ ] Create lib/commands/review.js
- [ ] Implement fetchGitHubStatus()
- [ ] Implement fetchGreptileComments()
- [ ] Implement fetchSonarCloudIssues()
- [ ] Implement categorizeIssues()
- [ ] Implement formatOutput()
- [ ] Run tests → PASS

**Refactor**:
- [ ] Add parallel fetching
- [ ] Extract deduplication logic
- [ ] Commit: "feat: automate review aggregation"

---

## Phase 4: Testing & Documentation (Day 4)

### Task 7: E2E Workflow Tests

**Test (RED)**:
- [ ] Create test/e2e/cli-workflow.test.js
- [ ] Test: complete status → research → plan workflow
- [ ] Test: complete plan → dev → check → ship workflow
- [ ] Test: complete ship → review → merge workflow
- [ ] Run tests → FAIL

**Implement (GREEN)**:
- [ ] Set up E2E fixtures
- [ ] Mock API calls (Parallel AI, GitHub, Greptile)
- [ ] Implement workflow sequences
- [ ] Run tests → PASS

**Refactor**:
- [ ] Extract fixture creation helpers
- [ ] Add snapshot tests for CLI output
- [ ] Commit: "test: add E2E workflow tests"

### Task 8: Security Tests

**Test (RED)**:
- [ ] Create test/security/cli-security.test.js
- [ ] Test: reject path traversal attempts
- [ ] Test: reject command injection attempts
- [ ] Test: validate all user input
- [ ] Test: redact secrets in output
- [ ] Run tests → FAIL

**Implement (GREEN)**:
- [ ] Add comprehensive input validation
- [ ] Implement secret redaction
- [ ] Add path traversal checks
- [ ] Run tests → PASS

**Refactor**:
- [ ] Extract validation utilities
- [ ] Add security audit logging
- [ ] Commit: "feat: add CLI security validations"

### Task 9: Documentation Updates

**Document**:
- [ ] Update .claude/commands/*.md to reference CLI
- [ ] Update README.md with CLI usage
- [ ] Create docs/CLI.md with examples
- [ ] Update CLAUDE.md with CLI commands
- [ ] Commit: "docs: document CLI command automation"

### Task 10: Integration Testing

**Test**:
- [ ] Run full test suite (695 + 38 new tests)
- [ ] Verify 80% coverage maintained
- [ ] Test on Windows, macOS, Linux
- [ ] Manual E2E testing
- [ ] Performance testing (command execution time)

---

## Verification Checklist

- [ ] All 38 new tests passing
- [ ] Coverage ≥80% maintained
- [ ] No ESLint errors
- [ ] Security tests passing (OWASP A01, A03, A04, A05)
- [ ] Cross-platform compatibility (Windows, macOS, Linux)
- [ ] CLI help text clear and helpful
- [ ] Error messages actionable
- [ ] API rate limits handled
- [ ] Secrets never logged
- [ ] Documentation complete

---

## Success Criteria

- [ ] All 9 workflow commands executable via CLI
- [ ] Stage detection works with 90%+ accuracy
- [ ] PR body auto-generated from research + tests
- [ ] Review aggregation consolidates 3+ sources
- [ ] Full E2E workflow automation working
- [ ] Zero security vulnerabilities introduced
- [ ] Documentation complete and accurate

---

## Rollback Plan

If issues discovered:
1. Revert CLI commits (git revert)
2. Documentation still works (backward compatible)
3. Manual workflow still available
4. No breaking changes to existing features
