import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { release } from "node:os";
import wrangler from "./node_modules/wrangler/package.json";
import workerd from "./node_modules/workerd/package.json";

const directory = import.meta.dir;
const state = join(directory, ".wrangler");
const marker = "forge-1761-wait-trial";
const modes = ["A", "B", "C"];
const idleMs = 120_000;
const started = performance.now();
const runId = crypto.randomUUID();
let base, sequence = 0, lastSeen = 0;
const nextAsk = () => [runId, ++sequence].join("-");
const path = (mode, ask, after) => "/" + mode + "?" + new URLSearchParams(
  after === undefined ? { ask } : { ask, after },
);
const at = (offset, start) => Bun.sleep(Math.max(0, offset - (performance.now() - start)));
const record = (answer, ask) => {
  assert.equal(answer.ask, ask);
  lastSeen = Math.max(lastSeen, answer.seq);
  return { ...answer, receivedAt: performance.now() };
};

async function json(route, method = "GET") {
  const response = await fetch(base + route, { method, signal: AbortSignal.timeout(10_000) });
  assert.ok(response.ok, route + " returned " + response.status);
  return response.json();
}

function wait(mode, ask, after) {
  if (mode !== "C") {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(32_000)]);
    const answer = fetch(base + path(mode, ask, after), { signal }).then(async response => {
      if (response.status === 204) return null;
      assert.ok(response.ok, mode + " returned " + response.status);
      return record(await response.json(), ask);
    }).catch(error => {
      if (!controller.signal.aborted) throw error;
      return null;
    });
    return { answer, close: () => controller.abort(), closed: answer };
  }

  const socket = new WebSocket(base.replace(/^http/, "ws") + path(mode, ask));
  const answer = Promise.withResolvers();
  const ready = Promise.withResolvers();
  const closed = Promise.withResolvers();
  const connecting = setTimeout(() => socket.close(), 10_000).unref();
  let observed;
  socket.addEventListener("open", () => socket.send(JSON.stringify({ after })));
  socket.addEventListener("message", event => {
    const data = JSON.parse(event.data);
    if (data.answer) {
      observed = record(data.answer, ask);
      answer.resolve(observed);
    }
    if (data.ready) {
      clearTimeout(connecting);
      ready.resolve(true);
    }
  });
  socket.addEventListener("close", () => {
    clearTimeout(connecting);
    ready.resolve(false);
    answer.resolve(null);
    closed.resolve();
  });
  return {
    answer: answer.promise, ready: ready.promise, closed: closed.promise,
    close: () => socket.close(), observed: () => observed,
  };
}

function posted(ask, snapshot = false) {
  return json("/answer?" + new URLSearchParams(snapshot ? { ask, snapshot: 1 } : { ask }), "POST");
}

async function delivered(client, ms = 5000) {
  const timer = setTimeout(client.close, ms);
  try { return await client.answer; }
  finally {
    clearTimeout(timer);
    client.close();
    await client.closed;
  }
}

async function wake(client, ask) {
  const sentAt = performance.now();
  const [answer, stored] = await Promise.all([delivered(client), posted(ask)]);
  assert.equal(answer?.seq, stored.seq, "Wake missed " + ask);
  return { ask, seq: stored.seq, wakeMs: answer.receivedAt - sentAt };
}

const percentile = (values, p) => values[Math.ceil(values.length * p) - 1];
function summary(samples) {
  const values = samples.map(sample => sample.wakeMs).sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return { medianMs: (values[middle - 1] + values[middle]) / 2,
    p95Ms: percentile(values, 0.95), maxMs: values.at(-1) };
}

let seed = 1761;
const delays = Array.from({ length: 200 }, () => {
  seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
  return 500 + Math.floor((seed / 2 ** 32) * 2501);
});
async function latency(mode) {
  const samples = [];
  for (let index = 0; index < delays.length; index += 20) {
    samples.push(...await Promise.all(delays.slice(index, index + 20).map(async (delayMs, offset) => {
      await Bun.sleep(12 * offset);
      const ask = nextAsk();
      const client = wait(mode, ask, lastSeen);
      const started = performance.now();
      if (client.ready) assert.ok(await client.ready, "Socket subscription failed");
      await at(delayMs, started);
      return { delayMs, actualDelayMs: performance.now() - started, ...await wake(client, ask) };
    })));
  }
  return { ...summary(samples), samples };
}

