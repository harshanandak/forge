const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { describe, test, beforeEach, afterEach, expect } = require('bun:test');

const {
  detectActiveAgent,
  detectConfiguredAgents,
  detectEnvironment,
} = require('../lib/detect-agent');

describe('detect-agent', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-detect-agent-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe('detectActiveAgent', () => {
    describe('Layer 1: AI_AGENT env var', () => {
      test('AI_AGENT=my-custom-agent returns high confidence', () => {
        const result = detectActiveAgent({ AI_AGENT: 'my-custom-agent' });
        expect(result).toEqual({
          name: 'my-custom-agent',
          source: 'env',
          confidence: 'high',
        });
      });

      test('AI_AGENT takes priority over agent-specific env vars', () => {
        const result = detectActiveAgent({
          AI_AGENT: 'my-custom-agent',
          CLAUDE_CODE: '1',
        });
        expect(result.name).toBe('my-custom-agent');
      });
    });

    describe('Layer 2: Agent-specific env vars', () => {
      test('CLAUDE_CODE=1 detects claude with high confidence', () => {
        const result = detectActiveAgent({ CLAUDE_CODE: '1' });
        expect(result).toEqual({
          name: 'claude',
          source: 'env',
          confidence: 'high',
        });
      });

      test('CLAUDECODE=1 detects claude with high confidence', () => {
        const result = detectActiveAgent({ CLAUDECODE: '1' });
        expect(result).toEqual({
          name: 'claude',
          source: 'env',
          confidence: 'high',
        });
      });

      test('CLAUDE_CODE_IS_COWORK=1 detects cowork with high confidence', () => {
        const result = detectActiveAgent({
          CLAUDE_CODE: '1',
          CLAUDE_CODE_IS_COWORK: '1',
        });
        expect(result).toEqual({
          name: 'cowork',
          source: 'env',
          confidence: 'high',
        });
      });

      test('CURSOR_TRACE_ID=xxx detects cursor with high confidence', () => {
        const result = detectActiveAgent({ CURSOR_TRACE_ID: 'xxx' });
        expect(result).toEqual({
          name: 'cursor',
          source: 'env',
          confidence: 'high',
        });
      });

      test('CURSOR_AGENT detects cursor', () => {
        const result = detectActiveAgent({ CURSOR_AGENT: '1' });
        expect(result).toEqual({
          name: 'cursor',
          source: 'env',
          confidence: 'high',
        });
      });

      test('GEMINI_CLI detects gemini', () => {
        const result = detectActiveAgent({ GEMINI_CLI: '1' });
        expect(result).toEqual({
          name: 'gemini',
          source: 'env',
          confidence: 'high',
        });
      });

      test('CODEX_SANDBOX detects codex', () => {
        const result = detectActiveAgent({ CODEX_SANDBOX: '1' });
        expect(result).toEqual({
          name: 'codex',
          source: 'env',
          confidence: 'high',
        });
      });

      test('CODEX_CI detects codex', () => {
        const result = detectActiveAgent({ CODEX_CI: '1' });
        expect(result).toEqual({
          name: 'codex',
          source: 'env',
          confidence: 'high',
        });
      });

      test('CODEX_THREAD_ID detects codex', () => {
        const result = detectActiveAgent({ CODEX_THREAD_ID: 'abc123' });
        expect(result).toEqual({
          name: 'codex',
          source: 'env',
          confidence: 'high',
        });
      });

      test('ANTIGRAVITY_AGENT detects antigravity', () => {
        const result = detectActiveAgent({ ANTIGRAVITY_AGENT: '1' });
        expect(result).toEqual({
          name: 'antigravity',
          source: 'env',
          confidence: 'high',
        });
      });

      test('AUGMENT_AGENT detects augment', () => {
        const result = detectActiveAgent({ AUGMENT_AGENT: '1' });
        expect(result).toEqual({
          name: 'augment',
          source: 'env',
          confidence: 'high',
        });
      });

      test('OPENCODE_CLIENT detects opencode', () => {
        const result = detectActiveAgent({ OPENCODE_CLIENT: '1' });
        expect(result).toEqual({
          name: 'opencode',
          source: 'env',
          confidence: 'high',
        });
      });

      test('COPILOT_MODEL detects github-copilot', () => {
        const result = detectActiveAgent({ COPILOT_MODEL: 'gpt-4' });
        expect(result).toEqual({
          name: 'github-copilot',
          source: 'env',
          confidence: 'high',
        });
      });

      test('COPILOT_ALLOW_ALL detects github-copilot', () => {
        const result = detectActiveAgent({ COPILOT_ALLOW_ALL: '1' });
        expect(result).toEqual({
          name: 'github-copilot',
          source: 'env',
          confidence: 'high',
        });
      });

      test('COPILOT_GITHUB_TOKEN detects github-copilot', () => {
        const result = detectActiveAgent({ COPILOT_GITHUB_TOKEN: 'tok' });
        expect(result).toEqual({
          name: 'github-copilot',
          source: 'env',
          confidence: 'high',
        });
      });

      test('REPL_ID detects replit', () => {
        const result = detectActiveAgent({ REPL_ID: 'abc' });
        expect(result).toEqual({
          name: 'replit',
          source: 'env',
          confidence: 'high',
        });
      });
    });

    describe('Layer 3: VSCode path parsing', () => {
      test('VSCODE_CODE_CACHE_PATH containing Cursor detects cursor', () => {
        const result = detectActiveAgent({
          VSCODE_CODE_CACHE_PATH: '/home/user/.config/Cursor/CachedData',
        });
        expect(result).toEqual({
          name: 'cursor',
          source: 'path',
          confidence: 'medium',
        });
      });

      test('VSCODE_NLS_CONFIG containing windsurf detects windsurf', () => {
        const result = detectActiveAgent({
          VSCODE_NLS_CONFIG: '{"locale":"en","osLocale":"en","appRoot":"/opt/Windsurf/resources/app"}',
        });
        expect(result).toEqual({
          name: 'windsurf',
          source: 'path',
          confidence: 'medium',
        });
      });

      test('VSCODE_CODE_CACHE_PATH with generic Code does NOT detect a specific agent', () => {
        const result = detectActiveAgent({
          VSCODE_CODE_CACHE_PATH: '/home/user/.config/Code/CachedData',
        });
        // Should return null — vscode is not a specific agent
        expect(result).toBeNull();
      });

      test('VSCODE_NLS_CONFIG with generic code path returns null', () => {
        const result = detectActiveAgent({
          VSCODE_NLS_CONFIG: '{"locale":"en","appRoot":"/usr/share/code/resources/app"}',
        });
        expect(result).toBeNull();
      });

      test('case-insensitive path matching for cursor', () => {
        const result = detectActiveAgent({
          VSCODE_CODE_CACHE_PATH: 'C:\\Users\\user\\AppData\\Local\\cursor\\CachedData',
        });
        expect(result).toEqual({
          name: 'cursor',
          source: 'path',
          confidence: 'medium',
        });
      });
    });

    describe('No signals', () => {
      test('empty env returns null', () => {
        const result = detectActiveAgent({});
        expect(result).toBeNull();
      });

      test('unrelated env vars return null', () => {
        const result = detectActiveAgent({ HOME: '/home/user', PATH: '/usr/bin' });
        expect(result).toBeNull();
      });
    });

    describe('Layer priority', () => {
      test('Layer 2 env vars take priority over Layer 3 paths', () => {
        const result = detectActiveAgent({
          GEMINI_CLI: '1',
          VSCODE_CODE_CACHE_PATH: '/home/user/.config/Cursor/CachedData',
        });
        expect(result.name).toBe('gemini');
        expect(result.confidence).toBe('high');
      });
    });
  });

  describe('detectConfiguredAgents', () => {
    test('.cursorrules file detects cursor', async () => {
      await fs.promises.writeFile(path.join(tempDir, '.cursorrules'), '');
      const agents = detectConfiguredAgents(tempDir);
      expect(agents).toContain('cursor');
    });

    test('.cursor/rules directory detects cursor', async () => {
      await fs.promises.mkdir(path.join(tempDir, '.cursor', 'rules'), { recursive: true });
      const agents = detectConfiguredAgents(tempDir);
      expect(agents).toContain('cursor');
    });

    test('.claude/settings.json detects claude', async () => {
      await fs.promises.mkdir(path.join(tempDir, '.claude'), { recursive: true });
      await fs.promises.writeFile(path.join(tempDir, '.claude', 'settings.json'), '{}');
      const agents = detectConfiguredAgents(tempDir);
      expect(agents).toContain('claude');
    });

    test('.windsurfrules detects windsurf', async () => {
      await fs.promises.writeFile(path.join(tempDir, '.windsurfrules'), '');
      const agents = detectConfiguredAgents(tempDir);
      expect(agents).toContain('windsurf');
    });

    test('.windsurf/rules detects windsurf', async () => {
      await fs.promises.mkdir(path.join(tempDir, '.windsurf', 'rules'), { recursive: true });
      const agents = detectConfiguredAgents(tempDir);
      expect(agents).toContain('windsurf');
    });

    test('.clinerules detects cline', async () => {
      await fs.promises.writeFile(path.join(tempDir, '.clinerules'), '');
      const agents = detectConfiguredAgents(tempDir);
      expect(agents).toContain('cline');
    });

    test('.cline directory detects cline', async () => {
      await fs.promises.mkdir(path.join(tempDir, '.cline'), { recursive: true });
      const agents = detectConfiguredAgents(tempDir);
      expect(agents).toContain('cline');
    });

    test('.roo/rules detects roo-code', async () => {
      await fs.promises.mkdir(path.join(tempDir, '.roo', 'rules'), { recursive: true });
      const agents = detectConfiguredAgents(tempDir);
      expect(agents).toContain('roo-code');
    });

    test('.roo directory detects roo-code', async () => {
      await fs.promises.mkdir(path.join(tempDir, '.roo'), { recursive: true });
      const agents = detectConfiguredAgents(tempDir);
      expect(agents).toContain('roo-code');
    });

    test('.kilocode detects kilocode', async () => {
      await fs.promises.writeFile(path.join(tempDir, '.kilocode'), '');
      const agents = detectConfiguredAgents(tempDir);
      expect(agents).toContain('kilocode');
    });

    test('.github/copilot-instructions.md detects github-copilot', async () => {
      await fs.promises.mkdir(path.join(tempDir, '.github'), { recursive: true });
      await fs.promises.writeFile(
        path.join(tempDir, '.github', 'copilot-instructions.md'),
        '# Copilot'
      );
      const agents = detectConfiguredAgents(tempDir);
      expect(agents).toContain('github-copilot');
    });

    test('codex.md detects codex', async () => {
      await fs.promises.writeFile(path.join(tempDir, 'codex.md'), '');
      const agents = detectConfiguredAgents(tempDir);
      expect(agents).toContain('codex');
    });

    test('.codex directory detects codex', async () => {
      await fs.promises.mkdir(path.join(tempDir, '.codex'), { recursive: true });
      const agents = detectConfiguredAgents(tempDir);
      expect(agents).toContain('codex');
    });

    test('GEMINI.md detects gemini', async () => {
      await fs.promises.writeFile(path.join(tempDir, 'GEMINI.md'), '');
      const agents = detectConfiguredAgents(tempDir);
      expect(agents).toContain('gemini');
    });

    test('.gemini directory detects gemini', async () => {
      await fs.promises.mkdir(path.join(tempDir, '.gemini'), { recursive: true });
      const agents = detectConfiguredAgents(tempDir);
      expect(agents).toContain('gemini');
    });

    test('.continue/config.json detects continue', async () => {
      await fs.promises.mkdir(path.join(tempDir, '.continue'), { recursive: true });
      await fs.promises.writeFile(
        path.join(tempDir, '.continue', 'config.json'),
        '{}'
      );
      const agents = detectConfiguredAgents(tempDir);
      expect(agents).toContain('continue');
    });

    test('.aider.conf.yml detects aider', async () => {
      await fs.promises.writeFile(path.join(tempDir, '.aider.conf.yml'), '');
      const agents = detectConfiguredAgents(tempDir);
      expect(agents).toContain('aider');
    });

    test('.amazonq detects amazon-q', async () => {
      await fs.promises.mkdir(path.join(tempDir, '.amazonq'), { recursive: true });
      const agents = detectConfiguredAgents(tempDir);
      expect(agents).toContain('amazon-q');
    });

    test('empty directory returns empty array', () => {
      const agents = detectConfiguredAgents(tempDir);
      expect(agents).toEqual([]);
    });

    test('multiple config files returns all detected agents', async () => {
      await fs.promises.mkdir(path.join(tempDir, '.claude'), { recursive: true });
      await fs.promises.writeFile(path.join(tempDir, '.claude', 'settings.json'), '{}');
      await fs.promises.writeFile(path.join(tempDir, '.cursorrules'), '');
      await fs.promises.writeFile(path.join(tempDir, 'GEMINI.md'), '');
      await fs.promises.writeFile(path.join(tempDir, '.aider.conf.yml'), '');

      const agents = detectConfiguredAgents(tempDir);
      expect(agents).toContain('claude');
      expect(agents).toContain('cursor');
      expect(agents).toContain('gemini');
      expect(agents).toContain('aider');
      expect(agents.length).toBe(4);
    });

    test('does not return duplicate agent names', async () => {
      // Both .cursorrules AND .cursor/rules exist
      await fs.promises.writeFile(path.join(tempDir, '.cursorrules'), '');
      await fs.promises.mkdir(path.join(tempDir, '.cursor', 'rules'), { recursive: true });

      const agents = detectConfiguredAgents(tempDir);
      const cursorCount = agents.filter((a) => a === 'cursor').length;
      expect(cursorCount).toBe(1);
    });

    test('nonexistent directory returns empty array', () => {
      const agents = detectConfiguredAgents('/nonexistent/path/12345');
      expect(agents).toEqual([]);
    });
  });

  describe('detectEnvironment', () => {
    test('combines active agent and configured agents', async () => {
      await fs.promises.writeFile(path.join(tempDir, '.cursorrules'), '');

      const result = detectEnvironment(tempDir, { CLAUDE_CODE: '1' });
      expect(result.activeAgent).toBe('claude');
      expect(result.activeAgentSource).toBe('env');
      expect(result.confidence).toBe('high');
      expect(result.configuredAgents).toContain('cursor');
    });

    test('no signals returns null activeAgent and empty configuredAgents', () => {
      const result = detectEnvironment(tempDir, {});
      expect(result.activeAgent).toBeNull();
      expect(result.activeAgentSource).toBeNull();
      expect(result.confidence).toBeNull();
      expect(result.configuredAgents).toEqual([]);
      expect(result.editor).toBeNull();
    });

    test('VSCode path sets editor field', () => {
      const result = detectEnvironment(tempDir, {
        VSCODE_CODE_CACHE_PATH: '/home/user/.config/Code/CachedData',
      });
      expect(result.editor).toBe('vscode');
      expect(result.activeAgent).toBeNull();
    });

    test('Cursor path sets both agent and editor', () => {
      const result = detectEnvironment(tempDir, {
        VSCODE_CODE_CACHE_PATH: '/home/user/.config/Cursor/CachedData',
      });
      expect(result.activeAgent).toBe('cursor');
      expect(result.editor).toBe('cursor');
    });

    test('Windsurf path sets both agent and editor', () => {
      const result = detectEnvironment(tempDir, {
        VSCODE_NLS_CONFIG: '{"appRoot":"/opt/Windsurf/resources/app"}',
      });
      expect(result.activeAgent).toBe('windsurf');
      expect(result.editor).toBe('windsurf');
    });
  });
});
