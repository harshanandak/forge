import { expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

setDefaultTimeout(30_000);
const bin = resolve(import.meta.dirname, "../../../dist/bin/forge.js");

test.each([
  { flags: [], instance: {}, checks: ["forge check run"] },
  { flags: ["--verbose"], instance: {}, checks: ["forge check run"] },
  { flags: ["--verbose=false"], instance: {}, checks: ["forge check run"] },
  { flags: [], instance: {}, checks: ["forge check run"], noCheck: true },
  {
    flags: [],
    instance: { rename: { check: "quality" } },
    checks: ["forge quality run"],
  },
  { flags: [], instance: { enabled: false }, checks: [] },
  {
    flags: [],
    instance: { enabled: false },
    checks: ["forge quality run"],
    other: true,
  },
])(
  "built delivery CLI summary and verbose contract: %j",
  ({ flags, instance, checks, ...scenario }) => {
    const root = mkdtempSync(join(tmpdir(), "forge-import-summary-"));
    const cli = (...args: string[]): Record<string, unknown> => {
      const result = spawnSync("node", [bin, ...args], {
        cwd: root,
        env: { ...process.env, FORGE_DEVICE_ROOT: join(root, "device") },
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
      });
      expect(result.status, result.stderr + result.stdout).toBe(0);
      return JSON.parse(result.stdout) as Record<string, unknown>;
    };
    const resolves = (commands: string[]) => {
      const operations = (
        cli("catalog", "list").result as { op: string }[]
      ).map((entry) => entry.op);
      for (const command of commands) {
        const [executable, noun, verb, ...args] = command.split(" ");
        expect(executable).toBe("forge");
        expect(args).toEqual([]);
        expect(operations).toContain(`${noun}.${verb}`);
        expect(cli(noun!, verb!, "--help", "--json").ok).toBe(true);
      }
    };
    try {
      if ("noCheck" in scenario) {
        writeFileSync(
          join(root, "package.json"),
          JSON.stringify({
            name: "fixture",
            scripts: { test: "node --version" },
          }),
        );
        writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}');
      }
      mkdirSync(join(root, ".forge"));
      writeFileSync(
        join(root, ".forge/config.yaml"),
        JSON.stringify({
          schemaVersion: "forge.config/1",
          blocks: {
            ...("noCheck" in scenario
              ? {}
              : {
                  check: {
                    source: { builtin: "forge/check" },
                    config: { commands: { test: "node --version" } },
                    ...instance,
                  },
                }),
            ...("other" in scenario
              ? {
                  alternate: {
                    source: { builtin: "forge/check" },
                    rename: { check: "quality" },
                    config: { commands: { test: "node --version" } },
                  },
                }
              : {}),
          },
        }),
      );
      const before = cli("config", "show").result as { revision: string };
      if ("noCheck" in scenario) {
        const operations = cli("catalog", "list").result as { op: string }[];
        expect(operations.map((entry) => entry.op)).not.toContain("check.run");
      }
      const imported = cli(
        "template",
        "import",
        "delivery",
        "--expect-revision",
        before.revision,
        ...flags,
      );
      expect(imported.ok).toBe(true);
      const result = imported.result as Record<string, unknown>;
      const verbose = flags.some((flag) => flag === "--verbose");
      expect(Object.hasOwn(result, "changes")).toBe(verbose);
      expect(result.added).toBeArray();
      expect(result.shared).toBeArray();
      expect(result.next).toEqual(["forge skills sync", ...checks]);
      const size = Buffer.byteLength(JSON.stringify(result));
      if (!verbose) expect(size).toBeLessThan(1000);
      console.log(
        `CLI delivery import (${flags.join(" ") || "default"}): result ${size}, envelope ${Buffer.byteLength(JSON.stringify(imported))} bytes`,
      );
      resolves(result.next as string[]);
      const removed = cli(
        "template",
        "remove",
        "delivery",
        "--expect-revision",
        String(result.revision),
        ...flags,
      );
      expect(removed.ok).toBe(true);
      const removal = removed.result as Record<string, unknown>;
      expect(Object.hasOwn(removal, "changes")).toBe(verbose);
      expect(removal.removed).toEqual(result.added);
      expect(removal.kept).toEqual([]);
      expect(removal.next).toEqual(["forge skills sync"]);
      resolves(removal.next as string[]);
      console.log(
        `CLI delivery remove (${flags.join(" ") || "default"}): result ${Buffer.byteLength(JSON.stringify(removal))} bytes`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
