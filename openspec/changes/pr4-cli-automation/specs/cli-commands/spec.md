# CLI Commands Capability

Command-line automation for Forge workflow stages.

## ADDED Requirements

### R1: Command Dispatcher

The system SHALL provide a unified command dispatcher executable at `bin/forge-cmd.js`.

**Rationale**: Transform documentation-driven workflow to executable CLI, reducing workflow execution time by 6-10x.

#### Scenario: Parse command and arguments

GIVEN user runs `forge status`
WHEN dispatcher parses command
THEN command "status" is detected
AND `lib/commands/status.js` is executed

#### Scenario: Show help for unknown command

GIVEN user runs `forge unknown-command`
WHEN dispatcher parses command
THEN available commands list is displayed
AND exit code is 1

#### Scenario: Validate required arguments

GIVEN user runs `forge research` (without feature name)
WHEN dispatcher validates arguments
THEN error "feature-name required" is displayed
AND usage example is shown
AND exit code is 1

---

### R2: Status Command Enhancement

The system SHALL implement intelligent stage detection with confidence scoring.

**Rationale**: Auto-detect workflow stage (1-9) to guide user to next action.

#### Scenario: Detect stage 1 (fresh project)

GIVEN no feature branch, no research doc, no open Beads
WHEN user runs `forge status`
THEN stage 1 is detected
AND "Next: /research (feature-name)" is displayed
AND confidence is High (90-100%)

#### Scenario: Detect stage 3 (research exists, no plan)

GIVEN research doc exists at docs/research/feature.md
AND no feature branch exists
AND no OpenSpec proposal exists
WHEN user runs `forge status`
THEN stage 3 is detected
AND "Next: /plan (feature-slug)" is displayed
AND confidence is High (90-100%)

#### Scenario: Detect stage 6 (ready to ship)

GIVEN feature branch exists
AND all checks passed (/check)
AND no PR created yet
WHEN user runs `forge status`
THEN stage 6 is detected
AND "Next: /ship" is displayed
AND confidence is High (90-100%)

#### Scenario: Calculate confidence score

GIVEN mixed signals (branch exists, no research doc)
WHEN user runs `forge status`
THEN stage is detected with Medium confidence (70-89%)
AND manual verification is suggested

---

### R3: Research Automation

The system SHALL automate research document creation via parallel-ai integration.

**Rationale**: Reduce manual research workflow from 15-20 minutes to 2-3 minutes.

#### Scenario: Create research document

GIVEN user runs `forge research stripe-billing`
WHEN command executes
THEN parallel-ai skill is invoked for web research
AND docs/research/stripe-billing.md is created
AND OWASP Top 10 security analysis is included
AND TDD test scenarios are included
AND TEMPLATE.md structure is followed

#### Scenario: Validate feature slug format

GIVEN user runs `forge research "Invalid Feature Name"`
WHEN command validates input
THEN spaces in slug are rejected
AND error message is displayed
AND format /^[a-z0-9-]+$/ is enforced

#### Scenario: Handle API timeout gracefully

GIVEN Parallel AI API timeout after 60s
WHEN user runs `forge research timeout-test`
THEN "API timeout, retrying..." is displayed
AND retry up to 3 times
AND fail gracefully with partial results if available

---

### R4: Plan Automation

The system SHALL automate plan creation with scope detection.

**Rationale**: Automate branch creation, Beads issue creation, and OpenSpec proposal for strategic changes.

#### Scenario: Detect tactical scope

GIVEN research doc indicates less than 1 day work
WHEN user runs `forge plan fix-validation-bug`
THEN tactical scope is detected
AND Beads issue only is created (no OpenSpec)
AND feature branch is created
AND "Next: /dev" is displayed

#### Scenario: Detect strategic scope

GIVEN research doc indicates architecture change
WHEN user runs `forge plan stripe-billing`
THEN strategic scope is detected
AND OpenSpec proposal is created
AND Beads issue with OpenSpec link is created
AND feature branch is created
AND proposal PR is created
AND "Waiting for approval" is displayed

#### Scenario: Create Beads issue

GIVEN user runs `forge plan test-feature`
WHEN command executes
THEN `bd create "test-feature"` is executed
AND Beads issue ID is captured
AND research doc is linked in issue description

#### Scenario: Create feature branch

