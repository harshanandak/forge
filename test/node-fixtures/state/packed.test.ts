import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import {
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

// Labelled integration: real package install and separate runtime processes, no developer checkout imports.
test("integration: packed state journeys and targeted remove-the-fix checks", () => {
  const work = mkdtempSync(join(tmpdir(), "forge-packed-state-"));
  try {
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
    const runtimes = [
      ...new Set(
        [node, process.execPath, process.env.STATE_NODE26].filter(
          (value): value is string => Boolean(value),
        ),
      ),
    ];
    for (const runtime of runtimes) {
      const result = JSON.parse(
        run(runtime, [fixture, installed], consumer),
      ) as { passed: string[] };
      expect(result.passed).toHaveLength(8);
    }
    const mutations = [
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
        from: "if (active)",
        to: "if (false)",
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
        file: "core/state/index.js",
        from: "return snapshot;",
        to: "return { ...snapshot, records: snapshot.records.map(record => ({ ...record, value: null })) };",
        journey: "roundtrip",
        evidence: "deepStrictEqual",
      },
    ];
    for (const mutation of mutations) {
      const path = join(installed, "dist/src", mutation.file);
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
        for (const runtime of runtimes) {
          const result = spawnSync(
            runtime,
            [fixture, installed, mutation.journey],
            {
              cwd: consumer,
              encoding: "utf8",
              windowsHide: true,
              timeout: 30000,
            },
          );
          expect(result.error).toBeUndefined();
          expect(result.status).toBe(1);
          expect(result.stderr).toContain(mutation.evidence);
        }
      } finally {
        writeFileSync(path, original);
      }
    }
    console.log(
      `Packed state: ${runtimes.length} runtimes, 8 journeys, ${mutations.length} counterfactuals each`,
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
      for (const runtime of runtimes) {
        const result = spawnSync(runtime, [fixture, installed, "filesystem"], {
          cwd: consumer,
          encoding: "utf8",
          windowsHide: true,
          timeout: 2000,
        });
        expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe(
          "ETIMEDOUT",
        );
      }
    } finally {
      writeFileSync(path, original);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 240000);
