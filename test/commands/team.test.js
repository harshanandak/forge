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

  test('team command is discoverable via registry', () => {
    const { loadCommands } = require('../../lib/commands/_registry');
    const commandsDir = path.join(__dirname, '..', '..', 'lib', 'commands');
    const { commands } = loadCommands(commandsDir);
    expect(commands.has('team')).toBe(true);
    expect(typeof commands.get('team').handler).toBe('function');
  });
});
