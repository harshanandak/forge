const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { afterEach, describe, expect, test } = require('bun:test');

const {
  ensureForgeHome,
  isMutatingVerb,
  renderMinimalConfig,
  MUTATING_VERBS,
} = require('../../lib/activation/ensure-forge-home');

const tempRoots = [];

function makeBareRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ensure-home-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('ensureForgeHome', () => {
  test('creates the bare .forge/config.yaml skeleton in a bare repo', () => {
    const root = makeBareRepo();

    const result = ensureForgeHome(root);

    expect(result.created).toBe(true);
    const configPath = path.join(root, '.forge', 'config.yaml');
    expect(fs.existsSync(configPath)).toBe(true);
    expect(result.configPath).toBe(configPath);
  });

  test('writes a gates-disabled config (bare minimum, not full setup)', () => {
    const root = makeBareRepo();

    ensureForgeHome(root);

    const config = YAML.parse(fs.readFileSync(path.join(root, '.forge', 'config.yaml'), 'utf8'));
    const gates = config?.workflow?.gates ?? {};
    const gateStates = Object.values(gates).map(g => g?.enabled);
    // Every declared gate must be disabled — the CuraPod "clean, gates disabled"
    // baseline. An empty gate map is also acceptable (nothing enabled).
    expect(gateStates.every(enabled => enabled === false)).toBe(true);
  });

  test('creates NO hooks, protected-paths, lefthook, or scripts tree', () => {
    const root = makeBareRepo();

    ensureForgeHome(root);

    // Only config.yaml — none of the heavy `forge setup` payload.
    expect(fs.existsSync(path.join(root, '.forge', 'protected-paths.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.forge', 'patch.md'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'lefthook.yml'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.mcp.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'scripts'))).toBe(false);
    const forgeEntries = fs.readdirSync(path.join(root, '.forge'));
    expect(forgeEntries).toEqual(['config.yaml']);
  });

  test('is idempotent — never clobbers an existing .forge/', () => {
    const root = makeBareRepo();
    const configPath = path.join(root, '.forge', 'config.yaml');
    fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
    fs.writeFileSync(configPath, 'user: sacred\n', 'utf8');

    const result = ensureForgeHome(root);

    expect(result.created).toBe(false);
    expect(result.reason).toBe('config-exists');
    expect(fs.readFileSync(configPath, 'utf8')).toBe('user: sacred\n');
  });

  test('self-heals a half-init: .forge/ exists but config.yaml is missing', () => {
    // A prior run that was killed between mkdir and write (or a disk-full write)
    // leaves .forge/ without config.yaml. The next call must COMPLETE init, not
    // return stuck. No-clobber keys on config.yaml presence, so this is safe.
    const root = makeBareRepo();
    fs.mkdirSync(path.join(root, '.forge'), { recursive: true });

    const result = ensureForgeHome(root);

    expect(result.created).toBe(true);
    expect(fs.existsSync(path.join(root, '.forge', 'config.yaml'))).toBe(true);
  });

  test('a write failure after mkdir leaves a RETRYABLE state, not a stuck half-init', () => {
    const root = makeBareRepo();
    let throwOnce = true;
    const failingFirstWrite = {
      existsSync: fs.existsSync,
      mkdirSync: fs.mkdirSync,
      writeFileSync: (...args) => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error('ENOSPC: no space left on device');
        }
        return fs.writeFileSync(...args);
      },
    };

    // First attempt fails mid-write (dir created, config not written).
    expect(() => ensureForgeHome(root, { fs: failingFirstWrite })).toThrow('ENOSPC');
    expect(fs.existsSync(path.join(root, '.forge', 'config.yaml'))).toBe(false);

    // Next attempt (fs recovered) COMPLETES init instead of being stuck.
    const result = ensureForgeHome(root);
    expect(result.created).toBe(true);
    expect(fs.existsSync(path.join(root, '.forge', 'config.yaml'))).toBe(true);
  });
});

describe('isMutatingVerb', () => {
  test('classifies core state-changing verbs as mutating', () => {
    for (const verb of ['claim', 'close', 'create', 'comment', 'remember']) {
      expect(isMutatingVerb(verb)).toBe(true);
    }
  });

  test('classifies read-only verbs as non-mutating (they must write nothing)', () => {
    for (const verb of ['ready', 'show', 'status', 'recap', 'list', 'blocked']) {
      expect(isMutatingVerb(verb)).toBe(false);
    }
  });

  test('excludes init/setup — they own .forge/ creation themselves', () => {
    expect(isMutatingVerb('init')).toBe(false);
    expect(isMutatingVerb('setup')).toBe(false);
    expect(MUTATING_VERBS.has('init')).toBe(false);
    expect(MUTATING_VERBS.has('setup')).toBe(false);
  });

  test('excludes gate/stage — they have read-only subcommands that must write nothing', () => {
    // gate status|check and stage --list|--current are read-only; a verb-level
    // trigger would wrongly create .forge/ for them. Their mutating forms
    // self-manage (config writer / kernel broker) without ensureForgeHome.
    expect(isMutatingVerb('gate')).toBe(false);
    expect(isMutatingVerb('stage')).toBe(false);
    expect(MUTATING_VERBS.has('gate')).toBe(false);
    expect(MUTATING_VERBS.has('stage')).toBe(false);
  });

  test('retains role — it has no read-only form (every invocation writes config)', () => {
    expect(isMutatingVerb('role')).toBe(true);
  });

  test("a command module's explicit mutating flag overrides the default set", () => {
    expect(isMutatingVerb('ready', { mutating: true })).toBe(true);
    expect(isMutatingVerb('claim', { mutating: false })).toBe(false);
  });
});

describe('renderMinimalConfig', () => {
  test('honors an injected renderer (no hard dependency on the profile)', () => {
    expect(renderMinimalConfig({ renderConfig: () => 'stub: true\n' })).toBe('stub: true\n');
  });
});
