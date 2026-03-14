const { describe, test, expect } = require('bun:test');

/**
 * Tests for scripts/sync-commands.js
 *
 * The module exports two functions:
 * - parseFrontmatter(content) -> { frontmatter: object, body: string }
 * - buildFile(frontmatter, body) -> string (reconstructed file content)
 */

const {
  parseFrontmatter,
  buildFile,
  AGENT_ADAPTERS,
  adaptForAgent,
} = require('../../scripts/sync-commands.js');

// ---- parseFrontmatter ---------------------------------------------------------

describe('parseFrontmatter', () => {
  test('extracts simple key-value frontmatter', () => {
    const input = '---\ndescription: Check current stage\n---\nSome body text';
    const result = parseFrontmatter(input);
    expect(result.frontmatter).toEqual({ description: 'Check current stage' });
    expect(result.body).toBe('Some body text');
  });

  test('handles multiple frontmatter keys', () => {
    const input = '---\ndescription: Plan a feature\nallowed_agents: claude\n---\nbody here';
    const result = parseFrontmatter(input);
    expect(result.frontmatter).toEqual({
      description: 'Plan a feature',
      allowed_agents: 'claude',
    });
    expect(result.body).toBe('body here');
  });

  test('returns empty object and full content when no frontmatter markers', () => {
    const input = 'Just a regular markdown file\nwith no frontmatter';
    const result = parseFrontmatter(input);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(input);
  });

  test('handles empty body after frontmatter', () => {
    const input = '---\ndescription: Something\n---\n';
    const result = parseFrontmatter(input);
    expect(result.frontmatter).toEqual({ description: 'Something' });
    expect(result.body).toBe('');
  });

  test('handles empty frontmatter block', () => {
    const input = '---\n---\nBody only';
    const result = parseFrontmatter(input);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe('Body only');
  });

  test('preserves body that contains --- separators (not frontmatter)', () => {
    const input = '---\ndescription: Test\n---\n\n---\n\nThis has horizontal rules';
    const result = parseFrontmatter(input);
    expect(result.frontmatter).toEqual({ description: 'Test' });
    expect(result.body).toContain('---');
    expect(result.body).toContain('This has horizontal rules');
  });

  test('strips leading newline from body (newline after closing ---)', () => {
    const input = '---\ndescription: X\n---\n\nActual body starts here';
    const result = parseFrontmatter(input);
    expect(result.body).toBe('\nActual body starts here');
  });

  test('handles multiline YAML values (quoted strings)', () => {
    const input = '---\ndescription: "A value with: colons"\n---\nbody';
    const result = parseFrontmatter(input);
    expect(result.frontmatter.description).toBe('A value with: colons');
    expect(result.body).toBe('body');
  });

  test('handles real plan.md frontmatter format', () => {
    const input = '---\ndescription: Design intent → research → branch + worktree + task list\n---\n\nPlan a feature from scratch.';
    const result = parseFrontmatter(input);
    expect(result.frontmatter.description).toBe(
      'Design intent → research → branch + worktree + task list'
    );
    expect(result.body).toContain('Plan a feature from scratch.');
  });

  test('returns empty object for content with single --- at start only', () => {
    const input = '---\nNo closing marker so this is not frontmatter';
    const result = parseFrontmatter(input);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(input);
  });

  test('handles empty string input', () => {
    const result = parseFrontmatter('');
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe('');
  });
});

// ---- buildFile ----------------------------------------------------------------

