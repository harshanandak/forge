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

  test('no-ops when .forge/ exists even without config.yaml (never clobber)', () => {
    const root = makeBareRepo();
    fs.mkdirSync(path.join(root, '.forge'), { recursive: true });

    const result = ensureForgeHome(root);

    expect(result.created).toBe(false);
    expect(result.reason).toBe('forge-dir-exists');
    expect(fs.existsSync(path.join(root, '.forge', 'config.yaml'))).toBe(false);
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
