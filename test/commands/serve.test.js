'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');

const serve = require('../../lib/commands/serve');
const security = require('../../lib/commands/_serve-security');

const tempRoots = [];
const servers = [];

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-serve-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  return root;
}

function makeDashboard(snapshotJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-serve-web-'));
  tempRoots.push(dir);
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>t</title>');
  fs.writeFileSync(path.join(dir, 'data.json'), snapshotJson);
  return dir;
}

// Start a listening server on an ephemeral loopback port; always tracked so
// afterEach can close it (anti-hang: never leave a listener open).
function listen(server) {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop();
    await new Promise((resolve) => server.close(resolve));
  }
  while (tempRoots.length) {
    const root = tempRoots.pop();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('parseServeArgs', () => {
  test('defaults to port 8730, open false', () => {
    expect(serve.parseServeArgs([])).toEqual({ port: 8730, open: false });
  });
  test('--port and --open (space + equals forms)', () => {
    expect(serve.parseServeArgs(['--port', '9001', '--open'])).toEqual({ port: 9001, open: true });
    expect(serve.parseServeArgs(['--port=9002'])).toEqual({ port: 9002, open: false });
  });
  test('honors flags object', () => {
    expect(serve.parseServeArgs([], { port: 4000, open: true })).toEqual({ port: 4000, open: true });
  });
});

describe('verifyToken', () => {
  test('accepts the exact token, rejects wrong / length-mismatched', () => {
    const tok = 'a'.repeat(64);
    expect(serve.verifyToken(tok, tok)).toBe(true);
    expect(serve.verifyToken('b'.repeat(64), tok)).toBe(false);
    expect(serve.verifyToken('short', tok)).toBe(false);
    expect(serve.verifyToken(undefined, tok)).toBe(false);
  });
});

describe('isLoopbackRequest', () => {
  const req = (headers) => ({ headers });
  test('accepts loopback host with no / loopback origin', () => {
    expect(serve.isLoopbackRequest(req({ host: '127.0.0.1:8730' }))).toBe(true);
    expect(serve.isLoopbackRequest(req({ host: 'localhost:8730', origin: 'http://127.0.0.1:8730' }))).toBe(true);
  });
  test('rejects foreign host or foreign origin', () => {
    expect(serve.isLoopbackRequest(req({ host: 'evil.example.com' }))).toBe(false);
    expect(serve.isLoopbackRequest(req({ host: '127.0.0.1:8730', origin: 'http://evil.example.com' }))).toBe(false);
  });
});

describe('resolveStaticPath', () => {
  const dir = path.resolve('/tmp/dash');

  test('maps / to index.html', () => {
    expect(serve.resolveStaticPath(dir, '/')).toBe(path.join(dir, 'index.html'));
  });

  test('serves a legit nested asset inside the dashboard dir', () => {
    expect(serve.resolveStaticPath(dir, '/assets/app.js')).toBe(path.join(dir, 'assets', 'app.js'));
    // Query and fragment are stripped before resolution.
    expect(serve.resolveStaticPath(dir, '/assets/app.js?v=2#top')).toBe(path.join(dir, 'assets', 'app.js'));
  });

  test('blocks dot-dot traversal', () => {
    expect(serve.resolveStaticPath(dir, '/../../etc/passwd')).toBeNull();
    expect(serve.resolveStaticPath(dir, '/assets/../../../../etc/passwd')).toBeNull();
  });

  test('blocks percent-encoded traversal (%2e%2e%2f)', () => {
    expect(serve.resolveStaticPath(dir, '/%2e%2e%2f%2e%2e%2fetc/passwd')).toBeNull();
    expect(serve.resolveStaticPath(dir, '/..%2f..%2fetc%2fpasswd')).toBeNull();
  });

  test('blocks absolute-path escape', () => {
    // A leading extra slash / absolute-looking path must not discard the root.
    const out = serve.resolveStaticPath(dir, '/etc/passwd');
    expect(out).toBe(path.join(dir, 'etc', 'passwd'));
    expect(out.startsWith(dir + path.sep)).toBe(true);
  });

  test('rejects NUL bytes and malformed percent-encoding', () => {
    expect(serve.resolveStaticPath(dir, '/index.html%00.js')).toBeNull();
    expect(serve.resolveStaticPath(dir, '/%')).toBeNull();
  });
});

describe('routeMutation — verb allowlist + argument validation', () => {
  test('rejects an unknown verb without dispatching', async () => {
    const res = await serve.routeMutation('rm.rf', [], makeProject());
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Unknown verb');
  });
  test('rejects non-string args', async () => {
    const res = await serve.routeMutation('issue.create', [{ evil: true }], makeProject());
    expect(res.ok).toBe(false);
    expect(res.error).toContain('array of strings');
  });
  test('maps an issue verb to its command and appends --json (injected deps)', async () => {
    const calls = [];
    const deps = {
      resolveCommandOpts: async (command, argv) => { calls.push({ command, argv }); return { commandOpts: {}, args: argv }; },
      executeCommand: async () => ({ success: true, output: '{"ok":true}' }),
      registry: { commands: new Map() },
    };
    const res = await serve.routeMutation('issue.create', ['--title', 'Hello'], makeProject(), deps);
    expect(res.ok).toBe(true);
    expect(calls[0].command).toBe('create');
    expect(calls[0].argv).toContain('--json');
    expect(calls[0].argv).toContain('Hello');
  });
});

describe('routeMutation — real gate/role handler rejection + success', () => {
  test('gate: unknown gate id surfaces the handler rejection verbatim', async () => {
    const res = await serve.routeMutation('gate', ['enable', 'gate.definitely_not_real'], makeProject());
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Unknown gate');
  });
  test('role: unknown role surfaces the handler rejection verbatim', async () => {
    const res = await serve.routeMutation('role', ['not-a-real-role', '--use', 'plan'], makeProject());
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Unknown role');
  });
  test('gate: enabling a known gate succeeds and writes config', async () => {
    const root = makeProject();
    const res = await serve.routeMutation('gate', ['enable', 'gate.issue_verify'], root);
    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(root, '.forge', 'config.yaml'))).toBe(true);
  });
});

