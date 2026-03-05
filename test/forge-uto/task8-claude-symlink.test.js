import { describe, test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../');

const src = fs.readFileSync(path.join(root, 'bin/forge.js'), 'utf8');
const claudePlugin = JSON.parse(fs.readFileSync(path.join(root, 'lib/agents/claude.plugin.json'), 'utf8'));

describe('Task 8: CLAUDE.md symlink via createAgentLinkFile', () => {
  test('createSymlinkOrCopy exists and handles CLAUDE.md', () => {
    expect(src).toContain('function createSymlinkOrCopy(');
    expect(src).toContain("symlinkSync(relPath, fullTarget)");
  });

  test('createAgentLinkFile calls createSymlinkOrCopy with AGENTS.md', () => {
    expect(src).toContain("createSymlinkOrCopy('AGENTS.md', agent.linkFile)");
  });

  test('claude plugin rootConfig is CLAUDE.md', () => {
    expect(claudePlugin.files.rootConfig).toBe('CLAUDE.md');
  });

  test('createSymlinkOrCopy falls back to copy on symlink failure', () => {
    expect(src).toContain('fs.copyFileSync(fullSource, fullTarget)');
  });

  test('no redundant createClaudeSymlink function', () => {
    expect(src).not.toContain('function createClaudeSymlink(');
  });
});
