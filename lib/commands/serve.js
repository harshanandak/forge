'use strict';

/**
 * `forge serve [--port N] [--open]`
 *
 * A minimal LOCAL loopback companion that turns the static dashboard
 * (web/dashboard/) into an interactive one. It is a DUMB RELAY: the browser
 * never mutates the kernel directly — it fires the SAME `forge` verbs the CLI
 * and agents use, in-process, through the existing command dispatch. ALL
 * validation lives in the verb/broker handlers; this server adds no parallel
 * validator.
 *
 * Endpoints:
 *   GET  /health        — capability probe (app.js flips SNAPSHOT -> LIVE).
 *   GET  /data.json     — current snapshot (regenerated on demand, debounced).
 *   POST /api/mutation  — the write path. Body { token, verb, args }.
 *   GET  /* (static)    — the dashboard assets.
 *
 * Security model (see docs/work/2026-07-13-forge-serve/design.md):
 *   - Binds 127.0.0.1 ONLY (never a public interface).
 *   - Per-run random token, minted at startup, injected into the served page
 *     URL fragment (#token=…), REQUIRED on every POST (constant-time compare).
 *   - POST also rejects any non-loopback Host / foreign Origin (CSRF fence).
 *   - No accounts, no cloud, no daemon; the token dies with the process.
 *   - Zero agent/token cost: reads SQLite/kernel + writes via the broker; it
 *     NEVER spawns an agent.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

// NOTE: `_registry` / `_resolve-command-opts` are require()d LAZILY at call time
// (inside routeMutation / registry), never destructured at module top. serve.js
// is listed in the static command manifest, so `_manifest` require()s serve.js
// while serve.js is itself mid-load requiring `_registry` — a top-level
// destructure would capture `_registry`'s not-yet-assigned exports (undefined).
// A lazy require resolves the fully-initialized module every time.

const COMMANDS_DIR = __dirname;
const DEFAULT_PORT = 8730;
const MAX_BODY = 1024 * 1024; // 1 MB — issue/comment bodies are user data.
const SNAPSHOT_TTL_MS = 3000; // debounce background regeneration.
const GEN_TIMEOUT_MS = 30000;

// verb -> forge command. Every verb is an EXISTING handler; issue verbs append
// --json so the handler returns the machine envelope. No shell is ever invoked,
// so issue/comment bodies are inert user data (the broker stores them).
const VERB_MAP = {
  'issue.create': { command: 'create', json: true },
  'issue.update': { command: 'update', json: true },
  'issue.close': { command: 'close', json: true },
  'issue.comment': { command: 'comment', json: true },
  gate: { command: 'gate', json: false },
  role: { command: 'role', json: false },
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
};

// Generated bundles that index.html <script>-loads. When absent (a fresh
// worktree gitignores them), return an empty 200 so the page cleanly falls to
// the live /data.json path with no console error.
const OPTIONAL_BUNDLES = new Set(['/snapshot.js', '/docs.js']);

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseServeArgs(args = [], flags = {}) {
  let port = Number(flags.port) || DEFAULT_PORT;
  let open = Boolean(flags.open);
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--open') open = true;
    else if (token === '--port') { port = Number(args[i + 1]) || port; i += 1; }
    else if (typeof token === 'string' && token.startsWith('--port=')) {
      port = Number(token.slice('--port='.length)) || port;
    }
  }
  return { port, open };
}

// ---------------------------------------------------------------------------
// Security helpers
// ---------------------------------------------------------------------------

function mintToken() {
  return crypto.randomBytes(32).toString('hex');
}

function verifyToken(provided, expected) {
  if (typeof provided !== 'string' || provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

function hostname(hostHeader) {
  if (typeof hostHeader !== 'string') return '';
  // Strip the :port; handle bare IPv6 defensively.
  const lastColon = hostHeader.lastIndexOf(':');
  const host = lastColon > hostHeader.indexOf(']') ? hostHeader.slice(0, lastColon) : hostHeader;
  return host.replace(/^\[|\]$/g, '').toLowerCase();
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function isLoopbackRequest(req) {
  if (!LOOPBACK_HOSTS.has(hostname(req.headers.host))) return false;
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.length > 0) {
    try {
      if (!LOOPBACK_HOSTS.has(new URL(origin).hostname.toLowerCase())) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(text);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Mutation relay — reuse the CLI's own dispatch, never a parallel validator.
// ---------------------------------------------------------------------------

let SHARED_REGISTRY = null;
function registry(deps = {}) {
  if (deps?.registry) return deps.registry;
  const loadCommands = deps.loadCommands || require('./_registry').loadCommands;
  if (!SHARED_REGISTRY) SHARED_REGISTRY = loadCommands(COMMANDS_DIR);
  return SHARED_REGISTRY;
}

function validateVerbArgs(verb, args) {
  const spec = VERB_MAP[verb];
  if (!spec) {
    return { error: `Unknown verb '${verb}'. Allowed: ${Object.keys(VERB_MAP).join(', ')}` };
  }
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) {
    return { error: 'args must be an array of strings' };
  }
  return { spec };
}

// Route a { verb, args } envelope to the EXISTING forge command handler,
// in-process. Returns { ok, output, error } — the handler's own success/
// rejection is surfaced verbatim (unknown gate, locked gate, invalid role, an
// issue-command-contract validation error).
async function routeMutation(verb, args, projectRoot, deps = {}) {
  const { spec, error } = validateVerbArgs(verb, args);
  if (error) return { ok: false, error };

  const argv = spec.json && !args.includes('--json') ? [...args, '--json'] : args;
  const resolveOpts = deps.resolveCommandOpts || require('./_resolve-command-opts').resolveCommandOpts;
  const exec = deps.executeCommand || require('./_registry').executeCommand;

  const { commandOpts, args: dispatchArgs } = await resolveOpts(
    spec.command,
    argv,
    { env: process.env, projectRoot },
  );
  const result = await exec(
    registry(deps).commands,
    spec.command,
    dispatchArgs,
    {},
    projectRoot,
    { commandOpts },
  );
  return {
    ok: result && result.success !== false,
    output: result && typeof result.output === 'string' ? result.output : undefined,
    error: result ? (result.error || undefined) : 'no result',
  };
}

// ---------------------------------------------------------------------------
// Snapshot (GET /data.json) — regenerate on demand, debounced.
// ---------------------------------------------------------------------------

function defaultGenerate(projectRoot, dashboardDir) {
  return new Promise((resolve, reject) => {
    const script = path.join(dashboardDir, 'generate-snapshot.mjs');
    const child = spawn(process.execPath, [script], { cwd: projectRoot, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('snapshot generation timed out')); }, GEN_TIMEOUT_MS);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`snapshot generator exited ${code}`));
    });
  });
}

function readBakedSnapshot(dashboardDir) {
  const dataPath = path.join(dashboardDir, 'data.json');
  if (fs.existsSync(dataPath)) return fs.readFileSync(dataPath);
  return Buffer.from('{}');
}

// Regenerate the snapshot (bounded, single-flight). Best-effort: a generator
// failure keeps the last baked data.json rather than surfacing an error.
function regenerate(ctx) {
  const cache = ctx.snapshot;
  if (cache.inFlight) return cache.inFlight;
  cache.inFlight = (async () => {
    try { await cache.generate(ctx.projectRoot, ctx.dashboardDir); } catch { /* keep baked */ }
    cache.buffer = readBakedSnapshot(ctx.dashboardDir);
    cache.lastGen = Date.now();
  })().finally(() => { cache.inFlight = null; });
  return cache.inFlight;
}

