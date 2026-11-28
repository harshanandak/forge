import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ResultEnvelope } from "../../../src/generated/types.ts";
import { advisoryProject, laneCli } from "./lane-repository-fixture.ts";

const dataModule = (source: string) =>
  `data:text/javascript,${encodeURIComponent(source)}`;
const built = (path: string) =>
  new URL(`../../../dist/src/${path}.js`, import.meta.url).href;

function claimPreload(mode: string, report: string) {
  const resolver = built("adapters/process/resolve");
  const proof = dataModule(`
    export * from ${JSON.stringify(resolver)};
    export async function proveAdvisoryGit(executable) {
      if (${JSON.stringify(mode)} === "throws") throw new Error("Advisory failed");
      if (${JSON.stringify(mode)} === "stalls")
        return { executable, unchanged: () => true };
    }
  `);
  const spawn = dataModule(`
    import { spawn as realSpawn } from "node:child_process";
    import { EventEmitter } from "node:events";
    import { PassThrough } from "node:stream";
    export function spawn(file, args, options) {
      if (!globalThis.claimed || !args.includes("--absolute-git-dir"))
        return realSpawn(file, args, options);
      const child = Object.assign(new EventEmitter(), {
        pid: 2147483647, exitCode: null, signalCode: null,
        stdin: null, stdout: new PassThrough(), stderr: new PassThrough(),
      });
      globalThis.advisoryChild = child;
      queueMicrotask(() => globalThis.expireAdvisory());
      return child;
    }
  `);
  const runner = built("adapters/process/run");
  const runOnPosix = dataModule(`
    export * from ${JSON.stringify(runner)};
    import { runProcess as run } from ${JSON.stringify(runner)};
    export function runProcess(file, args, options, platform, config) {
      if (globalThis.claimed && args.includes("--absolute-git-dir"))
        return run(file, args, options, "linux", config);
      return run(file, args, options, platform, config);
    }
  `);
  return dataModule(`
    import { registerHooks, syncBuiltinESMExports } from "node:module";
    import { writeFileSync } from "node:fs";
    import timers from "node:timers/promises";
    const mode = ${JSON.stringify(mode)};
    let elapsed = 0;
    let remaining;
    Object.defineProperty(performance, "now", { value: () => elapsed });
    const timeout = timers.setTimeout;
    timers.setTimeout = (ms, value, options) => {
      if (globalThis.advisoryChild && value === undefined)
        return new Promise((resolve) => setImmediate(() => {
          elapsed += ms;
          resolve();
        }));
      if (mode !== "stalls" || value?.warnings?.[0]?.code !== "WORK_FILE_MAP_INCOMPLETE")
        return timeout(ms, value, options);
      remaining = ms;
      return new Promise((resolve) => {
        globalThis.expireAdvisory = () => {
          elapsed += ms;
          resolve(value);
        };
      });
    };
    syncBuiltinESMExports();
    const kill = process.kill;
    let stopped = false;
    function exitChild() {
      const child = globalThis.advisoryChild;
      if (!child || child.signalCode) return;
      child.signalCode = "SIGKILL";
      child.emit("exit", null, "SIGKILL");
      child.emit("close");
      writeFileSync(${JSON.stringify(report + ".reaped")}, child.signalCode);
    }
    process.kill = (pid, signal) => {
      if (pid !== -globalThis.advisoryChild?.pid) return kill(pid, signal);
      if (stopped) throw Object.assign(new Error("Group gone"), { code: "ESRCH" });
      if (signal === "SIGKILL") {
        stopped = true;
        setImmediate(exitChild);
      }
      return true;
    };
    const write = process.stdout.write;
    process.stdout.write = function(...args) {
      writeFileSync(${JSON.stringify(report)}, JSON.stringify({
        remaining, elapsed, started: Boolean(globalThis.advisoryChild), stopped,
      }));
      return write.apply(this, args);
    };
    const shim = ${JSON.stringify(proof)};
    const runOnPosix = ${JSON.stringify(runOnPosix)};
    registerHooks({ resolve(specifier, context, next) {
      const found = next(specifier, context);
      if (found.url === ${JSON.stringify(resolver)} && context.parentURL !== shim)
        return { ...found, url: shim };
      if (mode === "stalls" && found.url === ${JSON.stringify(runner)} &&
          context.parentURL !== runOnPosix)
        return { ...found, url: runOnPosix };
      if (found.url === "node:child_process" &&
          context.parentURL === ${JSON.stringify(built("adapters/process/process-tree"))})
        return { ...found, url: ${JSON.stringify(spawn)}, format: "module" };
      return found;
    } });
    const { Runtime } = await import(${JSON.stringify(built("core/runtime/index"))});
    const invoke = Runtime.prototype.invoke;
    Runtime.prototype.invoke = async function(request, ...rest) {
      const result = await invoke.call(this, request, ...rest);
      if (request.op === "issue.claim" && result.ok) {
        globalThis.claimed = true;
        elapsed = 4000;
      }
      return result;
    };
  `);
}

for (const [mode, reason] of [
  ["stalls", "read timed out"],
  ["finishes", "advisory Git process cost unavailable"],
  ["throws", "read unavailable"],
] as const) {
  test(`a claim keeps its lease when its advisory ${mode}`, async () => {
    await advisoryProject(
      ".worktrees/briefs/overlap.md",
      async ({ good }, repo, root) => {
        const id = String(
          (await good("issue.create", { title: "Deadline" })).id,
        );
        const report = join(root, "response.json");
        const reply = laneCli(
          root,
          repo,
          ["issue", "claim", id],
          "reader",
          {
            FORGE_DEVICE_ID: "lane-fixture",
          },
          ["--import", claimPreload(mode, report)],
        );
        expect(reply).toMatchObject({ exit: 0, ok: true, result: { id } });
        const { generation, expiresAt } = reply.result;
        expect(await good("issue.show", { id })).toMatchObject({
          id,
          lease: { generation, expiresAt },
        });
        const warnings = (
          reply as typeof reply & Pick<ResultEnvelope, "warnings">
        ).warnings;
        expect(
          warnings.filter(({ code }) => code.startsWith("WORK_FILE")),
        ).toEqual([
          {
            code: "WORK_FILE_MAP_INCOMPLETE",
            message: `File overlap map incomplete (${reason}). Some overlap may be missing.`,
          },
        ]);
        if (mode === "stalls") {
          expect(JSON.parse(readFileSync(report, "utf8"))).toEqual({
            remaining: 1000,
            elapsed: 5000,
            started: true,
            stopped: true,
          });
          expect(readFileSync(report + ".reaped", "utf8")).toBe("SIGKILL");
        }
      },
    );
  }, 30_000);
}
