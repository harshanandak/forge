const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { afterEach, describe, expect, test } = require('bun:test');

const {
  detectHarnessTargets,
  handler,
  parseInitFlags,
  renderPatchMd,
  renderProtectedPathsYaml,
} = require('../lib/commands/init');

const tempRoots = [];

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-init-command-'));
  tempRoots.push(root);
  return root;
}

function readYaml(filePath) {
  return YAML.parse(fs.readFileSync(filePath, 'utf8'));
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('forge init command', () => {
  test('parses day-one classification, rail, and harness flags', () => {
    const parsed = parseInitFlags([
      '--profile',
      'minimal',
      '--classification',
      'critical',
      '--harness',
      'claude,codex',
      '--yes',
    ]);

    expect(parsed.profile).toBe('minimal');
    expect(parsed.classification).toBe('critical');
    expect(parsed.harnessTargets).toEqual(['claude', 'codex']);
    expect(parsed.railsConfirmed).toBe(true);
    expect(parsed.error).toBeNull();
  });

  test('rejects unknown classifications and harness targets with repair text', () => {
    expect(parseInitFlags(['--classification', 'minor']).error)
      .toContain('Choose one of: critical, standard, refactor');
    expect(parseInitFlags(['--harness', 'vscode']).error)
      .toContain('Choose from: claude, cursor, codex');
  });

  test('detects active harness targets from filesystem markers', () => {
    const root = makeProject();
    fs.mkdirSync(path.join(root, '.claude'));
    fs.mkdirSync(path.join(root, '.cursor'));
    fs.mkdirSync(path.join(root, '.codex'));
    fs.writeFileSync(path.join(root, '.cursor-file'), '');

    expect(detectHarnessTargets(root)).toEqual(['claude', 'cursor', 'codex']);
  });

  test('does not detect harness markers that are plain files', () => {
    const root = makeProject();
    fs.writeFileSync(path.join(root, '.cursor'), '');

    expect(detectHarnessTargets(root)).toEqual([]);
  });

  test('renders protected path and patch scaffolds', () => {
    const root = makeProject();
    fs.mkdirSync(path.join(root, '.cursor'));
    const protectedYaml = readYamlFromString(renderProtectedPathsYaml({
      classification: 'standard',
      harnessTargets: ['cursor'],
      projectRoot: root,
    }));

    expect(protectedYaml.kind).toBe('forge.protectedPaths');
    expect(protectedYaml.harness.targets).toEqual(['cursor']);
    expect(protectedYaml.paths.map(entry => entry.path)).toContain('.forge/config.yaml');
    expect(protectedYaml.paths.map(entry => entry.path)).toContain('.cursor/**');
    expect(protectedYaml.paths.map(entry => entry.path)).not.toContain('.codex/**');
    expect(renderPatchMd()).toContain('# Forge Patch Intent');
  });

  test('initializes clean repo with config, patch, and protected paths files', async () => {
    const root = makeProject();
    fs.mkdirSync(path.join(root, '.codex'));

    const result = await handler(['--yes'], {}, root);

    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(root, '.forge', 'config.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.forge', 'patch.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.forge', 'protected-paths.yaml'))).toBe(true);

    const config = readYaml(path.join(root, '.forge', 'config.yaml'));
    expect(config.workflow.classification.default).toBe('standard');
    expect(config.layer1Rails.confirmed).toBe(true);
    expect(config.adapters.harness.targets).toEqual(['codex']);
  });

  test('does not clobber existing generated files without force', async () => {
    const root = makeProject();
    fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
    fs.writeFileSync(path.join(root, '.forge', 'patch.md'), 'user patch\n');
    fs.writeFileSync(path.join(root, '.forge', 'protected-paths.yaml'), 'user manifest\n');

    const result = await handler(['--yes'], {}, root);

    expect(result.success).toBe(false);
    expect(result.error).toContain('.forge/patch.md, .forge/protected-paths.yaml already exist');
    expect(result.error).toContain('Re-run with --force');
    expect(fs.readFileSync(path.join(root, '.forge', 'patch.md'), 'utf8')).toBe('user patch\n');
    expect(fs.readFileSync(path.join(root, '.forge', 'protected-paths.yaml'), 'utf8')).toBe('user manifest\n');
    expect(fs.existsSync(path.join(root, '.forge', 'config.yaml'))).toBe(false);
  });

  test('first-time wizard asks classification, L1 confirmation, and harness targets in order', async () => {
    const root = makeProject();
    fs.mkdirSync(path.join(root, '.claude'));
    const prompts = [];
    const answers = ['refactor', 'y', 'claude,codex'];

    const result = await handler([], {}, root, {
      stdinIsTTY: true,
      prompt: async (question) => {
        prompts.push(question);
        return answers.shift();
      },
    });

    expect(result.success).toBe(true);
    expect(prompts[0]).toContain('classification');
    expect(prompts[1]).toContain('Layer 1');
    expect(prompts[2]).toContain('harness');

    const config = readYaml(path.join(root, '.forge', 'config.yaml'));
    expect(config.workflow.classification.default).toBe('refactor');
    expect(config.adapters.harness.targets).toEqual(['claude', 'codex']);
  });

  test('wizard fails closed when Layer 1 rails are declined', async () => {
    const root = makeProject();
    const result = await handler([], {}, root, {
      stdinIsTTY: true,
      prompt: async (question) => question.includes('Layer 1') ? 'n' : '',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Layer 1 rails must be confirmed');
    expect(result.error).toContain('Re-run forge init');
    expect(fs.existsSync(path.join(root, '.forge'))).toBe(false);
  });
});

function readYamlFromString(value) {
  return YAML.parse(value);
}