describe('bounded server smoke (starts, requests, closes)', () => {
  test('health / data.json / optional-bundle stub / token-gated mutation', async () => {
    const dashboardDir = makeDashboard('{"kind":"live-snapshot"}');
    const token = 'f'.repeat(64);
    const ctx = serve.buildContext(makeProject(), dashboardDir, token, { generate: async () => { /* no real generator */ } });
    const server = serve.createServeServer(ctx);
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}`;

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect((await health.json()).forge_serve).toBe(true);

    // /data.json is token-gated: no token -> 403.
    const noToken = await fetch(`${base}/data.json`);
    expect(noToken.status).toBe(403);
    expect((await noToken.json()).ok).toBe(false);

    // Wrong token -> 403.
    const wrongToken = await fetch(`${base}/data.json`, { headers: { 'X-Forge-Token': 'wrong' } });
    expect(wrongToken.status).toBe(403);

    // Correct token via header -> 200.
    const data = await fetch(`${base}/data.json`, { headers: { 'X-Forge-Token': token } });
    expect(data.status).toBe(200);
    expect((await data.json()).kind).toBe('live-snapshot');

    // Correct token via ?token= query param -> 200 (parity with the header path).
    const dataQ = await fetch(`${base}/data.json?token=${token}`);
    expect(dataQ.status).toBe(200);

    const bundle = await fetch(`${base}/snapshot.js`);
    expect(bundle.status).toBe(200); // absent optional bundle -> empty stub

    const badToken = await fetch(`${base}/api/mutation`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'wrong', verb: 'gate', args: [] }),
    });
    expect(badToken.status).toBe(403);

    const unknownVerb = await fetch(`${base}/api/mutation`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, verb: 'rm.rf', args: [] }),
    });
    expect(unknownVerb.status).toBe(422);
    expect((await unknownVerb.json()).ok).toBe(false);
  });

  test('every mutation attempt is recorded in the hash-chained journal', async () => {
    const projectRoot = makeProject();
    const dashboardDir = makeDashboard('{"kind":"live-snapshot"}');
    const token = 'c'.repeat(64);
    const ctx = serve.buildContext(projectRoot, dashboardDir, token, { generate: async () => {} });
    const server = serve.createServeServer(ctx);
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}`;

    // One accepted (real gate) + one rejected (unknown verb) — both journaled.
    await fetch(`${base}/api/mutation`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, verb: 'gate', args: ['enable', 'gate.issue_verify'] }),
    });
    await fetch(`${base}/api/mutation`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, verb: 'rm.rf', args: [] }),
    });

    const verified = security.verifyJournal(projectRoot);
    expect(verified.ok).toBe(true);
    expect(verified.entries).toBe(2);

    // Tampering with a journalled record must be detectable.
    const file = security.journalPath(projectRoot);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const first = JSON.parse(lines[0]);
    first.ok = !first.ok; // flip the recorded outcome
    lines[0] = JSON.stringify(first);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    expect(security.verifyJournal(projectRoot).ok).toBe(false);
  });
});

describe('verifyJournalAtStartup — the tamper check actually runs on serve start', () => {
  test('warns loudly when a past record was tampered', () => {
    const root = makeProject();
    security.appendJournal(root, { verb: 'gate', ok: true });
    security.appendJournal(root, { verb: 'issue.create', ok: true });
    // Silently rewrite record #0's payload.
    const file = security.journalPath(root);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const rec = JSON.parse(lines[0]);
    rec.verb = 'role';
    lines[0] = JSON.stringify(rec);
    fs.writeFileSync(file, lines.join('\n') + '\n');

    const warnings = [];
    const res = serve.verifyJournalAtStartup(root, (m) => warnings.push(m));
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(0);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('integrity check FAILED');
  });

  test('stays silent on an intact (or absent) journal', () => {
    const root = makeProject();
    const warnings = [];
    // Absent journal -> ok, no warning.
    expect(serve.verifyJournalAtStartup(root, (m) => warnings.push(m)).ok).toBe(true);
    security.appendJournal(root, { verb: 'gate', ok: true });
    expect(serve.verifyJournalAtStartup(root, (m) => warnings.push(m)).ok).toBe(true);
    expect(warnings.length).toBe(0);
  });
});