// Reads NEVER block on the heavy generator (it shells forge/git/gh): serve the
// baked snapshot immediately and refresh in the BACKGROUND when stale. Only a
// cold start with nothing baked does one bounded synchronous generation, so the
// first paint isn't empty. Mutations call regenerate() directly (see
// handleMutation) so a post-write refetch is fresh.
async function getSnapshot(ctx) {
  const cache = ctx.snapshot;
  const hasBaked = cache.buffer || fs.existsSync(path.join(ctx.dashboardDir, 'data.json'));
  if (!hasBaked) {
    await regenerate(ctx);
    return cache.buffer;
  }
  if (!cache.buffer) cache.buffer = readBakedSnapshot(ctx.dashboardDir);
  if (Date.now() - cache.lastGen > SNAPSHOT_TTL_MS && !cache.inFlight) regenerate(ctx);
  return cache.buffer;
}

// ---------------------------------------------------------------------------
// Static host
// ---------------------------------------------------------------------------

function resolveStaticPath(dashboardDir, urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const rel = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
  const abs = path.resolve(dashboardDir, rel);
  // Traversal guard: the resolved path must stay inside the dashboard dir.
  if (abs !== dashboardDir && !abs.startsWith(dashboardDir + path.sep)) return null;
  return abs;
}

function serveStatic(res, dashboardDir, urlPath) {
  const abs = resolveStaticPath(dashboardDir, urlPath);
  if (!abs) return sendText(res, 403, 'forbidden');
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    // Absent optional bundle -> empty 200 so live mode has no console noise.
    if (OPTIONAL_BUNDLES.has(urlPath.split('?')[0])) {
      return sendText(res, 200, '// forge serve: live mode (bundle not baked)\n', MIME['.js']);
    }
    return sendText(res, 404, 'not found');
  }
  const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  return res.end(fs.readFileSync(abs));
}