describe('buildFile', () => {
  test('produces valid frontmatter with --- delimiters', () => {
    const output = buildFile({ description: 'Hello world' }, 'Some body');
    expect(output).toBe('---\ndescription: Hello world\n---\nSome body');
  });

  test('roundtrips through parseFrontmatter', () => {
    const original = '---\ndescription: Check current stage\n---\n\nBody content here.';
    const parsed = parseFrontmatter(original);
    const rebuilt = buildFile(parsed.frontmatter, parsed.body);
    expect(rebuilt).toBe(original);
  });

  test('handles multiple frontmatter keys', () => {
    const output = buildFile(
      { description: 'Test', allowed_agents: 'claude' },
      'body'
    );
    expect(output).toContain('---\n');
    expect(output).toContain('description: Test');
    expect(output).toContain('allowed_agents: claude');
    expect(output).toEndWith('\n---\nbody');
  });

  test('handles empty frontmatter object', () => {
    const output = buildFile({}, 'Just a body');
    expect(output).toBe('---\n---\nJust a body');
  });

  test('handles empty body', () => {
    const output = buildFile({ description: 'X' }, '');
    expect(output).toBe('---\ndescription: X\n---\n');
  });

  test('quotes values that contain colons', () => {
    const output = buildFile({ description: 'A value with: colons' }, 'body');
    const reparsed = parseFrontmatter(output);
    expect(reparsed.frontmatter.description).toBe('A value with: colons');
  });

  test('rebuilds with different frontmatter while keeping body', () => {
    const original = '---\ndescription: Old description\n---\n\nOriginal body.';
    const parsed = parseFrontmatter(original);
    const rebuilt = buildFile({ description: 'New description' }, parsed.body);
    const reparsed = parseFrontmatter(rebuilt);
    expect(reparsed.frontmatter.description).toBe('New description');
    expect(reparsed.body).toBe(parsed.body);
  });
});

// ---- AGENT_ADAPTERS -------------------------------------------------------------

describe('AGENT_ADAPTERS', () => {
  test('contains all 8 agents', () => {
    const expected = [
      'claude-code',
      'cursor',
      'cline',
      'opencode',
      'github-copilot',
      'kilo-code',
      'roo-code',
      'codex',
    ];
    for (const agent of expected) {
      expect(AGENT_ADAPTERS[agent]).toBeDefined();
    }
  });

  test('each adapter has required properties', () => {
    for (const [_name, adapter] of Object.entries(AGENT_ADAPTERS)) {
      expect(typeof adapter.dir).toBe('function');
      expect(typeof adapter.extension).toBe('string');
      expect(typeof adapter.transformFrontmatter).toBe('function');
    }
  });

  test('claude-code is marked as skip (canonical)', () => {
    expect(AGENT_ADAPTERS['claude-code'].skip).toBe(true);
  });
});

// ---- adaptForAgent — Tier 1 agents -----------------------------------------------

describe('adaptForAgent — Tier 1', () => {
  const fm = { description: 'Design intent', allowed_agents: 'claude' };
  const body = '\nPlan a feature from scratch.';

  test('claude-code returns null (skipped)', () => {
    const result = adaptForAgent('claude-code', fm, body, 'plan');
    expect(result).toBeNull();
  });

  // -- Cursor --
  test('cursor strips all frontmatter', () => {
    const result = adaptForAgent('cursor', fm, body, 'plan');
    const parsed = parseFrontmatter(result.content);
    expect(Object.keys(parsed.frontmatter)).toHaveLength(0);
  });

  test('cursor outputs to .cursor/skills/<name>/ with <name>.md', () => {
    const result = adaptForAgent('cursor', fm, body, 'plan');
    expect(result.dir).toBe('.cursor/skills/plan/');
    expect(result.filename).toBe('plan.md');
  });

  test('cursor preserves body content', () => {
    const result = adaptForAgent('cursor', fm, body, 'plan');
    expect(result.content).toContain('Plan a feature from scratch.');
  });

  // -- Cline --
  test('cline strips all frontmatter', () => {
    const result = adaptForAgent('cline', fm, body, 'dev');
    const parsed = parseFrontmatter(result.content);
    expect(Object.keys(parsed.frontmatter)).toHaveLength(0);
  });

  test('cline outputs to .clinerules/workflows/', () => {
    const result = adaptForAgent('cline', fm, body, 'dev');
    expect(result.dir).toBe('.clinerules/workflows/');
    expect(result.filename).toBe('dev.md');
  });

  // -- OpenCode --
  test('opencode keeps only description', () => {
    const result = adaptForAgent('opencode', fm, body, 'plan');
    const parsed = parseFrontmatter(result.content);
    expect(parsed.frontmatter.description).toBe('Design intent');
    expect(parsed.frontmatter.allowed_agents).toBeUndefined();
  });

  test('opencode outputs to .opencode/commands/', () => {
    const result = adaptForAgent('opencode', fm, body, 'plan');
    expect(result.dir).toBe('.opencode/commands/');
    expect(result.filename).toBe('plan.md');
  });

  // -- GitHub Copilot --
  test('copilot adds name, keeps description, adds tools field', () => {
    const result = adaptForAgent('github-copilot', fm, body, 'plan');
    const parsed = parseFrontmatter(result.content);
    expect(parsed.frontmatter.name).toBe('plan');
    expect(parsed.frontmatter.description).toBe('Design intent');
    expect(parsed.frontmatter.tools).toBeDefined();
    expect(parsed.frontmatter.allowed_agents).toBeUndefined();
  });

  test('copilot uses .prompt.md extension', () => {
    const result = adaptForAgent('github-copilot', fm, body, 'plan');
    expect(result.filename).toBe('plan.prompt.md');
    expect(result.dir).toBe('.github/prompts/');
  });
});

