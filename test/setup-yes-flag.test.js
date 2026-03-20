const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');

describe('--yes / -y flag for non-interactive setup', () => {
  const forgePath = path.join(__dirname, '..', 'bin', 'forge.js');
  const content = fs.readFileSync(forgePath, 'utf-8');

  test('parseFlags recognizes --yes flag', () => {
    // The parseFlags function should handle '--yes'
    expect(content).toContain("arg === '--yes'");
  });

  test('parseFlags recognizes -y short flag', () => {
    // The parseFlags function should handle '-y'
    expect(content).toContain("arg === '-y'");
  });

  test('flags object includes yes property defaulting to false', () => {
    // The flags initialization should include yes: false
    expect(content).toContain('yes: false');
  });

  test('--yes sets flags.yes to true in parseFlags', () => {
    // When --yes is parsed, it should set flags.yes = true
    expect(content).toContain('flags.yes = true');
  });

  test('main() uses --yes to default agents to claude and skip interactive', () => {
    // When --yes is active and no --agents specified, default to claude
    expect(content).toContain("flags.yes");
    // Should have logic that defaults to ['claude'] when yes is set
    expect(content).toMatch(/flags\.yes[\s\S]*?claude/);
  });

  test('explicit --agents flag overrides --yes default agent', () => {
    // The determineSelectedAgents or main logic should check flags.agents
    // before falling back to --yes default — this is ensured by the order:
    // flags.agents is checked first in determineSelectedAgents, then --yes
    // kicks in only when selectedAgents is empty
    const mainSection = content.substring(content.indexOf('async function main()'));
    // --yes logic should appear AFTER determineSelectedAgents call
    const determineCall = mainSection.indexOf('determineSelectedAgents');
    const yesCheck = mainSection.indexOf('flags.yes');
    expect(determineCall).toBeGreaterThan(-1);
    expect(yesCheck).toBeGreaterThan(-1);
    expect(yesCheck).toBeGreaterThan(determineCall);
  });

  test('--yes skips interactive setup (does not call interactiveSetupWithFlags)', () => {
    // When --yes is active, the code should NOT fall through to interactiveSetupWithFlags
    // It should route to handleSetupCommand instead
    const mainSection = content.substring(content.indexOf('async function main()'));
    // There should be a flags.yes check before the interactiveSetupWithFlags call
    const interactiveCall = mainSection.indexOf('interactiveSetupWithFlags');
    const yesCheck = mainSection.indexOf('flags.yes');
    expect(yesCheck).toBeGreaterThan(-1);
    expect(yesCheck).toBeLessThan(interactiveCall);
  });
});
