/**
 * Regression: only the dispatched command module is loaded.
 *
 * The registry and global help must work from the generated manifest's static
 * metadata alone. A command module is required only when that command is
 * dispatched, and at most once per process.
 *
 * Two layers:
 *   1. Registry unit — an injected manifest whose loaders count their calls.
 *   2. Real CLI — bin/forge.js under platform Node with a require guard that
 *      records which lib/commands/<command>.js modules ended up loaded.
 */

const { describe, test, expect, afterAll } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { loadCommands, executeCommand } = require('../../lib/commands/_registry');

const ROOT = path.resolve(__dirname, '..', '..');
const CLI_TIMEOUT_MS = 60000;

function countingManifest() {
  const loads = [];
  const handlerCalls = [];
  const makeEntry = (name, extra = {}) => ({
    file: `${name}.js`,
    name,
    description: `${name} description`,
    usage: `forge ${name}`,
    flags: { '--json': 'JSON output' },
    ...extra,
    load: () => {
      loads.push(name);
      return {
        name,
        description: `${name} description`,
        usage: `forge ${name}`,
        flags: { '--json': 'JSON output' },
        ...extra,
        handler: async (args) => {
          handlerCalls.push([name, args]);
          return { success: true, ran: name };
        },
      };
    },
  });
  return {
    loads,
    handlerCalls,
    manifest: {
      dir: path.join(os.tmpdir(), 'forge-lazy-manifest-fixture-commands'),
      commands: [makeEntry('alpha'), makeEntry('beta', { hidden: true }), makeEntry('gamma')],
    },
  };
}

describe('lazy command manifest — registry', () => {
  test('building the registry and rendering global help loads 0 command modules', () => {
    const { manifest, loads } = countingManifest();
    const registry = loadCommands(manifest.dir, { manifest });

    expect([...registry.commands.keys()]).toEqual(['alpha', 'beta', 'gamma']);
    expect(registry.getHelp()).toBe([
      'Available commands:',
      '',
      '  alpha  alpha description',
      '  beta   beta description',
      '  gamma  gamma description',
    ].join('\n'));

    // Per-command help and help trimming read static metadata only.
    const beta = registry.commands.get('beta');
    expect(beta.name).toBe('beta');
    expect(beta.usage).toBe('forge beta');
    expect(beta.flags).toEqual({ '--json': 'JSON output' });
    expect(beta.hidden).toBe(true);
    expect(registry.commands.get('alpha').hidden).toBeUndefined();

    expect(loads).toEqual([]);
  });

  test('dispatching loads exactly the dispatched module, once', async () => {
    const { manifest, loads, handlerCalls } = countingManifest();
    const opts = { skipEnsureHome: true };

    const first = loadCommands(manifest.dir, { manifest });
    const r1 = await executeCommand(first.commands, 'gamma', ['x'], {}, null, opts);
    expect(r1).toEqual({ success: true, ran: 'gamma' });
    expect(loads).toEqual(['gamma']);

    const r2 = await executeCommand(first.commands, 'gamma', ['y'], {}, null, opts);
    expect(r2).toEqual({ success: true, ran: 'gamma' });

    // A second registry over the same manifest shares the loaded module.
    const second = loadCommands(manifest.dir, { manifest });
    await executeCommand(second.commands, 'gamma', [], {}, null, opts);

    expect(loads).toEqual(['gamma']);
    expect(handlerCalls).toEqual([['gamma', ['x']], ['gamma', ['y']], ['gamma', []]]);
  });

  test('non-metadata exports resolve through the loaded module', () => {
    const { manifest, loads } = countingManifest();
    const { commands } = loadCommands(manifest.dir, { manifest });
    expect(typeof commands.get('alpha').handler).toBe('function');
    expect(loads).toEqual(['alpha']);
  });
});

// ---------------------------------------------------------------------------
// Real CLI: count command modules actually loaded by bin/forge.js.
// ---------------------------------------------------------------------------

const created = [];
afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function resolveNode() {
  const executable = process.env.FORGE_NODE_EXECUTABLE || (process.platform === 'win32' ? 'node.exe' : 'node');
  const probe = spawnSync(executable, ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) throw new Error(`Node.js is required for this test (${executable})`);
  return executable;
}

function runCliCountingCommandLoads(cliArgs) {
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'forge-lazy-'));
  created.push(temporary);
  const guard = path.join(temporary, 'count-command-loads.cjs');
  const report = path.join(temporary, 'loaded.json');
  fs.writeFileSync(guard, `
const fs = require("node:fs");
process.on("exit", () => {
  const re = /[\\\\/]lib[\\\\/]commands[\\\\/]([^_\\\\/][^\\\\/]*)\\.js$/;
  const loaded = Object.keys(require.cache)
    .map((key) => { const m = re.exec(key); return m ? m[1] : null; })
    .filter(Boolean)
    .sort();
  fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify(loaded));
});
`);
  const result = spawnSync(resolveNode(), ['--require', guard, path.join(ROOT, 'bin', 'forge.js'), ...cliArgs], {
    cwd: temporary,
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS - 5000,
    env: { ...process.env, FORGE_SHEPHERD_DISABLE: '1', NO_COLOR: '1' },
  });
  const loaded = fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : null;
  return { result, loaded };
}

describe('lazy command manifest — real CLI', () => {
  test('forge --help loads 0 command modules', () => {
    const { result, loaded } = runCliCountingCommandLoads(['--help']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Additional commands:');
    expect(loaded).toEqual([]);
  }, CLI_TIMEOUT_MS);

  test('forge status --help renders per-command help and loads 0 command modules', () => {
    const { result, loaded } = runCliCountingCommandLoads(['status', '--help']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.startsWith('forge status — ')).toBe(true);
    expect(loaded).toEqual([]);
  }, CLI_TIMEOUT_MS);

  test('dispatching one read-only command loads exactly that module', () => {
    const { result, loaded } = runCliCountingCommandLoads(['stage']);
    expect(`${result.stdout}${result.stderr}`).toContain('Missing issue id.');
    expect(loaded).toEqual(['stage']);
  }, CLI_TIMEOUT_MS);
});
