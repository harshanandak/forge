import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { packedConsumer } from "../packed-consumer.ts";

const root = resolve(import.meta.dirname, "../../..");
function run(
  executable: string,
  args: string[],
  cwd: string,
  timeout = 120000,
  env = process.env,
): string {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout,
    env,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${result.error?.message ?? "command failed"}\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout;
}

test("a new user's first run works end to end from the packed package", () => {
  const work = mkdtempSync(join(tmpdir(), "forge-first-run-"));
  try {
    const node = Bun.which("node");
    if (!node) throw new Error("Node runtime required");
    const consumer = packedConsumer();
    // The journey runs as a Node-only user: no Bun on PATH.
    const env = { ...process.env };
    const pathKey =
      Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    env[pathKey] = (env[pathKey] ?? "")
      .split(delimiter)
      .filter(
        (directory) =>
          !["bun", "bun.exe", "bunx", "bunx.exe"].some((name) =>
            existsSync(join(directory, name)),
          ),
      )
      .join(delimiter);
    delete env.BUN_INSTALL;
    expect(
      spawnSync("bun", ["--version"], { env, windowsHide: true }).error,
    ).toBeDefined();
    const projects = mkdtempSync(join(work, "projects-"));
    const report = run(
      node,
      [
        join(root, "test/node-fixtures/first-run/journey.mjs"),
        join(consumer, "node_modules/forge-workflow"),
      ],
      projects,
      120000,
      env,
    ).trim();
    console.log(report);
    expect(report).toEndWith(
      "template import → skills sync → issue create → issue claim → check red → check green → pr create + issue link → merge by head → issue close + show",
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 300_000);
