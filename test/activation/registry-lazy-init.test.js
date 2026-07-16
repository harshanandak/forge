const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');

const { executeCommand } = require('../../lib/commands/_registry');

const tempRoots = [];

function makeBareRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-registry-lazy-'));
  tempRoots.push(root);
  return root;
}

// Build a minimal in-memory command map so the test exercises the dispatch
// choke point without loading the real (heavy) command modules.
function makeCommands(entries) {
  const map = new Map();
  for (const [name, mod] of Object.entries(entries)) {
    map.set(name, { name, description: name, handler: async () => ({ success: true }), ...mod });
  }
  return map;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('executeCommand lazy .forge/ home', () => {
  test('a mutating verb creates the bare .forge/ home in a bare repo', async () => {
    const root = makeBareRepo();
    const commands = makeCommands({ remember: {} });

    const result = await executeCommand(commands, 'remember', ['note'], {}, root);

    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(root, '.forge', 'config.yaml'))).toBe(true);
  });

  test('a read-only verb writes NOTHING in a bare repo', async () => {
    const root = makeBareRepo();
    const commands = makeCommands({ status: {} });

    const result = await executeCommand(commands, 'status', [], {}, root);

    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(root, '.forge'))).toBe(false);
  });

  test('the handler runs even if home creation throws (degrades, no crash)', async () => {
    const root = makeBareRepo();
    let ran = false;
    const commands = makeCommands({ claim: { handler: async () => { ran = true; return { success: true }; } } });

    const result = await executeCommand(commands, 'claim', ['id'], {}, root, {
      ensureForgeHome: () => { throw new Error('disk full'); },
    });

    expect(ran).toBe(true);
    expect(result.success).toBe(true);
  });

  test('skipEnsureHome opts out of lazy creation', async () => {
    const root = makeBareRepo();
    const commands = makeCommands({ create: {} });

    await executeCommand(commands, 'create', [], {}, root, { skipEnsureHome: true });

    expect(fs.existsSync(path.join(root, '.forge'))).toBe(false);
  });

  test('an existing .forge/ is never clobbered by a mutating verb', async () => {
    const root = makeBareRepo();
    const configPath = path.join(root, '.forge', 'config.yaml');
    fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
    fs.writeFileSync(configPath, 'user: sacred\n', 'utf8');
    const commands = makeCommands({ close: {} });

    await executeCommand(commands, 'close', ['id'], {}, root);

    expect(fs.readFileSync(configPath, 'utf8')).toBe('user: sacred\n');
  });
});
