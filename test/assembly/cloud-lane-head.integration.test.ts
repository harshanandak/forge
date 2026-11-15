import { expect, mock, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import * as coordinator from "../../src/assembly/cloud-lane-coordinator.ts";
import * as laneState from "../../src/blocks/work/bound-lane-state.ts";
import * as scopedGit from "../../src/assembly/providers.ts";
import workBlock from "../../src/blocks/work/entry.cts";
import { createProcessPort } from "../../src/adapters/process/index.ts";
import {
  exerciseGitScope,
  gitScopeRows,
  type ScopedGitApi,
  persistedRootsFixture,
  withoutGuard,
  launchSavedGit,
} from "./cloud-fixture.ts";
import {
  createAssemblyProviders,
  createProcessService,
  type AssemblyProviders,
} from "../../src/assembly/providers.ts";
import type { Preflight } from "../../src/core/runtime/index.ts";
import type { ProcessPort } from "../../src/ports/process.ts";
setDefaultTimeout(30000);

for (const removed of [false, true])
  test(`Skip-reopen-equality, loaded counterfactual=${removed}`, async () => {
    const f = persistedRootsFixture();
    try {
      mkdirSync(join(f.project, "lane"));
      rmSync(f.alias, { recursive: true });
      symlinkSync(
        f.project,
        f.alias,
        process.platform === "win32" ? "junction" : "dir",
      );
      const api = removed
        ? await withoutGuard<typeof scopedGit>(
            new URL("../../src/assembly/providers.ts", import.meta.url),
            /relative\(realpathSync.native\(pair.lexical\), pair.real\) === ""/g,
            "true",
          )
        : scopedGit;
      if (removed) expect(Reflect.get(api, "mutationLoaded")).toBe(true);
      const before = f.snapshot();
      const launch = launchSavedGit(f, f.scope, api);
      if (removed) expect((await launch).exitCode).toBe(0);
      else
        await expect(launch).rejects.toMatchObject({
          error: { code: "INPUT_CONFLICT" },
        });
      expect(existsSync(f.marker)).toBe(false);
      expect(f.snapshot()).toEqual(before);
    } finally {
      f.close();
    }
  });

for (const invalid of [
  null,
  {},
  { project: { lexical: "/project", real: "/project" } },
])
  test(`strict clone registry refuses malformed saved roots: ${JSON.stringify(invalid)}`, async () => {
    const f = persistedRootsFixture();
    let files: Awaited<ReturnType<AssemblyProviders["openFiles"]>> | undefined;
    try {
      const registry = join(f.project, ".git", "forge-lanes.json");
      writeFileSync(
        registry,
        JSON.stringify([
          {
            issue: "work-1",
            worktree: f.target,
            branch: "feat/one",
            brief: "brief.md",
            gitScope: invalid,
          },
        ]),
      );
      const before = [readFileSync(registry).toString("hex"), ...f.snapshot()];
      files = await createAssemblyProviders(f.project, {
        env: f.env,
      }).openFiles({
        op: "registry.read",
        effects: ["files:read"],
        signal: AbortSignal.timeout(15000),
        deadline: Date.now() + 15000,
        processContainment: "supervised",
      });
      const read = Reflect.get(workBlock, "laneRegistry") as (
        files: unknown,
        fail: (code: string) => never,
      ) => unknown;
      expect(() =>
        read(files!.value, (code) => {
          throw new Error(code);
        }),
      ).toThrow("INPUT_INVALID");
      expect([readFileSync(registry).toString("hex"), ...f.snapshot()]).toEqual(
        before,
      );
      expect(existsSync(f.marker)).toBe(false);
    } finally {
      await files?.close();
      f.close();
    }
  });

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
      diagnostic: !accepted,
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

for (const consumer of ["system Git", "clone refusal", "head refusal"] as const)
  test(`platform temp checkout: ${consumer}, including macOS var aliases`, async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-system-git-"));
    let files;
    try {
      writeFileSync(join(root, "input"), "unchanged");
      for (const command of [
        "init -q -b main",
        "add input",
        "-c user.name=Fixture -c user.email=fixture@example.test commit -qm fixture",
      ]) {
        const result = spawnSync(trusted, ["-C", root, ...command.split(" ")], {
          encoding: "utf8",
          windowsHide: true,
        });
        expect(result.status, result.stderr).toBe(0);
      }
      const refused = consumer !== "system Git";
      const marker = join(root, "git-ran");
      writeFileSync(
        join(root, process.platform === "win32" ? "git.cmd" : "git"),
        process.platform === "win32"
          ? "@echo off\r\necho ran>git-ran\r\n"
          : "#!/bin/sh\nprintf ran > git-ran\n",
        { mode: 0o755 },
      );
      const before = () =>
        ["input", ".git/HEAD", ".git/index", ".git/refs/heads/main"].map(
          (path) => readFileSync(join(root, path)).toString("hex"),
        );
      const bytes = before();
      const launches = mock<ProcessPort["run"]>(() => {
        throw new Error("Refused Git must not launch");
      });
      const denied = { ...createProcessPort(), run: launches };
      const env = {
        PATH: refused ? root : dirname(trusted),
        PATHEXT: refused ? ".CMD" : (process.env.PATHEXT ?? ".EXE"),
        SystemRoot: process.env.SystemRoot ?? "",
      };
      const providers = createAssemblyProviders(
        root,
        { env },
        refused ? denied : undefined,
      );
      const scope = {
        op: "temp-checkout.read",
        effects: ["files:read"],
        signal: AbortSignal.timeout(10000),
        deadline: Date.now() + 10000,
        processContainment: "supervised" as const,
      };
      if (refused) {
        await expect(
          consumer === "clone refusal"
            ? providers.openFiles(scope)
            : readHead(flight(), providers, root),
        ).rejects.toMatchObject({ error: { code: "UNAVAILABLE" } });
        expect(launches).not.toHaveBeenCalled();
        expect(existsSync(marker)).toBe(false);
        expect(before()).toEqual(bytes);
        return;
      }
      files = await providers.openFiles(scope);
      expect(files.value.root).toBe(realpathSync.native(root));
      expect(files.value.read("input", 32)).toBe("unchanged");
    } finally {
      await files?.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

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
  "deleted lane root",
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
      const deleted = variant === "deleted lane root";
      if (deleted) rmSync(target, { recursive: true });
      expect(typeof readHead).toBe("function");
      const effects =
        variant === "process effect"
          ? ["environment:read"]
          : variant === "environment effect"
            ? ["external:process"]
            : undefined;
      const expected =
        variant === "no trusted git" || deleted
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
        expected === "UNAVAILABLE" || variant.endsWith("effect")
          ? 0
          : variant === "fresh read"
            ? 2
            : 1,
      );
      expect(files).not.toHaveBeenCalled();
      if (deleted) expect(existsSync(target)).toBe(false);
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
