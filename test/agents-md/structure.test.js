/**
 * AGENTS.MD Structure Validation Tests
 *
 * RED phase: These tests validate the optimized AGENTS.MD structure
 * as defined in GitHub issues #3 & #4 implementation plan.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const AGENTS_MD_PATH = path.join(__dirname, '..', '..', 'AGENTS.md');

console.log('\n=== AGENTS.MD Structure Validation Tests (RED Phase) ===\n');

// Read AGENTS.MD file
let agentsContent = '';
if (fs.existsSync(AGENTS_MD_PATH)) {
  agentsContent = fs.readFileSync(AGENTS_MD_PATH, 'utf-8');
}

// Test: File Existence
console.log('Test: AGENTS.MD file exists in project root');
try {
  assert.ok(fs.existsSync(AGENTS_MD_PATH), 'AGENTS.MD should exist');
  console.log('  ✓ PASSED\n');
} catch (e) {
  console.log('  ✗ FAILED:', e.message, '\n');
}

// Test: 9-stage workflow table
console.log('Test: Contains 9-stage workflow table');
try {
  assert.ok(agentsContent.includes('9-Stage TDD-First Workflow'), 'Should have 9-Stage heading');
  assert.ok(agentsContent.includes('| Stage | Command'), 'Should have table header');
  assert.ok(agentsContent.includes('`/status`'), 'Should mention /status');
  assert.ok(agentsContent.includes('`/research`'), 'Should mention /research');
  assert.ok(agentsContent.includes('`/plan`'), 'Should mention /plan');
  assert.ok(agentsContent.includes('`/dev`'), 'Should mention /dev');
  assert.ok(agentsContent.includes('`/check`'), 'Should mention /check');
  assert.ok(agentsContent.includes('`/ship`'), 'Should mention /ship');
  assert.ok(agentsContent.includes('`/review`'), 'Should mention /review');
  assert.ok(agentsContent.includes('`/merge`'), 'Should mention /merge');
  assert.ok(agentsContent.includes('`/verify`'), 'Should mention /verify');
  console.log('  ✓ PASSED\n');
} catch (e) {
  console.log('  ✗ FAILED:', e.message, '\n');
}

// Test: Automatic change classification
console.log('Test: Contains automatic change classification section');
try {
  assert.ok(agentsContent.includes('Automatic Change Classification'), 'Should have classification section');
  console.log('  ✓ PASSED\n');
} catch (e) {
  console.log('  ✗ FAILED:', e.message, '\n');
}

// Test: All 6 change types
console.log('Test: Contains all 6 change types');
try {
  assert.ok(agentsContent.includes('### Critical'), 'Should have Critical type');
  assert.ok(agentsContent.includes('### Standard'), 'Should have Standard type');
  assert.ok(agentsContent.includes('### Simple'), 'Should have Simple type');
  assert.ok(agentsContent.includes('### Hotfix'), 'Should have Hotfix type');
  assert.ok(agentsContent.includes('### Docs'), 'Should have Docs type');
  assert.ok(agentsContent.includes('### Refactor'), 'Should have Refactor type');
  console.log('  ✓ PASSED\n');
} catch (e) {
  console.log('  ✗ FAILED:', e.message, '\n');
}

// Test: Each change type has workflow
console.log('Test: Each change type has workflow specification');
try {
  assert.ok(/Critical[\s\S]*?\*\*Workflow:\*\*/.test(agentsContent), 'Critical should have workflow');
  assert.ok(/Standard[\s\S]*?\*\*Workflow:\*\*/.test(agentsContent), 'Standard should have workflow');
  assert.ok(/Simple[\s\S]*?\*\*Workflow:\*\*/.test(agentsContent), 'Simple should have workflow');
  assert.ok(/Hotfix[\s\S]*?\*\*Workflow:\*\*/.test(agentsContent), 'Hotfix should have workflow');
  assert.ok(/Docs[\s\S]*?\*\*Workflow:\*\*/.test(agentsContent), 'Docs should have workflow');
  assert.ok(/Refactor[\s\S]*?\*\*Workflow:\*\*/.test(agentsContent), 'Refactor should have workflow');
  console.log('  ✓ PASSED\n');
} catch (e) {
  console.log('  ✗ FAILED:', e.message, '\n');
}