// ---- adaptForAgent — Tier 2 agents -----------------------------------------------

describe('adaptForAgent — Tier 2', () => {
  const fm = { description: 'Run tests and lint' };
  const body = '\nValidate the code.';

  // -- Kilo Code --
  test('kilo-code keeps description and adds mode: code', () => {
    const result = adaptForAgent('kilo-code', fm, body, 'validate');
    const parsed = parseFrontmatter(result.content);
    expect(parsed.frontmatter.description).toBe('Run tests and lint');
    expect(parsed.frontmatter.mode).toBe('code');
  });

  test('kilo-code outputs to .kilocode/workflows/', () => {
    const result = adaptForAgent('kilo-code', fm, body, 'validate');
    expect(result.dir).toBe('.kilocode/workflows/');
    expect(result.filename).toBe('validate.md');
  });

  // -- Roo Code --
  test('roo-code keeps description and adds mode: code', () => {
    const result = adaptForAgent('roo-code', fm, body, 'validate');
    const parsed = parseFrontmatter(result.content);
    expect(parsed.frontmatter.description).toBe('Run tests and lint');
    expect(parsed.frontmatter.mode).toBe('code');
  });

  test('roo-code outputs to .roo/commands/', () => {
    const result = adaptForAgent('roo-code', fm, body, 'validate');
    expect(result.dir).toBe('.roo/commands/');
    expect(result.filename).toBe('validate.md');
  });

  // -- Codex --
  test('codex outputs to .codex/skills/<name>/ with SKILL.md', () => {
    const result = adaptForAgent('codex', fm, body, 'validate');
    expect(result.dir).toBe('.codex/skills/validate/');
    expect(result.filename).toBe('SKILL.md');
  });

  test('codex keeps description in frontmatter', () => {
    const result = adaptForAgent('codex', fm, body, 'validate');
    const parsed = parseFrontmatter(result.content);
    expect(parsed.frontmatter.description).toBe('Run tests and lint');
  });
});

// ---- adaptForAgent — edge cases ---------------------------------------------------

describe('adaptForAgent — edge cases', () => {
  test('throws for unknown agent name', () => {
    expect(() => adaptForAgent('unknown-agent', {}, 'body', 'plan')).toThrow();
  });

  test('handles empty frontmatter input', () => {
    const result = adaptForAgent('cursor', {}, 'body', 'plan');
    expect(result.content).toBe('body');
  });

  test('handles frontmatter with no description for copilot', () => {
    const result = adaptForAgent('github-copilot', {}, 'body', 'status');
    const parsed = parseFrontmatter(result.content);
    expect(parsed.frontmatter.name).toBe('status');
    expect(parsed.frontmatter.tools).toBeDefined();
  });

  test('opencode with no description produces empty frontmatter', () => {
    const result = adaptForAgent('opencode', { allowed_agents: 'claude' }, 'body', 'dev');
    const parsed = parseFrontmatter(result.content);
    expect(parsed.frontmatter.description).toBeUndefined();
    expect(parsed.frontmatter.allowed_agents).toBeUndefined();
  });

  test('preserves body across all non-skip agents', () => {
    const agents = ['cursor', 'cline', 'opencode', 'github-copilot', 'kilo-code', 'roo-code', 'codex'];
    const testBody = '\nSome important body content.';
    for (const agent of agents) {
      const result = adaptForAgent(agent, { description: 'X' }, testBody, 'plan');
      expect(result.content).toContain('Some important body content.');
    }
  });
});
