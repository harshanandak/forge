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
import { powerShellArgs } from "../../../powershell.ts";

const windows = process.platform === "win32";
for (const shell of ["POSIX", ...(windows ? ["PowerShell 5.1"] : [])]) {
  test(`a fresh Node project imports delivery after following the missing-value repair in ${shell}`, () => {
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
      expect(repair).toContain("Example (replace the value");
      expect(repair).toContain("retry template import at the new revision");
      const commands = repair.split("\n").flatMap((line) => {
        const match = /^\s*(POSIX|PowerShell 5.1): (forge .+)$/.exec(line);
        return match?.[1] === shell && match[2] ? [match[2]] : [];
      });
      expect(commands).toHaveLength(1);
      const command = commands[0];
      if (!command) throw new Error("expected a rendered repair command");
      expect(command).toContain("forge config set --input ");
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
      // Use the help-example shell pattern: only bind the installed CLI, then execute the advice verbatim.
      const node = Bun.which("node");
      if (!node) throw new Error("Node runtime required");
      const executable =
        shell === "POSIX"
          ? windows
            ? join(
                process.env.ProgramFiles ?? "C:/Program Files",
                "Git/bin/bash.exe",
              )
            : "bash"
          : join(
              process.env.SystemRoot ?? "C:/Windows",
              "System32/WindowsPowerShell/v1.0/powershell.exe",
            );
      const script =
        shell === "POSIX"
          ? `forge() { '${node.replaceAll("\\", "/")}' '${bin.replaceAll("\\", "/")}' "$@"; }; ${command}; exit $?`
          : `$ErrorActionPreference = 'Stop'; function forge { & '${node}' '${bin}' @args }; ${command}; exit $LASTEXITCODE`;
      const repaired = spawnSync(
        executable,
        shell === "POSIX" ? ["-c", script] : powerShellArgs(script),
        {
          cwd: root,
          env,
          encoding: "utf8",
          windowsHide: true,
          timeout: 30_000,
        },
      );
      expect(repaired.error).toBeUndefined();
      expect(repaired.status, repaired.stdout + repaired.stderr).toBe(0);
      const written = (JSON.parse(repaired.stdout) as ResultEnvelope)
        .result as WriteResult;
      const supplied = cli(["config", "show"]).result as ShowResult;
      expect(
        getIn(supplied.effective, ["blocks", "check", "config", "commands"]),
      ).toEqual({ test: "node --test" });
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
      ).toEqual({ test: "node --test" });
      const beforeReplacement = readFileSync(file, "utf8");
      const replacement = cli(
        [
          "config",
          "set",
          "--input",
          JSON.stringify({
            path: "/blocks/check/config",
            value: { timeoutMs: 1000 },
            expectRevision: shown.revision,
          }),
        ],
        6,
      );
      if (replacement.ok)
        throw new Error("expected the replacement to drop required commands");
      expect(replacement.error.repair).toBe(
        "set /blocks/check/config/commands in the same edit",
      );
      expect(readFileSync(file, "utf8")).toBe(beforeReplacement);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
}
