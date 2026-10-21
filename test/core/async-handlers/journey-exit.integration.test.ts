// [integration] Exercise the packed-journey cleanup after its real MCP child already exited.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");

// No skip on a missing build: `bun run test:integration` builds first, so an absent dist is a failure.
test("MCP journey cleanup completes when the child exited before finally", () => {
  const node = Bun.which("node");
  if (node === null) throw new Error("Node is required for the MCP journey.");
  if (!existsSync(join(root, "dist/bin/forge.js")))
    throw new Error(
      "dist is absent: run bun run build (bun run test:integration builds first).",
    );
  const directory = mkdtempSync(join(root, ".journey-exit-"));
  try {
    const original = readFileSync(
      join(root, "test/node-fixtures/async-handlers/journey.mjs"),
      "utf8",
    ).replaceAll("\r\n", "\n");
    const marker = '"MCP must await async handler",\n      );\n    } finally {';
    expect(original.split(marker)).toHaveLength(2);
    const source = original.replace(
      marker,
      `"MCP must await async handler",
      );
      const alreadyExited = new Promise((resolve) => child.once("exit", resolve));
      child.stdin.end();
      await alreadyExited;
      assert.ok(child.exitCode !== null || child.signalCode !== null, "child must exit before finally");
    } finally {`,
    );
    const fixture = join(directory, "journey.mjs");
    writeFileSync(fixture, source);
    copyFileSync(
      join(root, "test/node-fixtures/async-handlers/deadline.mjs"),
      join(directory, "deadline.mjs"),
    );
    writeFileSync(
      join(directory, "liveness.mjs"),
      new Bun.Transpiler({ loader: "ts" }).transformSync(
        readFileSync(
          join(root, "test/node-fixtures/process/liveness.ts"),
          "utf8",
        ),
      ),
    );
    const result = spawnSync(
      node,
      ["--disable-warning=ExperimentalWarning", fixture, "surfaces"],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 15000,
        windowsHide: true,
      },
    );
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.stdout).toContain("PASS async-handlers surfaces");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 20000);