async function load(mode) {
  await json("/reset", "POST");
  const asks = Array.from({ length: 200 }, nextAsk);
  const clients = asks.map(ask => wait(mode, ask, lastSeen));
  if (mode === "C") assert.ok((await Promise.all(clients.map(client => client.ready))).every(Boolean));
  const readyBy = performance.now() + 8000;
  let readyCounts;
  do {
    readyCounts = await json("/stats");
    if (readyCounts.requests === 200 && readyCounts.reads >= 200) break;
    assert.ok(performance.now() < readyBy, "200 waiters did not reach the object");
    await Bun.sleep(10);
  } while (true);
  const start = performance.now();
  const samples = await Promise.all(asks.map(async (ask, index) => {
    await at(5000 * index / (asks.length - 1), start);
    return wake(clients[index], ask);
  }));
  const counts = await json("/stats");
  assert.equal(counts.requests, 400);
  return { p95Ms: summary(samples).p95Ms, counts, readyCounts, samples };
}

async function idle(mode) {
  await json("/reset", "POST");
  const ask = nextAsk();
  const after = lastSeen;
  let client = wait(mode, ask, after);
  if (client.ready) assert.ok(await client.ready);
  const initial = await json("/stats");
  const start = performance.now();
  let stopping = false;
  const requests = mode === "C" ? null : (async () => {
    while ((await client.answer) === null && !stopping) client = wait(mode, ask, after);
  })();
  await at(idleMs, start);
  const durationMs = performance.now() - start;
  let counts, hibernation;
  if (mode === "C") {
    const [stored, answer] = await Promise.all([posted(ask, true), delivered(client)]);
    counts = stored.before;
    hibernation = { constructorsBefore: initial.constructors, constructorsAfter: counts.constructors,
      answerArrived: answer?.seq === stored.seq, expectedSeq: stored.seq, receivedSeq: answer?.seq ?? null };
  } else {
    counts = await json("/stats");
    stopping = true;
    client.close();
    await requests;
    await Bun.sleep(1050);
  }
  const perHour = Object.fromEntries(["reads", "requests", "timers"].map(key => [key, counts[key] * 30]));
  return { idle: { initial, counts, perHour, durationMs }, hibernation };
}

async function recovery(mode, disconnect, useCursor = true) {
  const trials = [];
  for (let batch = 0; batch < 4; batch++) {
    const before = disconnect && mode !== "C" ? (await json("/stats")).requests : 0;
    const inputs = Array.from({ length: 25 }, () => ({ ask: nextAsk(), after: lastSeen }));
    if (disconnect) {
      const old = inputs.map(({ ask, after }) => wait(mode, ask, after));
      if (mode === "C") assert.ok((await Promise.all(old.map(client => client.ready))).every(Boolean));
      else {
        const timeout = performance.now() + 8000;
        while ((await json("/stats")).requests < before + inputs.length) {
          assert.ok(performance.now() < timeout, "Disconnect trials did not reach the object");
          await Bun.sleep(10);
        }
      }
      old.forEach(client => client.close());
      await Promise.all(old.map(client => client.closed));
    }
    trials.push(...await Promise.all(inputs.map(async ({ ask, after }) => {
      const stored = await posted(ask);
      const client = wait(mode, ask, useCursor ? after : undefined);
      if (client.ready) assert.ok(await client.ready, "Socket resubscription failed");
      if (!useCursor) await Bun.sleep(1000);
      const answer = useCursor ? await delivered(client) : client.observed();
      if (!useCursor) {
        client.close();
        await client.closed;
      }
      return { ask, after, sentCursor: useCursor, expectedSeq: stored.seq, receivedSeq: answer?.seq ?? null };
    })));
  }
  return { lost: trials.filter(trial => trial.receivedSeq !== trial.expectedSeq).length, trials };
}

async function processes() {
  const command = "Get-CimInstance Win32_Process | Where-Object { " +
    "$_.Name -match '^(node|workerd|wrangler)([.]exe)?$' -and " +
    "$_.CommandLine -like '*" + marker + "*' } | Select-Object Name,ProcessId,ParentProcessId | ConvertTo-Json -Compress";
  const query = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command]);
  assert.equal(query.exitCode, 0, query.stderr.toString());
  const value = query.stdout.toString().trim();
  return value ? [JSON.parse(value)].flat() : [];
}