GIVEN user runs `forge plan test-feature`
WHEN command executes
THEN `git checkout -b feat/test-feature` is executed
AND branch name format is validated

---

### R5: Ship Automation

The system SHALL auto-generate PR body from research, plan, and test results.

**Rationale**: Reduce PR creation time from 10-15 minutes to 1-2 minutes with comprehensive documentation.

#### Scenario: Generate PR body from research

GIVEN research doc exists
WHEN user runs `forge ship`
THEN key decisions section is extracted
AND security analysis is extracted
AND PR template with all sections is formatted

#### Scenario: Extract key decisions

GIVEN research doc with 8 documented decisions
WHEN user runs `forge ship`
THEN top 5 decisions are included in PR body
AND Decision + Reasoning + Evidence is shown for each

#### Scenario: Calculate test coverage

GIVEN tests completed in /dev phase
WHEN user runs `forge ship`
THEN unit test count is calculated
AND integration test count is calculated
AND E2E test count is calculated
AND coverage percentages are displayed

#### Scenario: Handle missing research doc

GIVEN no research doc found
WHEN user runs `forge ship`
THEN warning is displayed
AND minimal PR body from commits is generated

---

### R6: Review Aggregation

The system SHALL aggregate review feedback from multiple sources.

**Rationale**: Consolidate Greptile + SonarCloud + GitHub Actions into single prioritized list.

#### Scenario: Aggregate all review sources

GIVEN user runs `forge review 123`
WHEN command executes
THEN GitHub Actions status is fetched
AND Greptile inline comments are fetched
AND SonarCloud issues are fetched
AND issues are categorized by severity (Critical/High/Medium)
AND prioritized list is displayed

#### Scenario: Prioritize by severity

GIVEN 24 total issues (3 critical, 8 high, 13 medium)
WHEN user runs `forge review 123`
THEN critical issues are displayed first
AND issues are grouped by source
AND direct links to issue locations are provided

#### Scenario: Deduplicate similar issues

GIVEN Greptile + SonarCloud both flag same security issue
WHEN user runs `forge review 123`
THEN duplicate is detected via file path + line number
AND issues are merged into single item
AND both sources are shown

#### Scenario: Handle API failures gracefully

GIVEN SonarCloud API returns 503
WHEN user runs `forge review 123`
THEN continue with Greptile + GitHub Actions only
AND warning about missing SonarCloud data is displayed
AND entire review process does not fail

---

## MODIFIED Requirements

### R7: Setup Wizard Integration

The system SHALL integrate CLI commands into setup wizard.

**Rationale**: Guide users to CLI commands during initial setup.

#### Scenario: Setup completion message

GIVEN user runs `bunx forge setup`
WHEN setup completes
THEN "Try: forge status" is displayed
AND available CLI commands are shown

---

### R8: Security Controls

All CLI commands SHALL implement security controls.

**Rationale**: Prevent command injection, path traversal, and secret exposure.

#### Scenario: Reject invalid slugs

GIVEN user runs `forge research "../../../etc/passwd"`
WHEN command validates input
THEN path traversal attempt is rejected
AND invalid slug format error is displayed

#### Scenario: Prevent command injection

GIVEN user runs `forge research "test; rm -rf /"`
WHEN command validates input
THEN semicolon in slug is rejected
AND invalid characters error is displayed

#### Scenario: Use safe process execution

GIVEN any forge command executes external process
WHEN process is spawned
THEN safe execution method with argument arrays is used
AND user input is passed as separate arguments (not string interpolation)

#### Scenario: Redact secrets

GIVEN command output includes API keys
WHEN output is displayed
THEN full API keys are never logged
AND only first 6 chars are shown

---

### R9: Performance Requirements

The system SHALL meet performance requirements for CLI operations.

**Rationale**: Ensure fast feedback for local operations.

#### Scenario: Fast local commands

GIVEN user runs `forge status`
WHEN command executes
THEN operation completes in less than 2 seconds
AND git status, file system, and Beads are scanned

#### Scenario: Network timeout handling

GIVEN parallel-ai network operation
WHEN operation takes longer than 60 seconds
THEN timeout occurs
AND graceful error message is displayed

#### Scenario: File scan limits

GIVEN stage detection scans project files
WHEN scan executes
THEN maximum 1000 files are scanned
AND scan completes within timeout
