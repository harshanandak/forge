const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const YAML = require('yaml');
const { afterEach, describe, expect, test } = require('bun:test');

const initCommand = require('../../lib/commands/init');

const repoRoot = path.resolve(__dirname, '..', '..');
const forgePath = path.join(repoRoot, 'bin', 'forge.js');
const tempRoots = [];

function makeCleanRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-init-clean-'));
  tempRoots.push(root);
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  return root;
}

async function runInit(args, projectRoot) {
  const logs = [];
  const originalLog = console.log;
  console.log = (...parts) => logs.push(parts.join(' '));
  try {
    const result = await initCommand.handler(args, {}, projectRoot);
    return { result, output: logs.join('\n') };
  } finally {
    console.log = originalLog;
  }
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('forge init command', () => {
  test('initializes a fresh repo with the minimal profile without Beads', async () => {
    const projectRoot = makeCleanRepo();
    const { result, output } = await runInit(['--profile', 'minimal', '--yes'], projectRoot);
    const configPath = path.join(projectRoot, '.forge', 'config.yaml');

    expect(result.success).toBe(true);
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.beads'))).toBe(false);
    expect(YAML.parse(fs.readFileSync(configPath, 'utf8')).template.profile).toBe('minimal');
    expect(output).toContain('forge options lint');

    const lint = spawnSync(process.execPath, [forgePath, 'options', 'lint', '--json', '--path', projectRoot], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(lint.status).toBe(0);
    expect(JSON.parse(lint.stdout).ok).toBe(true);
  });

  test('supports all shipped profile flags with distinct config defaults', async () => {
    const configs = [];
    for (const flag of ['--minimal', '--standard', '--full']) {
      const projectRoot = makeCleanRepo();
      await runInit([flag, '--yes'], projectRoot);
      configs.push(fs.readFileSync(path.join(projectRoot, '.forge', 'config.yaml'), 'utf8'));
    }

    expect(new Set(configs).size).toBe(3);
  });

  test('--yes defaults thin onboarding to the standard profile', async () => {
    const projectRoot = makeCleanRepo();
    await runInit(['--yes'], projectRoot);
    const config = YAML.parse(fs.readFileSync(path.join(projectRoot, '.forge', 'config.yaml'), 'utf8'));

    expect(config.template.profile).toBe('standard');
  });

  test('non-interactive CLI init defaults to standard instead of hanging or no-oping', () => {
    const projectRoot = makeCleanRepo();
    const result = spawnSync(process.execPath, [forgePath, 'init', '--path', projectRoot], {
      cwd: repoRoot,
      encoding: 'utf8',
      input: '',
    });
    const config = YAML.parse(fs.readFileSync(path.join(projectRoot, '.forge', 'config.yaml'), 'utf8'));

    expect(result.status).toBe(0);
    expect(config.template.profile).toBe('standard');
  });

  test('non-interactive CLI init dry-run prints parseable YAML only', () => {
    const projectRoot = makeCleanRepo();
    const result = spawnSync(process.execPath, [forgePath, 'init', '--dry-run', '--path', projectRoot], {
      cwd: repoRoot,
      encoding: 'utf8',
      input: '',
    });
    const parsed = YAML.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(parsed.template.profile).toBe('standard');
    expect(fs.existsSync(path.join(projectRoot, '.forge', 'config.yaml'))).toBe(false);
  });

  test('non-interactive CLI init dry-run does not create a missing --path target', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-init-dry-run-parent-'));
    tempRoots.push(parent);
    const projectRoot = path.join(parent, 'missing-target');
    const result = spawnSync(process.execPath, [forgePath, 'init', '--dry-run', '--path', projectRoot], {
      cwd: repoRoot,
      encoding: 'utf8',
      input: '',
    });
    const parsed = YAML.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(parsed.template.profile).toBe('standard');
    expect(fs.existsSync(projectRoot)).toBe(false);
  });

  test('non-interactive CLI setup profile dry-run prints parseable YAML only', () => {
    const projectRoot = makeCleanRepo();
    const result = spawnSync(process.execPath, [forgePath, 'setup', '--minimal', '--dry-run', '--path', projectRoot], {
      cwd: repoRoot,
      encoding: 'utf8',
      input: '',
    });
    const parsed = YAML.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(parsed.template.profile).toBe('minimal');
    expect(fs.existsSync(path.join(projectRoot, '.forge', 'config.yaml'))).toBe(false);
  });

  test('non-interactive CLI setup profile dry-run does not create a missing --path target', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-setup-dry-run-parent-'));
    tempRoots.push(parent);
    const projectRoot = path.join(parent, 'missing-target');
    const result = spawnSync(process.execPath, [forgePath, 'setup', '--minimal', '--dry-run', '--path', projectRoot], {
      cwd: repoRoot,
      encoding: 'utf8',
      input: '',
    });
    const parsed = YAML.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(parsed.template.profile).toBe('minimal');
    expect(fs.existsSync(projectRoot)).toBe(false);
  });

  test('rejects empty profile values instead of defaulting', () => {
    for (const profileArgs of [['--profile='], ['--profile=   '], ['--profile']]) {
      const projectRoot = makeCleanRepo();
      const result = spawnSync(process.execPath, [forgePath, 'init', ...profileArgs, '--path', projectRoot], {
        cwd: repoRoot,
        encoding: 'utf8',
        input: '',
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--profile requires a non-empty value');
      expect(fs.existsSync(path.join(projectRoot, '.forge', 'config.yaml'))).toBe(false);
    }
  });

  test('rejects unknown profile values with a structured error', () => {
    const projectRoot = makeCleanRepo();
    const result = spawnSync(process.execPath, [forgePath, 'init', '--profile', 'unknown', '--path', projectRoot], {
      cwd: repoRoot,
      encoding: 'utf8',
      input: '',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown adoption profile 'unknown'");
    expect(fs.existsSync(path.join(projectRoot, '.forge', 'config.yaml'))).toBe(false);
  });

  test('preserves existing config unless --force is supplied', async () => {
    const projectRoot = makeCleanRepo();
    const forgeDir = path.join(projectRoot, '.forge');
    fs.mkdirSync(forgeDir, { recursive: true });
    const configPath = path.join(forgeDir, 'config.yaml');
    fs.writeFileSync(configPath, 'template:\n  profile: custom\n', 'utf8');

    const blocked = await runInit(['--profile', 'minimal', '--yes'], projectRoot);
    expect(blocked.result.success).toBe(false);
    expect(fs.readFileSync(configPath, 'utf8')).toContain('custom');

    const forced = await runInit(['--profile', 'minimal', '--yes', '--force'], projectRoot);
    expect(forced.result.success).toBe(true);
    expect(YAML.parse(fs.readFileSync(configPath, 'utf8')).template.profile).toBe('minimal');
  });
});
