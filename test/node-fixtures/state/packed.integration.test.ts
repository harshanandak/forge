import { test, expect } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const fixture = join(import.meta.dirname, "journeys.mjs");
function run(command: string, args: string[], cwd = root): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 90000,
  });
  if (result.status !== 0)
    throw new Error(
      `${command}: ${result.error?.message ?? result.stderr}\n${result.stdout}`,
    );
  return result.stdout;
}

function launch(command: string, args: string[], cwd: string, timeout = 30000) {
  return new Promise<{
    status: number | null;
    signal: NodeJS.Signals | null;
    error: Error | undefined;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let error: Error | undefined;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (cause) => {
      error = cause;
    });
    child.on("close", (status, signal) => {
      resolve({ status, signal, error, stdout, stderr });
    });
  });
}

// Drain every child before restoring package files or removing its working directory.
async function complete(tasks: Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(tasks);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
  if (failures.length) throw new AggregateError(failures);
}

// Labelled integration: real package install and separate runtime processes, no developer checkout imports.
test("integration: packed state journeys and targeted remove-the-fix checks", async () => {
  let started = performance.now();
  function phase(name: string) {
    console.log(
      `Packed state ${name}: ${Math.round(performance.now() - started)} ms`,
    );
    started = performance.now();
  }
  const work = mkdtempSync(join(tmpdir(), "forge-packed-state-"));
  try {
    // CI builds once before starting the smoke and integration readers together.
    if (process.env.STATE_PREBUILT !== "1")
      run(process.execPath, ["run", "build"]);
    const node = Bun.which("node");
    if (!node) throw new Error("Node runtime required for packed integration");
    const npm = [
      join(dirname(node), "node_modules/npm/bin/npm-cli.js"),
      join(dirname(node), "../lib/node_modules/npm/bin/npm-cli.js"),
    ].find((path) => existsSync(path));
    if (!npm) throw new Error("Cannot locate the Node installation's npm CLI");
    const pack = JSON.parse(
      run(node, [npm, "pack", "--json", "--pack-destination", work]),
    ) as { filename: string }[];
    const consumer = join(work, "consumer");
    mkdirSync(consumer);
    writeFileSync(
      join(consumer, "package.json"),
      '{"name":"state-consumer","version":"1.0.0","private":true}',
    );
    run(
      node,
      [
        npm,
        "install",
        join(work, pack[0]!.filename),
        "--no-audit",
        "--no-fund",
      ],
      consumer,
    );
    const installed = join(consumer, "node_modules/forge-workflow");
    phase("install");
    const runtimes = [
      ...new Set(
        [node, process.execPath, process.env.STATE_NODE26].filter(
          (value): value is string => Boolean(value),
        ),
      ),
    ];
    const journeys = JSON.parse(
      run(node, [fixture, installed, "list"], consumer),
    ) as string[];
    expect(journeys).toHaveLength(20);
    await complete(
      Array.from({ length: 4 }, async (_, worker) => {
        for (const journey of journeys.filter(
          (_, index) => index % 4 === worker,
        )) {
          await complete(
            runtimes.map(async (runtime) => {
              const result = await launch(
                runtime,
                [fixture, installed, journey],
                consumer,
                90000,
              );
              if (result.error || result.status !== 0)
                throw new Error(
                  `${runtime}: ${result.error?.message ?? result.stderr}\n${result.stdout}`,
                );
              expect(
                (JSON.parse(result.stdout) as { passed: string[] }).passed,
              ).toEqual([journey]);
            }),
          );
        }
      }),
    );
    phase("journeys");
    const mutations = [
      {
        file: "core/state/migrations.js",
        from: "if (unknown !== undefined)",
        to: "if (false)",
        journey: "newerstore",
        evidence: "Missing expected exception",
      },
      ...[
        "value",
        "revision",
        "orphan",
        "missing",
        "gap",
        "lease",
        "previous",
        "receipt",
      ].map((mutation) => ({
        file: "core/state/index.js",
        from: "verifyEventDerivedState(candidate, eventHighWaterMark);",
        to: "void 0;",
        journey: `derivedstate:${mutation}`,
        evidence: "Missing expected exception",
      })),
      {
        file: "adapters/store-sqlite/index.js",
        from: 'throw new Error("Store identity changed while opening; reopen required");',
        to: "void 0;",
        journey: "openidentity",
        evidence: "identity swap",
      },
      {
        file: "core/state/index.js",
        from: "validateReceipt(row, events);",
        to: "void 0;",
        journey: "requestreceipts",
        evidence: "Missing expected exception",
      },
      {
        file: "adapters/store-sqlite/index.js",
        from: "path, platform: process.platform",
        to: "path: options.path, platform: process.platform",
        journey: "relativepaths",
        evidence: "relative synced store must be refused",
      },
      {
        file: "adapters/store-sqlite/index.js",
        from: 'if (candidate.all("PRAGMA foreign_key_check").length)',
        to: "if (false)",
        journey: "restorevalidation",
        evidence: "AssertionError",
      },
      {
        file: "core/state/index.js",
        from: "if (!outcome.ok)",
        to: "if (false)",
        journey: "closeerrors",
        evidence: "AssertionError",
      },
      {
        file: "core/state/index.js",
        from: "if (changed.changes !== 1)",
        to: "if (false)",
        journey: "records",
        evidence: "Missing expected exception",
      },
      {
        file: "core/state/migrations.js",
        from: "revision INTEGER NOT NULL CHECK(revision > 0)",
        to: "metadata TEXT, revision INTEGER NOT NULL CHECK(revision > 0)",
        journey: "migration",
        evidence: "strictEqual",
      },
      {
        file: "core/state/migrations.js",
        from: "if (exists())\n                    return;",
        to: "if (false) return;",
        journey: "migration",
        evidence: "original ADD failure",
      },
      {
        file: "core/state/index.js",
        from: "if (options.fence)\n                this.#held(namespace, options.fence, now);",
        to: "if (false) this.#held(namespace, options.fence, now);",
        journey: "concurrency",
        evidence: "Missing expected exception",
      },
      {
        file: "adapters/store-sqlite/index.js",
        from: 'if (active) throw new Error("Nested transactions are refused");',
        to: "void 0;",
        journey: "concurrency",
        evidence: "AssertionError",
      },
      {
        file: "core/state/index.js",
        from: "this.#held(namespace, { subject, holder, generation: replay.generation }, now);",
        to: "void 0;",
        journey: "leases",
        evidence: "Missing expected exception",
      },
      {
        file: "contract/lease.js",
        from: "const generation = current.generation + 1;",
        to: "const generation = current.generation;",
        journey: "leases",
        evidence: "strictEqual",
      },
      {
        file: "contract/lease.js",
        from: "a.session.id === b.session.id",
        to: "true",
        journey: "leases",
        evidence: "Missing expected exception",
      },
      {
        file: "core/state/fs-class.js",
        from: "!warned.has(classification.kind)",
        to: "true",
        journey: "filesystem",
        evidence: "strictEqual",
      },
      {
        file: "adapters/store-sqlite/recovery.js",
        from: "if (!same(proof(approved.source.path, source), approved.source) || !same(proof(approved.backup.path, backup), approved.backup) || !same(proof(recoveryPath, recovery), retained))",
        to: "if (false)",
        journey: "recovery",
        evidence: "Missing expected rejection",
      },
      {
        file: "core/state/index.js",
        from: 'if (handle.ownership === "owned")',
        to: "if (false)",
        journey: "lifecycle",
        evidence: "strictEqual",
      },
      {
        file: "adapters/store-sqlite/index.js",
        from: "return new Uint8Array(readFileSync(destination));",
        to: "return new Uint8Array([1,2,3]);",
        journey: "roundtrip",
        evidence: "database",
      },
    ];
    mutations.push({
      file: "adapters/store-sqlite/index.js",
      from: "if (lstatSync(path).isSymbolicLink())",
      to: "if (false)",
      journey: "relativepaths",
      evidence: "dangling file symlink must be refused",
    });
    mutations.push({
      file: "core/state/index.js",
      from: "if (!Object.hasOwn(input, index))",
      to: "if (false)",
      journey: "records",
      evidence: "Missing expected exception",
    });
    for (const journey of [
      "foreignkeys",
      "generatedcolumns",
      "namesandtriggers",
    ])
      mutations.push({
        file: "adapters/store-sqlite/index.js",
        from: "renameDurable(candidatePath, path, hooks.fs);",
        to: "void 0;",
        journey,
        // With history present, the completeness check now catches a missing swap
        // before the journey can inspect the absent domain rows.
        evidence:
          journey === "foreignkeys"
            ? "Inconsistent imported state_events key high-water mark"
            : "AssertionError",
      });
    // Each worker mutates its own package copy. Fixtures already create private stores;
    // runtime processes may share a read-only copy, but concurrent mutations must not.
    await complete(
      Array.from({ length: 4 }, async (_, worker) => {
        const isolated = join(
          consumer,
          "node_modules",
          `forge-counterfactual-${worker}`,
        );
        cpSync(installed, isolated, {
          recursive: true,
          filter: (path) => !path.endsWith(".map") && !path.endsWith(".ts"),
        });
        for (const mutation of mutations.filter(
          (_, index) => index % 4 === worker,
        )) {
          const path = join(isolated, "dist/src", mutation.file);
          const original = readFileSync(path, "utf8");
          const pattern = new RegExp(
            mutation.from
              .split(/\s+/)
              .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
              .join("\\s+"),
          );
          expect(original).toMatch(pattern);
          try {
            writeFileSync(path, original.replace(pattern, mutation.to));
            await complete(
              runtimes.map(async (runtime) => {
                const result = await launch(
                  runtime,
                  [fixture, isolated, mutation.journey],
                  consumer,
                );
                expect(result.error).toBeUndefined();
                if (result.status !== 1)
                  throw new Error(
                    `Counterfactual survived: ${mutation.journey}: ${mutation.from} (${runtime})\n${result.stdout}\n${result.stderr}`,
                  );
                if (mutation.from === "if (lstatSync(path).isSymbolicLink())")
                  expect(result.stderr).toMatch(
                    /dangling file symlink must be refused|Dangling store symlink/,
                  );
                else expect(result.stderr).toContain(mutation.evidence);
              }),
            );
          } finally {
            writeFileSync(path, original);
          }
        }
      }),
    );
    phase("counterfactuals");
    console.log(
      `Packed state: ${runtimes.length} runtimes, 20 journeys, ${mutations.length} counterfactuals each`,
    );
    // Removing the linear scan causes catastrophic backtracking on a nonmatching suffix.
    const path = join(installed, "dist/src/core/state/fs-class.js");
    const original = readFileSync(path, "utf8");
    const needle = "return value.slice(0, end);";
    expect(original).toContain(needle);
    try {
      writeFileSync(
        path,
        original.replace(needle, "return value.replace(/\\/+$/, '');"),
      );
      await complete(
        runtimes.map(async (runtime) => {
          const result = await launch(
            runtime,
            [fixture, installed, "filesystem"],
            consumer,
            2000,
          );
          expect(result.error).toBeUndefined();
          expect(result.status).toBeNull();
          expect(result.signal).toBe("SIGTERM");
        }),
      );
    } finally {
      writeFileSync(path, original);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 240000);
