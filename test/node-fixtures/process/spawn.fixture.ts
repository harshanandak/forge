// A program that drives the real process adapter and prints one JSON object of outcomes for
// test/adapters/process/node-program.integration.test.ts to assert on, under Node and under Bun:
//   node --disable-warning=ExperimentalWarning spawn.fixture.ts [adapter module URL]
// The optional argument points at the built package's adapter (dist/...) instead of the sources.
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Socket } from "node:net";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { waitUntilGone } from "./liveness.ts";
import { awaitDeadline } from "../async-handlers/deadline.mjs";

interface Adapter {
  createProcessPort(options: {
    supervision: {
      cleanupTimeoutMs: number;
      pollIntervalMs: number;
      drainTimeoutMs: number;
      maxConcurrent: number;
    };
  }): {
    resolve(
      executable: string,
      env: Record<string, string>,
    ): { kind: string; path?: string; reason?: string; remedy?: string };
    run(
      executable: { kind: "resolved"; path: string },
      args: string[],
      options: {
        cwd: string;
        env: Record<string, string>;
        timeoutMs: number;
        maxOutputBytes: number;
        stdin?: string;
        signal?: AbortSignal;
        observer?: { push(stream: string, chunk: Uint8Array): void };
      },
    ): Promise<Record<string, unknown>>;
  };
}

const entry =
  process.argv[2] ??
  pathToFileURL(
    join(import.meta.dirname, "../../../src/adapters/process/index.ts"),
  ).href;
const adapter = (await import(entry)) as Adapter;
const port = adapter.createProcessPort({
  supervision: {
    cleanupTimeoutMs: 5000,
    pollIntervalMs: 25,
    drainTimeoutMs: 250,
    maxConcurrent: 1,
  },
});
const windows = process.platform === "win32";

const work = realpathSync.native(mkdtempSync(join(tmpdir(), "forge-proc-")));
// Under Bun, `node` is still found on the caller's PATH, after the runtime's own directory.
const nodeDir = dirname(process.execPath);
const baseEnv: Record<string, string> = {
  PATH: [work, nodeDir, process.env["PATH"] ?? ""].join(delimiter),
  ...(windows
    ? {
        SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows",
        PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.JS",
      }
    : {}),
};

function run(
  command: string,
  args: string[],
  extra: Partial<{
    env: Record<string, string>;
    timeoutMs: number;
    maxOutputBytes: number;
    stdin: string;
    cwd: string;
    signal: AbortSignal;
    observer: { push(stream: string, chunk: Uint8Array): void };
  }> = {},
): Promise<Record<string, unknown>> {
  const env = extra.env ?? baseEnv;
  const resolved = port.resolve(command, env);
  if (resolved.kind !== "resolved" || resolved.path === undefined) {
    return Promise.resolve({ unresolved: resolved });
  }
  return port.run({ kind: "resolved", path: resolved.path }, args, {
    cwd: extra.cwd ?? work,
    env,
    timeoutMs: extra.timeoutMs ?? 20_000,
    maxOutputBytes: extra.maxOutputBytes ?? 1_000_000,
    ...(extra.stdin === undefined ? {} : { stdin: extra.stdin }),
    ...(extra.signal === undefined ? {} : { signal: extra.signal }),
    ...(extra.observer === undefined ? {} : { observer: extra.observer }),
  });
}

async function rejection(
  pending: Promise<unknown>,
): Promise<{ code: unknown; message: string } | undefined> {
  try {
    await pending;
    return undefined;
  } catch (error) {
    const failure = error as { code?: unknown; message?: string };
    return { code: failure.code, message: String(failure.message) };
  }
}

// A program that prints its argv as JSON and exits 7, reached through a shim named like npm's:
// on Windows an extensionless shell script next to a .cmd batch file (the layout that used to fail
// with ENOENT), elsewhere an executable script.
const shimJs = join(work, "shim.js");
writeFileSync(
  shimJs,
  "process.stdout.write(JSON.stringify(process.argv.slice(2)));process.exit(7);\n",
);
if (windows) {
  writeFileSync(
    join(work, "shim"),
    `#!/bin/sh\nexec "${process.execPath}" "${shimJs}" "$@"\n`,
  );
  writeFileSync(
    join(work, "shim.cmd"),
    `@ECHO off\r\n"${process.execPath}" "${shimJs}" %*\r\nEXIT /b %ERRORLEVEL%\r\n`,
  );
} else {
  const script = join(work, "shim");
  writeFileSync(
    script,
    `#!/bin/sh\nexec "${process.execPath}" "${shimJs}" "$@"\n`,
  );
  chmodSync(script, 0o755);
}

const awkward = [
  "plain",
  "two words",
  "amp&ersand",
  "pipe|bar",
  "(paren)",
  "care^t",
  "<angle>",
  "--flag=with space",
  "trailing\\",
  "",
];

const results: Record<string, unknown> = {};

results["platform"] = process.platform;
results["nodeVersion"] = process.version;

results["output"] = await run("node", [
  "-e",
  "process.stdout.write('out');process.stderr.write('err');process.exit(3)",
]);