// ---------------------------------------------------------------------------
// Request router
// ---------------------------------------------------------------------------

async function handleMutation(req, res, ctx) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
  if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'forbidden: non-loopback request' });

  let parsed;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
  }
  if (!parsed || !verifyToken(parsed.token, ctx.token)) {
    return sendJson(res, 403, { ok: false, error: 'invalid or missing token' });
  }
  const result = await routeMutation(parsed.verb, parsed.args || [], ctx.projectRoot, ctx.deps);
  // On a successful write, refresh the baked snapshot BEFORE responding so the
  // client's follow-up /data.json refetch reflects the change. Best-effort.
  if (result.ok) { try { await regenerate(ctx); } catch { /* keep baked */ } }
  return sendJson(res, result.ok ? 200 : 422, result);
}

async function handleRequest(req, res, ctx) {
  const urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/health') {
    return sendJson(res, 200, { ok: true, forge_serve: true, version: 1 });
  }
  if (urlPath === '/api/mutation') {
    return handleMutation(req, res, ctx);
  }
  if (urlPath === '/data.json') {
    const buf = await getSnapshot(ctx);
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    return res.end(buf);
  }
  if (req.method !== 'GET') return sendText(res, 405, 'method not allowed');
  return serveStatic(res, ctx.dashboardDir, req.url || '/');
}

function buildContext(projectRoot, dashboardDir, token, deps = {}) {
  return {
    projectRoot,
    dashboardDir,
    token,
    deps,
    snapshot: {
      buffer: null,
      lastGen: 0,
      inFlight: null,
      generate: deps.generate || defaultGenerate,
    },
  };
}

function createServeServer(ctx) {
  return http.createServer((req, res) => {
    handleRequest(req, res, ctx).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: err.message });
    });
  });
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

// Resolve the OS "open a URL" helper to an ABSOLUTE path — never a bare command
// name resolved through $PATH. A writable PATH entry could otherwise shadow the
// executable (S4036); an absolute path in a fixed system directory forecloses it.
function browserOpener() {
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot || 'C:\\Windows';
    return { file: path.join(root, 'System32', 'cmd.exe'), args: ['/c', 'start', ''] };
  }
  if (process.platform === 'darwin') return { file: '/usr/bin/open', args: [] };
  return { file: '/usr/bin/xdg-open', args: [] };
}

function openBrowser(url) {
  try {
    const { file, args } = browserOpener();
    spawn(file, [...args, url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Opening a browser is best-effort; the URL is always printed.
  }
}

// Register signal handlers that close the server and resolve the handler's
// promise, so `forge serve` exits cleanly on Ctrl-C.
function installServeShutdown(server, resolve) {
  const shutdown = () => server.close(() => resolve({ success: true, output: 'forge serve stopped.' }));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

// Print the loopback URL (token in the fragment), optionally open a browser, and
// wire shutdown. Extracted so startListening's listen-callback stays shallow.
function announceServe(server, token, options, resolve) {
  const url = `http://127.0.0.1:${server.address().port}/#token=${token}`;
  process.stdout.write(
    `\nforge serve — interactive dashboard (loopback only)\n  ${url}\n`
    + '  Token dies with this process. Press Ctrl-C to stop.\n\n',
  );
  if (options.open) openBrowser(url);
  installServeShutdown(server, resolve);
}

function startListening(server, port, token, options = {}) {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => announceServe(server, token, options, resolve));
  });
}

async function handler(args, flags = {}, projectRoot = process.cwd(), _opts = {}) {
  const { port, open } = parseServeArgs(args, flags);
  const dashboardDir = path.join(projectRoot, 'web', 'dashboard');
  if (!fs.existsSync(path.join(dashboardDir, 'index.html'))) {
    return { success: false, error: `Dashboard not found at ${dashboardDir}. Run from the repo root.` };
  }
  const token = mintToken();
  const ctx = buildContext(projectRoot, dashboardDir, token);
  const server = createServeServer(ctx);
  return startListening(server, port, token, { open });
}

module.exports = {
  name: 'serve',
  description: 'Serve the interactive dashboard over 127.0.0.1 (trigger forge verbs from the browser)',
  usage: 'forge serve [--port N] [--open]',
  handler,
  // Exposed for tests + reuse (in-process, no socket).
  routeMutation,
  parseServeArgs,
  buildContext,
  createServeServer,
  verifyToken,
  isLoopbackRequest,
  resolveStaticPath,
  VERB_MAP,
};