// Test: Enforcement philosophy
console.log('Test: Contains enforcement philosophy section');
try {
  assert.ok(agentsContent.includes('Enforcement Philosophy'), 'Should have enforcement section');
  assert.ok(agentsContent.includes('Conversational, not blocking'), 'Should describe conversational approach');
  assert.ok(/❌.*Don't/.test(agentsContent), 'Should have "Don\'t" examples');
  assert.ok(/✅.*Do/.test(agentsContent), 'Should have "Do" examples');
  console.log('  ✓ PASSED\n');
} catch (e) {
  console.log('  ✗ FAILED:', e.message, '\n');
}

// Test: TDD Development section
console.log('Test: Contains TDD Development orchestration section');
try {
  assert.ok(agentsContent.includes('TDD Development'), 'Should have TDD section');
  assert.ok(agentsContent.includes('RED'), 'Should mention RED phase');
  assert.ok(agentsContent.includes('GREEN'), 'Should mention GREEN phase');
  assert.ok(agentsContent.includes('REFACTOR'), 'Should mention REFACTOR phase');
  assert.ok(agentsContent.includes('parallel'), 'Should mention parallel execution');
  assert.ok(/Task.*agent/i.test(agentsContent), 'Should mention Task agents');
  assert.ok(/Example.*execution/i.test(agentsContent), 'Should have example execution');
  assert.ok(/Track.*:/.test(agentsContent), 'Should show track examples');
  console.log('  ✓ PASSED\n');
} catch (e) {
  console.log('  ✗ FAILED:', e.message, '\n');
}

// Test: State Management section
console.log('Test: Contains state management section with Beads metadata');
try {
  assert.ok(agentsContent.includes('State Management'), 'Should have state management section');
  assert.ok(agentsContent.includes('Beads metadata'), 'Should mention Beads metadata');
  assert.ok(/Single Source of Truth/i.test(agentsContent), 'Should mention single source of truth');
  assert.ok(agentsContent.includes('```json'), 'Should have JSON example');
  assert.ok(/currentStage.*:/.test(agentsContent), 'Should have currentStage field');
  assert.ok(/completedStages.*:/.test(agentsContent), 'Should have completedStages field');
  assert.ok(/parallelTracks.*:/.test(agentsContent), 'Should have parallelTracks field');
  console.log('  ✓ PASSED\n');
} catch (e) {
  console.log('  ✗ FAILED:', e.message, '\n');
}

// Test: Git Hooks section
console.log('Test: Contains git hooks section');
try {
  assert.ok(agentsContent.includes('Git Hooks'), 'Should have git hooks section');
  assert.ok(/Pre-commit.*hook/.test(agentsContent), 'Should mention pre-commit hook');
  assert.ok(agentsContent.includes('TDD'), 'Should mention TDD enforcement');
  assert.ok(/Pre-push.*hook/.test(agentsContent), 'Should mention pre-push hook');
  assert.ok(agentsContent.includes('tests must pass'), 'Should mention test requirement');
  console.log('  ✓ PASSED\n');
} catch (e) {
  console.log('  ✗ FAILED:', e.message, '\n');
}

// Test: Documentation Index
console.log('Test: Contains documentation index with context pointers');
try {
  assert.ok(agentsContent.includes('Documentation Index'), 'Should have documentation index');
  assert.ok(agentsContent.includes('.claude/commands/status.md'), 'Should link to status.md');
  assert.ok(agentsContent.includes('.claude/commands/research.md'), 'Should link to research.md');
  assert.ok(agentsContent.includes('.claude/commands/plan.md'), 'Should link to plan.md');
  assert.ok(agentsContent.includes('.claude/commands/dev.md'), 'Should link to dev.md');
  assert.ok(agentsContent.includes('.claude/commands/check.md'), 'Should link to check.md');
  assert.ok(agentsContent.includes('.claude/commands/ship.md'), 'Should link to ship.md');
  assert.ok(agentsContent.includes('.claude/commands/review.md'), 'Should link to review.md');
  assert.ok(agentsContent.includes('.claude/commands/merge.md'), 'Should link to merge.md');
  assert.ok(agentsContent.includes('.claude/commands/verify.md'), 'Should link to verify.md');
  assert.ok(agentsContent.includes('docs/WORKFLOW.md'), 'Should link to WORKFLOW.md');
  assert.ok(agentsContent.includes('docs/TOOLCHAIN.md'), 'Should link to TOOLCHAIN.md');
  console.log('  ✓ PASSED\n');
} catch (e) {
  console.log('  ✗ FAILED:', e.message, '\n');
}

// Test: File size constraints
console.log('Test: AGENTS.MD is 200 lines or less');
try {
  const lineCount = agentsContent.split('\n').length;
  assert.ok(lineCount <= 200, `Should be ≤200 lines (actual: ${lineCount})`);
  console.log(`  ✓ PASSED (${lineCount} lines)\n`);
} catch (e) {
  console.log('  ✗ FAILED:', e.message, '\n');
}

console.log('Test: AGENTS.MD is approximately 180 lines (target)');
try {
  const lineCount = agentsContent.split('\n').length;
  assert.ok(lineCount >= 160 && lineCount <= 200, `Should be 160-200 lines (actual: ${lineCount})`);
  console.log(`  ✓ PASSED (${lineCount} lines)\n`);
} catch (e) {
  console.log('  ✗ FAILED:', e.message, '\n');
}

// Test: Content quality
console.log('Test: Has proper markdown formatting');
try {
  assert.ok(/^#\s+/m.test(agentsContent), 'Should have H1 headers');
  assert.ok(/^##\s+/m.test(agentsContent), 'Should have H2 headers');
  assert.ok(/^###\s+/m.test(agentsContent), 'Should have H3 headers');
  console.log('  ✓ PASSED\n');
} catch (e) {
  console.log('  ✗ FAILED:', e.message, '\n');
}

console.log('Test: No duplicate section headers');
try {
  const headers = agentsContent.match(/^##\s+.+$/gm) || [];
  const uniqueHeaders = new Set(headers);
  assert.strictEqual(headers.length, uniqueHeaders.size, 'Should have no duplicate headers');
  console.log('  ✓ PASSED\n');
} catch (e) {
  console.log('  ✗ FAILED:', e.message, '\n');
}

console.log('=== End of Tests ===\n');
