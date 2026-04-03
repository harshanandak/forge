const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');

describe('detectProjectStatus() feature gate', () => {
  const forgePath = path.join(__dirname, '..', 'bin', 'forge.js');
  const content = fs.readFileSync(forgePath, 'utf-8');

  // Extract just the detectProjectStatus function body for targeted assertions
  const fnStart = content.indexOf('async function detectProjectStatus()');
  const fnBody = content.substring(fnStart, fnStart + 2000);

  test('status object does not include hasDocsWorkflow property', () => {
    // The status object should NOT check for docs/WORKFLOW.md
    // because removing WORKFLOW.md should not make a project appear as partial setup
    expect(fnBody).not.toContain('hasDocsWorkflow');
  });

  test('fully set up condition only requires hasAgentsMd and hasClaudeCommands', () => {
    // The upgrade detection should check ONLY hasAgentsMd && hasClaudeCommands
    // without requiring hasDocsWorkflow
    const upgradeCondition = fnBody.match(/if\s*\(status\.hasAgentsMd\s*&&\s*status\.hasClaudeCommands\b[^)]*\)/);
    expect(upgradeCondition).not.toBeNull();
    // The matched condition should NOT contain hasDocsWorkflow
    expect(upgradeCondition[0]).not.toContain('hasDocsWorkflow');
  });

  test('no references to hasDocsWorkflow anywhere in the file', () => {
    // hasDocsWorkflow should be completely removed from the codebase
    // including display lines that conditionally print docs/WORKFLOW.md
    expect(content).not.toContain('hasDocsWorkflow');
  });

  test('project with AGENTS.md and .claude/commands but no WORKFLOW.md is detected as upgrade', () => {
    // The condition for 'upgrade' type should be:
    //   status.hasAgentsMd && status.hasClaudeCommands
    // This means a project with both files (regardless of WORKFLOW.md) is fully set up
    const conditionLine = fnBody.split('\n').find(
      (line) => line.includes("status.type = 'upgrade'")
    );
    expect(conditionLine).toBeDefined();

    // The preceding if-condition should only check hasAgentsMd and hasClaudeCommands
    const upgradeBlock = fnBody.substring(
      fnBody.indexOf("if (status.hasAgentsMd"),
      fnBody.indexOf("status.type = 'upgrade'") + 30
    );
    expect(upgradeBlock).not.toContain('hasDocsWorkflow');
  });
});
