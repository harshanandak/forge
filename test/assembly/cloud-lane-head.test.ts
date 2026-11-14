import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import * as coordinator from "../../src/assembly/cloud-lane-coordinator.ts";
import {
  createAssemblyProviders,
  createProcessService,
  type AssemblyProviders,
} from "../../src/assembly/providers.ts";
import type { Preflight } from "../../src/core/runtime/index.ts";
import type { ProcessPort } from "../../src/ports/process.ts";

const readHead = (
  coordinator as unknown as {
    readBoundLaneHead: (
      flight: Preflight,
      providers: AssemblyProviders,
      worktree: string,
    ) => Promise<string>;
  }
).readBoundLaneHead;
const flight = (effects = ["environment:read", "external:process"]) =>
  ({
    request: { op: "lane.next" },
    operation: { declaration: { effects, timeoutMs: 60000 } },
  }) as unknown as Preflight;
const git = Bun.which("git");
if (!git) throw new Error("Git required for the trusted head fixture");
const trusted = realpathSync.native(git);
const H1 = "a".repeat(40),
  H2 = "b".repeat(40);

for (const variant of [
  "trusted lookup",
  "fresh read",
  "sha256",
  "no trusted git",
  "exit",
  "timeout",
  "truncated",
  "invalid head",
  "process effect",
  "environment effect",
] as const)
  test(`attached head table: ${variant}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-bound-head-"));
    const caller = join(root, "caller"),
      target = join(root, "target");
    for (const path of [caller, target]) {
      mkdirSync(path);
      writeFileSync(
        join(path, process.platform === "win32" ? "git.exe" : "git"),
        "project-controlled executable",
        { mode: 0o755 },
      );
    }
    const env = {
      PATH: [
        caller,
        target,
        ...(variant === "no trusted git" ? [] : [dirname(trusted)]),
      ].join(delimiter),
      PATHEXT: process.env.PATHEXT ?? ".EXE;.CMD",
      SystemRoot: process.env.SystemRoot ?? "",
      GIT_DIR: "must-not-reach-git",
    };
    const native = createAssemblyProviders(caller, { env });
    let attempts = 0;
    const runs = mock<ProcessPort["run"]>((_executable, _args, _options) => {
      attempts++;
      return Promise.resolve({
        exitCode: variant === "exit" ? 1 : 0,
        signal: null,
        stderr: "",
        stdout:
          variant === "invalid head"
            ? "not-a-head"
            : variant === "sha256"
              ? "a".repeat(64)
              : variant === "fresh read" && attempts > 1
                ? H2
                : H1,
        timedOut: variant === "timeout",
        truncated: variant === "truncated",
        durationMs: 0,
      });
    });
    const files = mock(() => {
      throw new Error("Head inspection must not open clone files");
    });
    const providers: AssemblyProviders = {
      ...native,
      openFiles: files,
      process(scope) {
        const process = native.process(scope);
        return createProcessService(
          {
            capability: "forge.process/v1",
            resolve: (name, env) => process.resolve(name, env),
            run: runs,
          },
          scope,
          caller,
        );
      },
    };
    try {
      expect(typeof readHead).toBe("function");
      const effects =
        variant === "process effect"
          ? ["environment:read"]
          : variant === "environment effect"
            ? ["external:process"]
            : undefined;
      const expected =
        variant === "no trusted git"
          ? "UNAVAILABLE"
          : variant.endsWith("effect")
            ? "EFFECT_UNDECLARED"
            : ["exit", "timeout", "truncated", "invalid head"].includes(variant)
              ? "INPUT_CONFLICT"
              : undefined;
      if (expected)
        await expect(
          readHead(flight(effects), providers, target),
        ).rejects.toMatchObject({ error: { code: expected } });
      else {
        expect(await readHead(flight(), providers, target)).toBe(
          variant === "sha256" ? "a".repeat(64) : H1,
        );
        if (variant === "fresh read")
          expect(await readHead(flight(), providers, target)).toBe(H2);
      }
      for (const [executable, args, options] of runs.mock.calls) {
        expect(executable.path).toBe(trusted);
        expect(args).toEqual(["rev-parse", "--verify", "HEAD"]);
        expect(options.cwd).toBe(target);
        expect(options.env).not.toHaveProperty("GIT_DIR");
        expect(options.timeoutMs).toBeGreaterThan(0);
        expect(options.timeoutMs).toBeLessThanOrEqual(60000);
      }
      expect(runs).toHaveBeenCalledTimes(
        ["no trusted git", "process effect", "environment effect"].includes(
          variant,
        )
          ? 0
          : variant === "fresh read"
            ? 2
            : 1,
      );
      expect(files).not.toHaveBeenCalled();
      expect(existsSync(join(caller, ".forge", "state.sqlite"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

test("attached head reads the target checkout rather than the caller checkout", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-real-bound-head-"));
  const caller = join(root, "caller"),
    target = join(root, "target");
  const initialize = (path: string) => {
    mkdirSync(path);
    for (const args of [
      ["init", "--quiet", path],
      [
        "-C",
        path,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        path,
      ],
    ]) {
      const result = spawnSync(trusted, args, {
        encoding: "utf8",
        windowsHide: true,
      });
      expect(result.status, result.stderr).toBe(0);
    }
    return spawnSync(trusted, ["-C", path, "rev-parse", "HEAD"], {
      encoding: "utf8",
      windowsHide: true,
    }).stdout.trim();
  };
  try {
    const callerHead = initialize(caller),
      targetHead = initialize(target);
    expect(callerHead).not.toBe(targetHead);
    expect(typeof readHead).toBe("function");
    expect(
      await readHead(flight(), createAssemblyProviders(caller), target),
    ).toBe(targetHead);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
