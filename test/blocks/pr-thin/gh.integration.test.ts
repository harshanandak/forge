import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve, dirname, delimiter } from "node:path";
import { createProcessPort } from "../../../src/adapters/process/index.ts";
import type { ProcessPort } from "../../../src/ports/process.ts";
import { validateBlockManifest } from "../../../src/contract/index.ts";
import manifest from "../../../src/blocks/pr/forge.block.json" with { type: "json" };
type Result = {
  head?: string | null;
  verdict?: string;
  merged?: boolean;
  mergeCommit?: string;
  reasons?: { message: string }[];
};
const ops = createRequire(import.meta.url)(
  "../../../src/blocks/pr/entry.cts",
) as Record<string, (call: unknown) => Promise<Result>>;
const fixture = resolve(import.meta.dir, "../../node-fixtures/pr-thin/gh.cjs");
const node = createProcessPort().resolve("node", {
  PATH: process.env.PATH ?? "",
  PATHEXT: process.env.PATHEXT ?? "",
});
if (node.kind !== "resolved") throw new Error("Node unavailable");
const nodePath = node.path,
  head = "a".repeat(40);
const cases =
  "ready:READY behind:BEHIND failed:BLOCKED changes:BLOCKED threads:BLOCKED draft:DRAFT merged:MERGED mismatch:BLOCKED policy-off:READY merge:MERGED refused:BLOCKED missing:UNAVAILABLE non-github:UNAVAILABLE pending:BLOCKED closed:CLOSED";
for (const item of cases.split(" "))
  test(
    item,
    async () => {
      const [scenario, verdict] = item.split(":"),
        unavailable = ["missing", "non-github"].includes(scenario!);
      let launches = 0;
      const port: ProcessPort = {
        capability: "forge.process/v1",
        resolve: (name, env) => {
          expect(name).toBe("gh");
          expect(env.PATH?.split(delimiter)).toContain(dirname(fixture));
          return scenario === "missing"
            ? {
                kind: "unavailable",
                reason: "Missing gh",
                remedy: "Install gh",
              }
            : { kind: "resolved", path: fixture };
        },
        run: (_exe, args, options) => {
          launches++;
          const child = spawnSync(nodePath, [fixture, ...args], {
            encoding: "utf8",
            env: {
              ...options.env,
              PR_CASE: scenario === "policy-off" ? "threads" : scenario!,
            },
          });
          return Promise.resolve({
            exitCode: child.status,
            signal: child.signal,
            stdout: child.stdout ?? "",
            stderr: child.stderr ?? "",
            timedOut: false,
            truncated: false,
            durationMs: 0,
          });
        },
      };
      const merging = ["merge", "mismatch", "refused"].includes(scenario!);
      const result = await ops[merging ? "pr.merge" : "pr.status"]!({
        input: {
          repo:
            scenario === "non-github"
              ? "https://gitlab.com/owner/repo"
              : "owner/repo",
          number: 1,
          expectHead: scenario === "mismatch" ? "c".repeat(40) : head,
        },
        config:
          scenario === "policy-off" ? { requireResolvedThreads: false } : {},
        services: {
          process: port,
          files: { root: process.cwd() },
          environment: {
            select: () => ({
              PATH: dirname(fixture) + delimiter + process.env.PATH,
              SystemRoot: process.env.SystemRoot ?? "",
            }),
          },
        },
        signal: new AbortController().signal,
        deadline: Date.now() + 30000,
      });
      expect(validateBlockManifest(manifest).ok).toBe(true);
      if (scenario === "merge") expect(result.mergeCommit).toBe("b".repeat(40));
      else expect(result.verdict).toBe(verdict);
      if (merging) expect(result.merged).toBe(scenario === "merge");
      else expect(result.head).toBe(unavailable ? null : head);
      expect(launches).toBe(
        unavailable
          ? 0
          : scenario === "merge"
            ? 4
            : scenario === "refused"
              ? 3
              : 2,
      );
      if (scenario === "threads")
        expect(result.reasons?.[0]?.message).toBe(
          "1 unresolved review threads",
        );
    },
    30000,
  );
