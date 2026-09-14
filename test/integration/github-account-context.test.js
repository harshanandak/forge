// forge-test-resource: exclusive
'use strict';

const { afterAll, describe, expect, test } = require('bun:test');
const { execFileSync } = require('node:child_process');
const crossSpawn = require('cross-spawn');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGithubContext } = require('../../lib/github-context');
const { executeCommand } = require('../../lib/commands/_registry');
const { createCliSandboxes, mergeEnv } = require('../helpers/cli-subprocess');

const sandboxes = createCliSandboxes('forge-account-integration-');
const productRoots = [];
afterAll(() => {
  sandboxes.cleanup();
  for (const root of productRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const fakeToken = login => `test-only-account-session-${login}`;
const canaries = [fakeToken('personal'), fakeToken('work'), 'test-only-wrong-ambient'];
function clean(value) {
  const text = JSON.stringify(value);
  expect(canaries.every(canary => !text.includes(canary))).toBe(true);
}
function environment(root) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(path|systemroot|comspec|pathext|temp|tmp)$/i.test(key)) env[key] = value;
  }
  return { ...env, INIT_CWD: root, FORGE_SHEPHERD_DISABLE: '1',
    GH_TOKEN: canaries[2], GITHUB_TOKEN: canaries[2], GH_HOST: 'wrong.example' };
}
function repository(login) {
  const root = fs.realpathSync.native(sandboxes.makeSandbox());
  if (login) execFileSync('git', ['config', '--local', 'github.account', login], {
    cwd: root, env: environment(root), stdio: 'pipe', windowsHide: true, timeout: 10000,
  });
  return root;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function installedEnvironment(root, forgeDir, nativeDir, globalConfig) {
  const pathValue = [forgeDir, nativeDir, process.env.PATH].filter(Boolean).join(path.delimiter);
  const home = path.join(path.dirname(globalConfig), 'home');
  const appData = path.join(home, 'AppData');
  fs.mkdirSync(path.join(appData, 'Roaming'), { recursive: true });
  fs.mkdirSync(path.join(appData, 'Local'), { recursive: true });
  return mergeEnv(root, {
    PATH: pathValue,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    APPDATA: path.join(appData, 'Roaming'),
    LOCALAPPDATA: path.join(appData, 'Local'),
    INIT_CWD: root,
    FORGE_SHEPHERD_DISABLE: '1',
    GH_TOKEN: canaries[2],
    GITHUB_TOKEN: canaries[2],
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_SYSTEM: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  });
}

function npmOutput(args, options) {
  const result = crossSpawn.sync('npm', args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args[0]} failed with status ${result.status}.`);
  return result.stdout || '';
}

function installTestProduct() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-account-product-'));
  productRoots.push(root);
  const prefix = path.join(root, 'installed');
  const nativeDir = path.join(root, 'native-gh');
  const globalConfig = path.join(root, 'empty-gitconfig');
  fs.mkdirSync(nativeDir);
  fs.writeFileSync(globalConfig, '', 'utf8');

  const packed = JSON.parse(npmOutput(['pack', '--ignore-scripts', '--pack-destination', root, '--json'], {
    cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 30000,
  }));
  const archive = path.join(root, packed[0].filename);
  npmOutput(['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', archive], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 120000,
  });
  const forgeDir = process.platform === 'win32' ? prefix : path.join(prefix, 'bin');

  const fakeGh = path.join(root, 'fake-gh.cjs');
  const nativeExecutable = path.join(nativeDir, 'gh.exe');
  fs.writeFileSync(fakeGh, `
'use strict';
const args = process.argv.slice(2);
const token = process.env.GH_TOKEN || '';
const selected = /^test-only-account-session-(.+)$/.exec(token)?.[1] || 'native';
const send = event => process.stdout.write(JSON.stringify({ event, login: selected, cwd: process.cwd(), args }) + '\\n');
if (args[0] === 'auth' && args[1] === 'token') { process.stdout.write('test-only-account-session-' + args[args.indexOf('--user') + 1] + '\\n'); process.exit(0); }
if (args[0] === 'alias' || args[0] === 'extension' || args[0] === 'extensions' || args[0] === 'ext') process.exit(0);
if (args[0] === 'api' && args.includes('--jq')) { process.stdout.write(JSON.stringify({ login: selected }) + '\\n'); process.exit(0); }
if (args[0] === 'repo' && args[1] === 'view') { process.stdout.write(JSON.stringify({ nameWithOwner: 'acme/demo' }) + '\\n'); process.exit(0); }
if (selected === 'native') { send('native'); process.exit(0); }
send('ready');
process.stdin.once('data', () => { send('done'); process.exit(0); });
process.stdin.resume();
`, 'utf8');
  if (process.platform === 'win32') {
    execFileSync(process.execPath, ['build', '--compile', fakeGh, '--outfile', nativeExecutable], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 30000,
    });
  }

  const forgeName = process.platform === 'win32' ? 'forge.cmd' : 'forge';
  const ghName = process.platform === 'win32' ? 'gh.cmd' : 'gh';
  const forgeTarget = path.join(forgeDir, forgeName);
  const nativeTarget = process.platform === 'win32' ? nativeExecutable : path.join(nativeDir, ghName);
  if (process.platform !== 'win32') {
    fs.writeFileSync(nativeTarget,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fakeGh)} "$@"\n`, { mode: 0o700 });
    fs.chmodSync(nativeTarget, 0o700);
  }
  return { root, forgeDir, nativeDir, globalConfig, forgeTarget, ghName };
}