const shimResolved = port.resolve("shim", baseEnv);
results["shimResolvedTo"] =
  shimResolved.kind === "resolved" ? shimResolved.path : shimResolved;
results["shim"] = await run("shim", awkward);

const sentinel = join(work, "pwned.txt");
results["injection"] = await run("shim", ["& echo pwned > pwned.txt"]);
results["injectionFileCreated"] = existsSync(sentinel);

results["percent"] = windows
  ? await rejection(run("shim", ["%PATH%"]))
  : await run("shim", ["%PATH%"]);
results["quote"] = windows
  ? await rejection(run("shim", ['say "hi"']))
  : await run("shim", ['say "hi"']);

results["stdin"] = await run(
  "node",
  [
    "-e",
    "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(d.toUpperCase()))",
  ],
  { stdin: "pipe me" },
);

let observedBytes = 0;
results["truncated"] = {
  ...(await run("node", ["-e", "process.stdout.write('x'.repeat(100000))"], {
    maxOutputBytes: 1000,
    observer: {
      push: (_stream, chunk) => {
        observedBytes += chunk.length;
      },
    },
  })),
  observedBytes,
};

process.env["FORGE_LEAK_PROBE"] = "leaked";
results["envIsolation"] = await run("node", [
  "-e",
  "process.stdout.write(String(process.env.FORGE_LEAK_PROBE))",
]);

results["missingCommand"] = port.resolve("forge-no-such-command-xyz", baseEnv);
results["badCwd"] = await rejection(
  run("node", ["-e", "0"], { cwd: join(work, "does-not-exist") }),
);

// A command that starts a grandchild and then waits: timeout and cancellation must stop both.
// The parent publishes the grandchild's pid by renaming a finished file into place, so the pid
// file appearing is the "tree is ready" signal and is never read half-written.
async function stoppedTree(
  name: string,
  extra: { timeoutMs?: number; signal?: AbortSignal },
  onReady: () => void = () => undefined,
): Promise<Record<string, unknown>> {
  const pidFile = join(work, `${name}.pid`);
  const parentJs = join(work, `${name}.js`);
  // Retain connections to both processes; a saved PID can already belong to someone else.
  const connections = new Set<Socket>();
  let cleaning = false;
  const server = createServer((socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    socket.on("error", () => {});
    if (cleaning) socket.write("stop");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Missing cleanup port");
  const control = `const socket=require('node:net').connect(${address.port},'127.0.0.1'); socket.on('data',()=>process.exit(0)); socket.on('error',()=>process.exit(1));`;
  writeFileSync(
    parentJs,
    [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      control,
      // On Windows a non-detached child sits in libuv's kill-on-close job and would die with its
      // parent anyway; detaching it leaves only the tree kill to stop it.
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(`${control} setInterval(()=>{},1000);`)}], { stdio: 'ignore', detached: ${windows} });`,
      `fs.writeFileSync(${JSON.stringify(`${pidFile}.tmp`)}, String(child.pid));`,
      `fs.renameSync(${JSON.stringify(`${pidFile}.tmp`)}, ${JSON.stringify(pidFile)});`,
      "setInterval(()=>{},1000);",
    ].join("\n"),
  );
  try {
    const pending = run(process.execPath, [parentJs], extra);
    let settled = false;
    void pending.then(
      () => (settled = true),
      () => (settled = true),
    );
    // Waits on the ready signal or the run ending, never on a clock: under load the parent may take
    // any time to start, and the run's own timeout bounds this wait.
    while (!settled && !existsSync(pidFile))
      await new Promise((resolve) => setTimeout(resolve, 25));
    if (!settled) onReady();
    const result = await pending;
    const grandchildStarted = existsSync(pidFile);
    const childPid = (result["supervision"] as { commandPid?: number })
      .commandPid;
    const pids = [
      grandchildStarted ? Number(readFileSync(pidFile, "utf8")) : 0,
      childPid ?? 0,
    ].filter((pid) => pid > 0);
    const stopped = await waitUntilGone(pids);
    return { ...result, grandchildStarted, treeAlive: !stopped };
  } finally {
    cleaning = true;
    const closed = new Promise<void>((resolve) =>
      server.close(() => resolve()),
    );
    for (const socket of connections) socket.write("stop");
    await awaitDeadline(closed, 5000, "process fixture cleanup");
  }
}
// The timeout clock starts at spawn and covers the parent's own start-up, so under load the timeout
// can end the parent before it starts the grandchild; then there is no grandchild to leak and the
// outcome reports so. Cancellation waits for the ready signal, so it always ends a full tree.
results["timeout"] = await stoppedTree("timeout", { timeoutMs: 1500 });
const controller = new AbortController();
results["cancel"] = await stoppedTree(
  "cancel",
  { signal: controller.signal },
  () => controller.abort(),
);

process.stdout.write(`${JSON.stringify(results)}\n`);
// Best effort: Windows keeps a killed process's working directory busy for a moment after it ends,
// and a failed cleanup must not hide the outcomes already reported.
try {
  rmSync(work, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
} catch {
  // left in the temp folder
}