async function serve() {
  await mkdir(join(state, "tmp"), { recursive: true });
  const proxy = "http://127.0.0.1:1";
  return Bun.spawn(["node", join(directory, "node_modules", "wrangler", "bin", "wrangler.js"),
    "dev", "--local", "--no-bundle", "--config", join(directory, "wrangler.jsonc"), "--ip", "127.0.0.1",
    "--port", "0", "--inspector-port", "0", "--show-interactive-dev-session", "false",
    "--persist-to", join(state, "state", runId)], { cwd: directory, stdout: "pipe", stderr: "inherit",
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, CI: "true",
      TMP: join(state, "tmp"), TEMP: join(state, "tmp"), XDG_CONFIG_HOME: join(state, "config"),
      XDG_CACHE_HOME: join(state, "cache"), WRANGLER_LOG_PATH: join(state, "logs"),
      WRANGLER_SEND_METRICS: "false", NODE_USE_ENV_PROXY: "1",
      HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: "localhost,127.0.0.1" } });
}

const results = { versions: { wrangler: wrangler.version, workerd: workerd.version, bun: Bun.version,
  node: Bun.spawnSync(["node", "--version"]).stdout.toString().trim(), os: process.platform + " " + release() },
  runId, modes: {} };
const server = await serve();
try {
  const ready = Promise.withResolvers();
  let startup = "";
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of server.stdout) {
      if (base) continue;
      startup += decoder.decode(chunk, { stream: true });
      base = startup.match(/Ready on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      if (base) ready.resolve(base);
    }
    ready.reject(new Error("Wrangler stopped before ready:\n" + startup));
  })();
  const startupTimer = setTimeout(() => ready.reject(new Error("Wrangler startup timed out:\n" + startup)), 20_000);
  try { await ready.promise; } finally { clearTimeout(startupTimer); }
  for (const mode of modes) {
    const result = results.modes[mode] = {};
    console.log(mode + " M1 and M5");
    result.M1 = await latency(mode);
    result.M5 = await load(mode);
    console.log(mode + " M2" + (mode === "C" ? " and M6" : ""));
    const quiet = await idle(mode);
    result.M2 = quiet.idle;
    if (quiet.hibernation) result.M6 = quiet.hibernation;
    console.log(mode + " M3 and M4");
    result.M3 = await recovery(mode, true);
    if (mode === "C") result.M3WithoutPosition = await recovery(mode, true, false);
    result.M4 = await recovery(mode, false);
  }
} finally {
  const beforeShutdown = await processes().catch(() => []);
  Bun.spawnSync(["taskkill.exe", "/PID", String(server.pid), "/T", "/F"]);
  await server.exited;
  const afterShutdown = await processes();
  results.processCheck = { rootPid: server.pid, beforeShutdown, afterShutdown };
  results.runTimeSeconds = (performance.now() - started) / 1000;
  await Bun.write("results.json", JSON.stringify(results, null, 2) + "\n");
  assert.deepEqual(afterShutdown, [], "Trial Wrangler/workerd processes still running");
}

const ms = value => value.toFixed(2);
const table = {
  "M1 median / p95 / max (ms)": r => [r.M1.medianMs, r.M1.p95Ms, r.M1.maxMs].map(ms).join(" / "),
  "M2 reads / HTTP / timers (120 s)": r => ["reads", "requests", "timers"].map(key => r.M2.counts[key]).join(" / "),
  "M2 reads / HTTP / timers (1 h scaled)": r => ["reads", "requests", "timers"].map(key => r.M2.perHour[key]).join(" / "),
  "M3 lost / 100 with cursor": r => r.M3.lost,
  "M3 lost / 100 without cursor": r => r.M3WithoutPosition?.lost ?? "N/A",
  "M4 lost / 100": r => r.M4.lost,
  "M5 p95 (ms) / reads": r => ms(r.M5.p95Ms) + " / " + r.M5.counts.reads,
  "M6 constructors before / after, received": r => r.M6 ?
    [r.M6.constructorsBefore, r.M6.constructorsAfter, r.M6.answerArrived].join(" / ") : "N/A",
};
console.table(Object.fromEntries(Object.entries(table).map(([name, format]) =>
  [name, Object.fromEntries(modes.map(mode => [mode, format(results.modes[mode])]))])));
console.log("Run time (seconds):", results.runTimeSeconds.toFixed(2), "Process check:", results.processCheck);

