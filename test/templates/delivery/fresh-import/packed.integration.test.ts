import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ImportResult,
  ShowResult,
  WriteResult,
} from "../../../../src/core/config/index.ts";
import { getIn } from "../../../../src/core/config/pointer.ts";
import type {
  OperationDeclaration,
  ResultEnvelope,
} from "../../../../src/generated/types.ts";
import { packedConsumer } from "../../../integration/packed-consumer.ts";

test("a fresh Node project imports delivery after following the missing-value repair", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-fresh-import-"));
  const bin = join(
    packedConsumer(),
    "node_modules/forge-workflow/dist/bin/forge.js",
  );
  const env = { ...process.env, FORGE_DEVICE_ROOT: join(root, "device") };
  const cli = (args: string[], status = 0) => {
    const result = spawnSync("node", [bin, ...args], {
      cwd: root,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(status);
    return JSON.parse(result.stdout) as ResultEnvelope;
  };
  try {
    const git = spawnSync("git", ["init", "--quiet"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    expect(git.status, git.stderr).toBe(0);
    mkdirSync(join(root, ".forge"));
    const file = join(root, ".forge/config.yaml");
    const original = "schemaVersion: forge.config/1\nblocks: {}\n";
    writeFileSync(file, original);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } }),
    );
    const { revision } = cli(["config", "show"]).result as ShowResult;
    const refused = cli(
      ["template", "import", "delivery", "--expect-revision", revision],
      6,
    );
    if (refused.ok) throw new Error("expected the missing-value refusal");
    expect(refused.error.code).toBe("INPUT_INVALID");
    expect(refused.error.pointer).toBe("/blocks/check/config/commands");
    expect(readFileSync(file, "utf8")).toBe(original);
    const repair = refused.error.repair;
    expect(repair).toContain("forge config set");
    expect(repair).not.toContain("in the same edit");
    if (typeof repair !== "string")
      throw new Error("expected a repair command");
    const command =
      /forge config set (\S+) '<value-as-json>' --expect-revision <revision>/.exec(
        repair,
      );
    expect(command).not.toBeNull();
    if (!command?.[1])
      throw new Error("repair must include the config set arguments");
    const described = cli(["catalog", "describe", "config.set"]).result as {
      declaration: OperationDeclaration;
      inputSchema: Record<string, unknown>;
    };
    expect(described.declaration.args).toEqual(["path", "value"]);
    expect(described.inputSchema.required).toEqual([
      "path",
      "value",
      "expectRevision",
    ]);
    const written = cli([
      "config",
      "set",
      command[1],
      JSON.stringify({ test: "npm test" }),
      "--expect-revision",
      revision,
    ]).result as WriteResult;
    const imported = cli([
      "template",
      "import",
      "delivery",
      "--expect-revision",
      written.revision,
    ]).result as ImportResult;
    expect(imported.template).toBe("harsha/delivery@0.1.2");
    const shown = cli(["config", "show"]).result as ShowResult;
    expect(
      getIn(shown.effective, ["blocks", "check", "config", "commands"]),
    ).toEqual({ test: "npm test" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
