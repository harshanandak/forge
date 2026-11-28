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
  const stalls = mode === "stalls" || mode === "too late to launch";
  const resolutionStall = mode.startsWith("blocks ");
  const delayedReap =
    mode === "blocks the first lookup until after the deadline";
  const overlap = mode.startsWith("finishes with overlap");
  const resolver = built("adapters/process/resolve");
  const proof = dataModule(`
    export * from ${JSON.stringify(resolver)};
    export async function proveAdvisoryGit(executable) {
      if (${JSON.stringify(mode)} === "throws") throw new Error("Advisory failed");
      if (${stalls || resolutionStall || overlap || mode === "finishes across a wall-clock step"})
        return { executable, unchanged: () => true };
    }
  `);
  const phase = mode.startsWith("blocks the first lookup")
    ? "initial"
    : mode === "blocks discovery revalidation"
      ? "discovery"
      : mode === "blocks before Git launch"
        ? "launch"
        : undefined;
  const readerPreload = dataModule(`
    import fs from "node:fs";
    import { registerHooks } from "node:module";
    let phase;
    const emit = process.emit;
    process.emit = function(event, ...args) {
      if (event === "message") phase = args[0].op;
      return emit.call(this, event, ...args);
    };
    const realpath = fs.realpathSync.native;
    fs.realpathSync.native = function(path, ...args) {
      if (${resolutionStall} && phase === ${JSON.stringify(phase)} &&
          new Error().stack.includes(phase === "launch" ? "at valid (" : "at createGitScope (")) {
        process.send({ resolutionStalled: true });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
      return realpath(path, ...args);
    };
    const shim = ${JSON.stringify(proof)};
    registerHooks({ resolve(specifier, context, next) {
      const found = next(specifier, context);
      return found.url === ${JSON.stringify(resolver)} && context.parentURL !== shim
        ? { ...found, url: shim } : found;
    } });
  `);
  const spawn = dataModule(`
    import { spawn as realSpawn } from "node:child_process";
    import { EventEmitter } from "node:events";
    import { PassThrough } from "node:stream";
    export function spawn(file, args, options) {
      if (!${stalls} || !globalThis.claimed || !args.includes("--absolute-git-dir"))
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
    import childProcess from "node:child_process";
    import fs from "node:fs";
    import timers from "node:timers/promises";
    const mode = ${JSON.stringify(mode)};
    const { writeFileSync } = fs;
    let elapsed = 0;
    let remaining;
    let cleanupSleeps = 0;
    let wallOffset = 0;
    let stepped = false;
    let resolutionStalled = false;
    let resolutionTerminated = false;
    let finishReader;
    let wroteResponse = false;
    let readerPid;
    const wallNow = Date.now;
    Date.now = () => {
      const sampled = wallNow() + wallOffset;
      if (mode === "finishes with overlap after a backward clock step" &&
          globalThis.claimed && !stepped &&
          /at (Object.select|readWorkMap) /.test(new Error().stack)) {
        stepped = true;
        wallOffset = -30_000;
      }
      return sampled;
    };
    const fork = childProcess.fork;
    childProcess.fork = (file, args, options) => {
      if (!file.endsWith("advisory-git.js")) return fork(file, args, options);
      const child = fork(file, args, { ...options, execArgv: ["--import", ${JSON.stringify(readerPreload)}] });
      if (${delayedReap}) {
        const kill = child.kill;
        child.kill = function(signal) {
          readerPid = child.pid;
          return kill.call(this, signal);
        };
      }
      const emit = child.emit;
      child.emit = function(event, ...args) {
        if (${delayedReap} && event === "close" && !wroteResponse) {
          finishReader = () => emit.call(this, event, ...args);
          return true;
        }
        if (event === "message" && args[0]?.resolutionStalled) {
          resolutionStalled = true;
          globalThis.expireAdvisory();
          return true;
        }
        return emit.call(this, event, ...args);
      };
      child.once("close", (_code, signal) => { resolutionTerminated = signal === "SIGKILL"; });
      return child;
    };
    const realpath = fs.realpathSync.native;
    fs.realpathSync.native = function(path, ...args) {
      if (${resolutionStall} && globalThis.claimed && !resolutionStalled) {
        const stack = new Error().stack;
        if ((mode.startsWith("blocks the first lookup") && stack.includes("at createGitScope (")) ||
            (mode === "blocks discovery revalidation" && stack.includes("at Object.files (")) ||
            (mode === "blocks before Git launch" && stack.includes("at gitText ("))) {
          resolutionStalled = true;
          queueMicrotask(() => globalThis.expireAdvisory());
          elapsed += 1500;
        }
      }
      return realpath(path, ...args);
    };
    const timer = globalThis.setTimeout;
    globalThis.setTimeout = (callback, ms, ...args) => {
      if (readerPid === undefined || wroteResponse) return timer(callback, ms, ...args);
      queueMicrotask(() => {
        elapsed += ms;
        callback(...args);
      });
      return 0;
    };
    Object.defineProperty(performance, "now", { value: () => elapsed });
    const timeout = timers.setTimeout;
    timers.setTimeout = (ms, value, options) => {
      if (globalThis.advisoryChild && value === undefined) {
        cleanupSleeps++;
        return new Promise((resolve) => setImmediate(() => {
          elapsed += ms;
          resolve();
        }));
      }
      if (!${stalls || resolutionStall} || value?.warnings?.[0]?.code !== "WORK_FILE_MAP_INCOMPLETE")
        return timeout(ms, value, options);
      remaining = ms;
      const deadline = elapsed + ms;
      return new Promise((resolve) => {
        globalThis.expireAdvisory = () => {
          elapsed = Math.max(elapsed, deadline);
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
        resolutionStalled, resolutionTerminated, readerPid, stepped,
      }));
      const written = write.apply(this, args);
      wroteResponse = true;
      finishReader?.();
      return written;
    };
    process.once("exit", () => {
      writeFileSync(${JSON.stringify(report + ".exit")}, JSON.stringify({
        elapsed, cleanupSleeps,
        reaped: globalThis.advisoryChild?.signalCode === "SIGKILL",
      }));
    });
    const shim = ${JSON.stringify(proof)};
    const runOnPosix = ${JSON.stringify(runOnPosix)};
    registerHooks({ resolve(specifier, context, next) {
      const found = next(specifier, context);
      if (found.url === ${JSON.stringify(resolver)} && context.parentURL !== shim)
        return { ...found, url: shim };
      if (${stalls} && found.url === ${JSON.stringify(runner)} &&
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
        elapsed = mode === "too late to launch" ? 4999
          : ${overlap} || mode === "finishes across a wall-clock step" ? 1000 : 4000;
      }
      if (mode === "finishes across a wall-clock step" && request.op === "issue.links" && result.ok) {
        wallOffset = 30_000;
        elapsed = 1500;
      }
      return result;
    };
  `);
}