function runInstalledForge(product, cwd, args) {
  const env = installedEnvironment(cwd, product.forgeDir, product.nativeDir, product.globalConfig);
  const result = crossSpawn.sync(product.forgeTarget, args, {
    cwd, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000, windowsHide: true,
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function spawnInstalledGh(product, cwd, args) {
  const env = installedEnvironment(cwd, product.forgeDir, product.nativeDir, product.globalConfig);
  const child = crossSpawn(process.platform === 'win32' ? 'gh.cmd' : 'gh', args, {
    cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let stdout = ''; let stderr = ''; let readyResolve; let readyReject; let readySettled = false;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const timer = setTimeout(() => {
    if (!readySettled) {
      readySettled = true;
      child.kill();
      readyReject(new Error('installed gh did not reach the observable ready state'));
    }
  }, 10000);
  child.stdout.on('data', chunk => {
    stdout += chunk;
    for (const line of stdout.split(/\r?\n/).slice(0, -1)) {
      if (!line.startsWith('{')) continue;
      try {
        const record = JSON.parse(line);
        if (record.event === 'ready' || record.event === 'native') {
          readySettled = true;
          clearTimeout(timer);
          readyResolve(record);
          break;
        }
      } catch { /* wait for a complete JSON line */ }
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise(resolve => child.once('close', status => {
    if (!readySettled) {
      readySettled = true;
      clearTimeout(timer);
      readyReject(new Error(`installed gh exited before the observable ready state with status ${status}`));
    }
    resolve({ status, stdout, stderr });
  }));
  child.once('error', error => {
    if (!readySettled) { readySettled = true; clearTimeout(timer); readyReject(error); }
  });
  return { child, ready, done };
}

function gitRemote(root) {
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'], {
    cwd: root, env: environment(root), stdio: 'pipe', windowsHide: true, timeout: 10000,
  });
}

function credentialFill(product, cwd) {
  const env = installedEnvironment(cwd, product.forgeDir, product.nativeDir, product.globalConfig);
  return execFileSync('git', ['credential', 'fill'], {
    cwd, env, input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000, windowsHide: true,
  });
}

describe('simultaneous clone-local GitHub sessions', () => {
  test('packed and installed PATH launchers isolate two concurrent clones, switch bindings, pass through unbound state, and fail closed', async () => {
    const product = installTestProduct();
    const personal = repository(); const work = repository();
    const unbound = repository(); const malformed = repository();
    for (const root of [personal, work, unbound, malformed]) gitRemote(root);

    const personalSetup = runInstalledForge(product, personal, ['github', 'use', 'personal', '--auto']);
    const workSetup = runInstalledForge(product, work, ['github', 'use', 'work', '--auto']);
    expect(personalSetup.status).toBe(0);
    expect(workSetup.status).toBe(0);
    expect(fs.existsSync(path.join(product.root, 'home', '.forge', 'github-router-clones.json'))).toBe(true);
    const routerPath = path.join(product.forgeDir, product.ghName);
    expect(fs.readFileSync(routerPath, 'utf8')).toContain('forge-gh-router-v1');

    execFileSync('git', ['config', '--local', 'github.account', 'personal'], {
      cwd: malformed, env: environment(malformed), stdio: 'pipe', windowsHide: true, timeout: 10000,
    });
    execFileSync('git', ['config', '--local', '--replace-all', 'github.auto', 'malformed'], {
      cwd: malformed, env: environment(malformed), stdio: 'pipe', windowsHide: true, timeout: 10000,
    });

    const sessions = [spawnInstalledGh(product, personal, ['api', 'user']), spawnInstalledGh(product, work, ['api', 'user'])];
    let ready;
    try {
      ready = await Promise.all(sessions.map(session => session.ready));
    } catch (error) {
      for (const session of sessions) session.child.kill();
      const diagnostics = await Promise.all(sessions.map(session => session.done));
      throw new Error(`${error.message}: ${JSON.stringify(diagnostics)}`);
    }
    const overlapping = sessions.every(session => session.child.exitCode === null);
    for (const session of sessions) session.child.stdin.end('continue\n');
    const results = await Promise.all(sessions.map(session => session.done));
    clean({ ready, results, personalSetup, workSetup });
    expect(ready.map(value => value.login)).toEqual(['personal', 'work']);
    expect(ready.map(value => value.cwd)).toEqual([personal, work]);
    expect(overlapping).toBe(true);
    expect(results.map(result => result.status)).toEqual([0, 0]);
    expect(results.every(result => result.stderr === '')).toBe(true);
    for (const result of results) {
      const records = result.stdout.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line));
      expect(records.map(record => record.event)).toEqual(['ready', 'done']);
    }

    const credential = credentialFill(product, personal);
    expect(credential).toContain('username=personal');
    expect(credential).toContain(`password=${fakeToken('personal')}`);

    const switchedSetup = runInstalledForge(product, personal, ['github', 'use', 'work']);
    expect(switchedSetup.status).toBe(0);
    const switched = spawnInstalledGh(product, personal, ['api', 'user', '--input', 'two words & symbols']);
    let switchedReady;
    try {
      switchedReady = await switched.ready;
    } catch (error) {
      const diagnostics = await switched.done;
      clean(diagnostics);
      throw new Error(`${error.message}: ${JSON.stringify(diagnostics)}`);
    }
    switched.child.stdin.end('continue\n');
    const switchedResult = await switched.done;
    clean({ switchedSetup, switchedReady, switchedResult });
    expect(switchedReady).toMatchObject({ event: 'ready', login: 'work' });
    expect(switchedReady.args.slice(-2)).toEqual(['--input', 'two words & symbols']);
    expect(switchedResult.status).toBe(0);

    expect(runInstalledForge(product, personal, ['github', 'auto', '--disable']).status).toBe(0);
    expect(runInstalledForge(product, personal, ['github', 'router', '--uninstall', '--force']).status).toBe(1);
    expect(fs.existsSync(routerPath)).toBe(true);

    const passthrough = spawnInstalledGh(product, unbound, ['api', 'user']);
    const passthroughReady = await passthrough.ready;
    const passthroughResult = await passthrough.done;
    expect(passthroughReady).toMatchObject({ event: 'native', login: 'native' });
    expect(passthroughResult.status).toBe(0);

    const malformedResult = spawnInstalledGh(product, malformed, ['api', 'user']);
    let malformedReadyError;
    try { await malformedResult.ready; } catch (error) { malformedReadyError = error; }
    const malformedDone = await malformedResult.done;
    expect(malformedReadyError).toBeDefined();
    expect(malformedDone.status).toBe(1);
    expect(malformedDone.stdout).not.toContain('native');
    expect(malformedDone.stderr).not.toContain('test-only-account-session');
  }, 120000);

  test.each(['mismatch', 'provider-error'])('%s blocks the guarded handler and keeps diagnostics private', async mode => {
    const root = repository('work'); let started = 0;
    const result = await executeCommand(new Map([['guarded', {
      name: 'guarded', description: 'test', githubAuth: true,
      handler: () => { started++; return { success: true }; },
    }]]), 'guarded', [], {}, root, {
      skipEnsureHome: true,
      prepareGithubContext: projectRoot => createGithubContext(projectRoot, {
        baseEnv: environment(root), runner: (command, args, options) => {
          if (command === 'git') return execFileSync(command, args, { ...options, env: environment(root), timeout: 10000 });
          if (args[0] === 'auth') return fakeToken('work');
          if (mode === 'provider-error') throw Object.assign(new Error(canaries[0]), { stdout: canaries[1], stderr: canaries[2] });
          return 'personal';
        },
      }),
    });
    expect(started).toBe(0);
    expect(result.success).toBe(false);
    clean(result);
  });
});
