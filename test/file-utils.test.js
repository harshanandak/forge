const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { describe, test, expect, beforeEach, afterEach } = require('bun:test');

describe('file-utils', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-file-utils-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------
  // Module exports
  // -------------------------------------------------------
  describe('module exports', () => {
    test('exports all expected functions', () => {
      const fileUtils = require('../lib/file-utils');
      expect(typeof fileUtils.readFile).toBe('function');
      expect(typeof fileUtils.writeFile).toBe('function');
      expect(typeof fileUtils.ensureDir).toBe('function');
      expect(typeof fileUtils.ensureDirWithNote).toBe('function');
      expect(typeof fileUtils.stripFrontmatter).toBe('function');
      expect(typeof fileUtils.readEnvFile).toBe('function');
      expect(typeof fileUtils.parseEnvFile).toBe('function');
      expect(typeof fileUtils.writeEnvTokens).toBe('function');
    });
  });

  // -------------------------------------------------------
  // readFile
  // -------------------------------------------------------
  describe('readFile', () => {
    test('reads existing file contents', () => {
      const { readFile } = require('../lib/file-utils');
      const filePath = path.join(tmpDir, 'test.txt');
      fs.writeFileSync(filePath, 'hello world');
      expect(readFile(filePath)).toBe('hello world');
    });

    test('returns null for non-existent file', () => {
      const { readFile } = require('../lib/file-utils');
      expect(readFile(path.join(tmpDir, 'nope.txt'))).toBeNull();
    });
  });

  // -------------------------------------------------------
  // writeFile
  // -------------------------------------------------------
  describe('writeFile', () => {
    test('writes content to file under projectRoot', () => {
      const { writeFile } = require('../lib/file-utils');
      const result = writeFile('sub/test.txt', 'data', tmpDir);
      expect(result).toBe(true);
      expect(fs.readFileSync(path.join(tmpDir, 'sub', 'test.txt'), 'utf8')).toBe('data');
    });

    test('creates parent directories automatically', () => {
      const { writeFile } = require('../lib/file-utils');
      writeFile('a/b/c/deep.txt', 'nested', tmpDir);
      expect(fs.existsSync(path.join(tmpDir, 'a', 'b', 'c', 'deep.txt'))).toBe(true);
    });

    test('blocks path traversal', () => {
      const { writeFile } = require('../lib/file-utils');
      const result = writeFile('../../escape.txt', 'bad', tmpDir);
      expect(result).toBe(false);
    });
  });

  // -------------------------------------------------------
  // ensureDir
  // -------------------------------------------------------
  describe('ensureDir', () => {
    test('creates directory under projectRoot', () => {
      const { ensureDir } = require('../lib/file-utils');
      const result = ensureDir('new-dir', tmpDir);
      expect(result).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'new-dir'))).toBe(true);
    });

    test('returns true if directory already exists', () => {
      const { ensureDir } = require('../lib/file-utils');
      fs.mkdirSync(path.join(tmpDir, 'existing'));
      expect(ensureDir('existing', tmpDir)).toBe(true);
    });

    test('blocks path traversal', () => {
      const { ensureDir } = require('../lib/file-utils');
      const result = ensureDir('../../escape', tmpDir);
      expect(result).toBe(false);
    });
  });

  // -------------------------------------------------------
  // ensureDirWithNote
  // -------------------------------------------------------
  describe('ensureDirWithNote', () => {
    test('creates directory and returns purpose message', () => {
      const { ensureDirWithNote } = require('../lib/file-utils');
      const targetDir = path.join(tmpDir, 'docs', 'planning');
      const result = ensureDirWithNote(targetDir, 'design documents');
      expect(fs.existsSync(targetDir)).toBe(true);
      expect(result).toContain('docs/planning');
      expect(result).toContain('for design documents');
    });

    test('returns null when directory already exists', () => {
      const { ensureDirWithNote } = require('../lib/file-utils');
      const targetDir = path.join(tmpDir, 'docs', 'research');
      fs.mkdirSync(targetDir, { recursive: true });
      expect(ensureDirWithNote(targetDir, 'research')).toBeNull();
    });
  });

  // -------------------------------------------------------
  // stripFrontmatter
  // -------------------------------------------------------
  describe('stripFrontmatter', () => {
    test('strips YAML frontmatter from markdown', () => {
      const { stripFrontmatter } = require('../lib/file-utils');
      const input = '---\ntitle: Test\n---\n# Hello';
      expect(stripFrontmatter(input)).toBe('# Hello');
    });

    test('returns content unchanged if no frontmatter', () => {
      const { stripFrontmatter } = require('../lib/file-utils');
      expect(stripFrontmatter('# Hello')).toBe('# Hello');
    });

    test('handles CRLF line endings', () => {
      const { stripFrontmatter } = require('../lib/file-utils');
      const input = '---\r\ntitle: Test\r\n---\r\n# Hello';
      expect(stripFrontmatter(input)).toBe('# Hello');
    });
  });

  // -------------------------------------------------------
  // readEnvFile / parseEnvFile / writeEnvTokens
  // -------------------------------------------------------
  describe('env file operations', () => {
    test('readEnvFile returns empty string when no .env.local', () => {
      const { readEnvFile } = require('../lib/file-utils');
      expect(readEnvFile(tmpDir)).toBe('');
    });

    test('readEnvFile reads existing .env.local', () => {
      const { readEnvFile } = require('../lib/file-utils');
      fs.writeFileSync(path.join(tmpDir, '.env.local'), 'FOO=bar\n');
      expect(readEnvFile(tmpDir)).toBe('FOO=bar\n');
    });

    test('parseEnvFile parses key-value pairs', () => {
      const { parseEnvFile } = require('../lib/file-utils');
      fs.writeFileSync(path.join(tmpDir, '.env.local'), 'API_KEY=val1\nSECRET=val2\n');
      const vars = parseEnvFile(tmpDir);
      expect(vars.API_KEY).toBe('val1');
      expect(vars.SECRET).toBe('val2');
    });

    test('parseEnvFile returns empty object for missing file', () => {
      const { parseEnvFile } = require('../lib/file-utils');
      const vars = parseEnvFile(tmpDir);
      expect(Object.keys(vars).length).toBe(0);
    });

    test('writeEnvTokens writes new tokens', () => {
      const { writeEnvTokens } = require('../lib/file-utils');
      const result = writeEnvTokens({ API_KEY: 'abc123' }, tmpDir, true);
      expect(result.added).toContain('API_KEY');
      const content = fs.readFileSync(path.join(tmpDir, '.env.local'), 'utf8');
      expect(content).toContain('API_KEY=abc123');
    });

    test('writeEnvTokens preserves existing values', () => {
      const { writeEnvTokens } = require('../lib/file-utils');
      fs.writeFileSync(path.join(tmpDir, '.env.local'), 'EXISTING=keep\n');
      const result = writeEnvTokens({ EXISTING: 'overwrite' }, tmpDir, true);
      expect(result.preserved).toContain('EXISTING');
      const content = fs.readFileSync(path.join(tmpDir, '.env.local'), 'utf8');
      expect(content).toContain('EXISTING=keep');
    });
  });
});
