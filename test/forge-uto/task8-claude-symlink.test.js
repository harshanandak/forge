import { describe, test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../');

const src = fs.readFileSync(path.join(root, 'bin/forge.js'), 'utf8');
const symlinkSrc = fs.readFileSync(path.join(root, 'lib/symlink-utils.js'), 'utf8');
const claudePlugin = JSON.parse(fs.readFileSync(path.join(root, 'lib/agents/claude.plugin.json'), 'utf8'));

describe('Task 8: CLAUDE.md symlink via createAgentLinkFile', () => {
  test('createSymlinkOrCopy exists and handles CLAUDE.md', () => {
    // bin/forge.js has a wrapper that delegates to lib/symlink-utils
    expect(src).toContain('function createSymlinkOrCopy(');
    // lib/symlink-utils has the actual symlink logic
    expect(symlinkSrc).toContain("symlinkSync(relPath, linkPath)");
  });

  test('createAgentLinkFile calls createSymlinkOrCopy with AGENTS.md', () => {
    // Now passes symlinkOnly option from --symlink flag
    expect(src).toContain("createSymlinkOrCopy('AGENTS.md', agent.linkFile");
  });

  test('claude plugin rootConfig is CLAUDE.md', () => {
    expect(claudePlugin.files.rootConfig).toBe('CLAUDE.md');
  });

  test('createSymlinkOrCopy falls back to copy on symlink failure', () => {
    // Copy fallback logic moved to lib/symlink-utils.js
    expect(symlinkSrc).toContain('fs.writeFileSync(linkPath,');
  });

  test('no redundant createClaudeSymlink function', () => {
    expect(src).not.toContain('function createClaudeSymlink(');
  });

  test('directory guard uses lstatSync and warns user', () => {
    // Directory guard logic moved to lib/symlink-utils.js
    expect(symlinkSrc).toContain('fs.lstatSync(linkPath)');
    expect(symlinkSrc).toContain('stat.isDirectory()');
    expect(symlinkSrc).toContain('console.warn');
    expect(symlinkSrc).toContain('Remove it manually and re-run setup');
  });
});
