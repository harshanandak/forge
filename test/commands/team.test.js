const { describe, test, expect } = require('bun:test');
const path = require('path');
const fs = require('fs');

describe('forge team command', () => {
  test('lib/commands/team.js exists', () => {
    expect(fs.existsSync(path.join(__dirname, '..', '..', 'lib', 'commands', 'team.js'))).toBe(true);
  });

  test('handleTeam is exported', () => {
    const { handleTeam } = require('../../lib/commands/team.js');
    expect(typeof handleTeam).toBe('function');
  });

  test('bin/forge.js contains team command routing', () => {
    const forgeJs = fs.readFileSync(path.join(__dirname, '..', '..', 'bin', 'forge.js'), 'utf8');
    expect(forgeJs).toContain("'team'");
    expect(forgeJs).toContain('handleTeam');
  });
});
