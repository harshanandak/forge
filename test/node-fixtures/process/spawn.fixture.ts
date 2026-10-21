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
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isRunning } from "./liveness.ts";

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
async function stoppedTree(
  name: string,
  extra: { timeoutMs?: number; signal?: AbortSignal },
  onStarted: () => void = () => undefined,
): Promise<Record<string, unknown>> {
  const pidFile = join(work, `${name}.pid`);
  const parentJs = join(work, `${name}.js`);
  writeFileSync(
    parentJs,
    [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      // On Windows a non-detached child sits in libuv's kill-on-close job and would die with its
      // parent anyway; detaching it leaves only the tree kill to stop it.
      `const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', detached: ${windows} });`,
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      "setInterval(()=>{},1000);",
    ].join("\n"),
  );
  const pending = run(process.execPath, [parentJs], extra);
  for (let wait = 0; wait < 100 && !existsSync(pidFile); wait += 1)
    await new Promise((resolve) => setTimeout(resolve, 50));
  onStarted();
  const result = await pending;
  const grandchildPid = Number(readFileSync(pidFile, "utf8"));
  const childPid = (result["supervision"] as { commandPid?: number })
    .commandPid;
  let alive = true;
  for (let attempt = 0; attempt < 40 && alive; attempt += 1) {
    if (isRunning(grandchildPid) || (childPid && isRunning(childPid))) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    } else {
      alive = false;
    }
  }
  for (const pid of [grandchildPid, childPid ?? 0])
    if (alive && pid > 0)
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
  return { ...result, treeAlive: alive };
}
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
