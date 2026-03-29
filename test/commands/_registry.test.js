/**
 * Tests for Command Registry (Auto-Discovery)
 *
 * Uses temp directories with mock command files to avoid
 * interfering with real commands.
 */

const { describe, test, expect, beforeEach, afterEach, spyOn } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Will be implemented in lib/commands/_registry.js
const { loadCommands } = require('../../lib/commands/_registry');

describe('Command Registry', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cmd-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadCommands()', () => {
    test('discovers a valid command module and returns it in the Map', () => {
      // Create a valid mock command
      fs.writeFileSync(
        path.join(tmpDir, 'greet.js'),
        `module.exports = {
          name: 'greet',
          description: 'Say hello',
          handler: async (_args, _flags, _projectRoot) => ({ message: 'hello' }),
        };`
      );

      const { commands } = loadCommands(tmpDir);

      expect(commands).toBeInstanceOf(Map);
      expect(commands.size).toBe(1);
      expect(commands.has('greet')).toBe(true);

      const cmd = commands.get('greet');
      expect(cmd.name).toBe('greet');
      expect(cmd.description).toBe('Say hello');
      expect(typeof cmd.handler).toBe('function');
    });

    test('discovers multiple command modules', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'alpha.js'),
        `module.exports = {
          name: 'alpha',
          description: 'Alpha command',
          handler: async () => {},
        };`
      );
      fs.writeFileSync(
        path.join(tmpDir, 'beta.js'),
        `module.exports = {
          name: 'beta',
          description: 'Beta command',
          handler: async () => {},
        };`
      );

      const { commands } = loadCommands(tmpDir);

      expect(commands.size).toBe(2);
      expect(commands.has('alpha')).toBe(true);
      expect(commands.has('beta')).toBe(true);
    });

    test('skips files starting with underscore', () => {
      fs.writeFileSync(
        path.join(tmpDir, '_internal.js'),
        `module.exports = {
          name: 'internal',
          description: 'Should be skipped',
          handler: async () => {},
        };`
      );
      fs.writeFileSync(
        path.join(tmpDir, 'public.js'),
        `module.exports = {
          name: 'public',
          description: 'Public command',
          handler: async () => {},
        };`
      );

      const { commands } = loadCommands(tmpDir);

      expect(commands.size).toBe(1);
      expect(commands.has('public')).toBe(true);
      expect(commands.has('internal')).toBe(false);
    });

    test('skips non-.js files', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'readme.md'),
        '# Not a command'
      );
      fs.writeFileSync(
        path.join(tmpDir, 'valid.js'),
        `module.exports = {
          name: 'valid',
          description: 'Valid command',
          handler: async () => {},
        };`
      );

      const { commands } = loadCommands(tmpDir);

      expect(commands.size).toBe(1);
      expect(commands.has('valid')).toBe(true);
    });

    test('skips malformed module missing name with console.warn', () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

      fs.writeFileSync(
        path.join(tmpDir, 'bad.js'),
        `module.exports = {
          description: 'Missing name',
          handler: async () => {},
        };`
      );
      fs.writeFileSync(
        path.join(tmpDir, 'good.js'),
        `module.exports = {
          name: 'good',
          description: 'Good command',
          handler: async () => {},
        };`
      );

      const { commands } = loadCommands(tmpDir);

      expect(commands.size).toBe(1);
      expect(commands.has('good')).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('bad.js')
      );

      warnSpy.mockRestore();
    });

    test('skips malformed module missing description with console.warn', () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

      fs.writeFileSync(
        path.join(tmpDir, 'nodesc.js'),
        `module.exports = {
          name: 'nodesc',
          handler: async () => {},
        };`
      );

      const { commands } = loadCommands(tmpDir);

      expect(commands.size).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('nodesc.js')
      );

      warnSpy.mockRestore();
    });

    test('skips malformed module missing handler with console.warn', () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

      fs.writeFileSync(
        path.join(tmpDir, 'nohandler.js'),
        `module.exports = {
          name: 'nohandler',
          description: 'No handler',
        };`
      );

      const { commands } = loadCommands(tmpDir);

      expect(commands.size).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('nohandler.js')
      );

      warnSpy.mockRestore();
    });

    test('skips module that throws on require with console.warn', () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

      fs.writeFileSync(
        path.join(tmpDir, 'broken.js'),
        `throw new Error('syntax explosion');`
      );
      fs.writeFileSync(
        path.join(tmpDir, 'works.js'),
        `module.exports = {
          name: 'works',
          description: 'Working command',
          handler: async () => {},
        };`
      );

      const { commands } = loadCommands(tmpDir);

      expect(commands.size).toBe(1);
      expect(commands.has('works')).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('broken.js')
      );

      warnSpy.mockRestore();
    });

    test('warns and skips duplicate command names', () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

      fs.writeFileSync(
        path.join(tmpDir, 'cmd-a.js'),
        `module.exports = {
          name: 'duplicate',
          description: 'First one',
          handler: async () => 'first',
        };`
      );
      fs.writeFileSync(
        path.join(tmpDir, 'cmd-b.js'),
        `module.exports = {
          name: 'duplicate',
          description: 'Second one',
          handler: async () => 'second',
        };`
      );

      const { commands } = loadCommands(tmpDir);

      expect(commands.size).toBe(1);
      // The first one alphabetically should win
      expect(commands.has('duplicate')).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('duplicate')
      );

      warnSpy.mockRestore();
    });

    test('returns empty Map for empty directory', () => {
      const { commands } = loadCommands(tmpDir);

      expect(commands).toBeInstanceOf(Map);
      expect(commands.size).toBe(0);
    });

    test('returns empty Map for non-existent directory', () => {
      const { commands } = loadCommands(path.join(tmpDir, 'does-not-exist'));

      expect(commands).toBeInstanceOf(Map);
      expect(commands.size).toBe(0);
    });

    test('preserves optional exports (usage, flags)', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'fancy.js'),
        `module.exports = {
          name: 'fancy',
          description: 'Fancy command',
          handler: async () => {},
          usage: 'fancy [options]',
          flags: { '--verbose': 'Enable verbose output' },
        };`
      );

      const { commands } = loadCommands(tmpDir);
      const cmd = commands.get('fancy');

      expect(cmd.usage).toBe('fancy [options]');
      expect(cmd.flags).toEqual({ '--verbose': 'Enable verbose output' });
    });
  });

  describe('getHelp()', () => {
    test('returns formatted help string listing all commands', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'alpha.js'),
        `module.exports = {
          name: 'alpha',
          description: 'Alpha command',
          handler: async () => {},
        };`
      );
      fs.writeFileSync(
        path.join(tmpDir, 'beta.js'),
        `module.exports = {
          name: 'beta',
          description: 'Beta command',
          handler: async () => {},
        };`
      );

      const { getHelp } = loadCommands(tmpDir);
      const help = getHelp();

      expect(typeof help).toBe('string');
      expect(help).toContain('alpha');
      expect(help).toContain('Alpha command');
      expect(help).toContain('beta');
      expect(help).toContain('Beta command');
    });

    test('returns meaningful message when no commands found', () => {
      const { getHelp } = loadCommands(tmpDir);
      const help = getHelp();

      expect(typeof help).toBe('string');
      expect(help.length).toBeGreaterThan(0);
    });
  });
});
