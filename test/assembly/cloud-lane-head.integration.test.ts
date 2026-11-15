import { expect, mock, setDefaultTimeout, test } from "bun:test";
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
import * as laneState from "../../src/blocks/work/bound-lane-state.ts";
import * as scopedGit from "../../src/assembly/providers.ts";
import {
  exerciseGitScope,
  gitScopeRows,
  type ScopedGitApi,
} from "./cloud-fixture.ts";
import {
  createAssemblyProviders,
  createProcessService,
  type AssemblyProviders,
} from "../../src/assembly/providers.ts";
import type { Preflight } from "../../src/core/runtime/index.ts";
import type { ProcessPort } from "../../src/ports/process.ts";
setDefaultTimeout(30000);

for (const row of gitScopeRows)
  test(`scoped git capability: ${row}`, async () => {
    const api = scopedGit as unknown as ScopedGitApi;
    expect(typeof api.gitCapability).toBe("function");
    const result = await exerciseGitScope(row, api);
    const accepted = [
      "unrelated repository",
      "plain checkout",
      "relative and empty",
    ].includes(row);
    expect(result).toEqual({
      kind: accepted ? "resolved" : "unavailable",
      launched: accepted,
      projectRan: false,
      externalRan: accepted,
      relativeRan: false,
      unchanged: true,
    });
  }, 30000);

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

test("attached head shares the journal's full-head validator", () => {
  const validate = (
    laneState as unknown as { validBoundHead: (head: unknown) => boolean }
  ).validBoundHead;
  expect(typeof validate).toBe("function");
  for (const [head, valid] of [
    [H1, true],
    ["a".repeat(64), true],
    ["A".repeat(40), false],
    ["a".repeat(39), false],
    [undefined, false],
  ] as const)
    expect(validate(head)).toBe(valid);
}, 30000);

for (const variant of [
  "trusted lookup",
  "nested caller",
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
    const root = mkdtempSync(join(import.meta.dirname, ".forge-bound-head-"));
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
    const nested = variant === "nested caller";
    const processRoot = nested ? join(caller, "src") : caller;
    const callerBin = nested ? join(caller, "bin") : caller;
    if (nested) {
      for (const path of [processRoot, callerBin, join(caller, ".git")])
        mkdirSync(path);
      writeFileSync(
        join(callerBin, process.platform === "win32" ? "git.exe" : "git"),
        "sibling-controlled executable",
        { mode: 0o755 },
      );
    }
    const env = {
      PATH: [
        callerBin,
        target,
        ...(variant === "no trusted git" ? [] : [dirname(trusted)]),
      ].join(delimiter),
      PATHEXT: process.env.PATHEXT ?? ".EXE;.CMD",
      SystemRoot: process.env.SystemRoot ?? "",
      GIT_DIR: "must-not-reach-git",
    };
    const native = createAssemblyProviders(processRoot, { env });
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
          processRoot,
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
}, 30000);