for (const [mode, reason] of [
  ["stalls", "read timed out"],
  ["too late to launch", "read timed out"],
  ["finishes", "advisory Git process cost unavailable"],
  ["throws", "read unavailable"],
  ["finishes across a wall-clock step", null],
  ["finishes with overlap", null],
  ["finishes with overlap after a backward clock step", null],
  ["blocks the first lookup", "read timed out"],
  ["blocks the first lookup until after the deadline", "read timed out"],
  ["blocks discovery revalidation", "read timed out"],
  ["blocks before Git launch", "read timed out"],
] as const) {
  test(`a claim keeps its lease when its advisory ${mode}`, async () => {
    await advisoryProject(
      ".worktrees/briefs/overlap.md",
      async ({ good }, repo, root) => {
        const plan = { title: "Deadline", expectedFiles: ["tracked"] };
        const holder =
          reason === null
            ? String((await good("issue.create", plan)).id)
            : undefined;
        if (holder !== undefined)
          await good("issue.claim", { id: holder }, "holder");
        const id = String((await good("issue.create", plan)).id);
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
        const advisory = warnings.filter(({ code }) =>
          code.startsWith("WORK_FILE"),
        );
        if (holder !== undefined) {
          expect(advisory.map(({ code }) => code)).toEqual([
            "WORK_FILE_OVERLAP",
          ]);
          expect(advisory[0]?.message).toContain(holder);
        } else {
          expect(advisory).toEqual([
            {
              code: "WORK_FILE_MAP_INCOMPLETE",
              message: `File overlap map incomplete (${reason}). Some overlap may be missing.`,
            },
          ]);
        }
        if (mode === "stalls") {
          const response = JSON.parse(readFileSync(report, "utf8")) as {
            remaining: number;
            elapsed: number;
          };
          expect(response).toMatchObject({
            started: true,
            stopped: true,
          });
          expect(response.remaining).toBeLessThanOrEqual(1000);
          expect(response.elapsed).toBeLessThanOrEqual(5000);
          expect(readFileSync(report + ".reaped", "utf8")).toBe("SIGKILL");
          const completion = JSON.parse(
            readFileSync(report + ".exit", "utf8"),
          ) as {
            elapsed: number;
          };
          expect(completion.elapsed).toBeLessThanOrEqual(5000);
          expect(completion).toMatchObject({ reaped: true, cleanupSleeps: 0 });
        }
        if (mode === "too late to launch") {
          expect(JSON.parse(readFileSync(report, "utf8"))).toMatchObject({
            started: false,
          });
        }
        if (mode.startsWith("blocks ")) {
          const response = JSON.parse(readFileSync(report, "utf8")) as {
            elapsed: number;
            resolutionStalled: boolean;
            resolutionTerminated: boolean;
            readerPid?: number;
          };
          expect(response.resolutionStalled).toBe(true);
          expect(response.elapsed).toBeLessThanOrEqual(5000);
          if (mode === "blocks the first lookup until after the deadline") {
            expect(response.resolutionTerminated).toBe(false);
            expect(response.readerPid).toBeGreaterThan(0);
            const supervision = warnings
              .filter(({ code }) => code === "PROCESS_SUPERVISION")
              .map(({ message }) => JSON.parse(message) as unknown);
            expect(supervision).toContainEqual({
              commandPid: response.readerPid,
              confirmed: false,
              killSent: true,
              reaped: false,
            });
          } else {
            expect(response.resolutionTerminated).toBe(true);
          }
        }
        if (mode === "finishes with overlap after a backward clock step") {
          expect(JSON.parse(readFileSync(report, "utf8"))).toMatchObject({
            stepped: true,
          });
        }
      },
    );
  }, 30_000);
}
