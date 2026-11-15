import { expect, mock, setDefaultTimeout, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import * as coordinator from "../../src/assembly/cloud-lane-coordinator.ts";
import * as laneState from "../../src/blocks/work/bound-lane-state.ts";
import {
  createAssemblyProviders,
  createProcessService,
  type AssemblyProviders,
} from "../../src/assembly/providers.ts";
import type { Preflight } from "../../src/core/runtime/index.ts";
import type { ProcessPort } from "../../src/ports/process.ts";
import * as providerModule from "../../src/assembly/providers.ts";
import { withoutGuard } from "./cloud-fixture.ts";
import * as launch from "../../src/adapters/process/run.ts";
setDefaultTimeout(30000);

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
  "linked caller",
  "linked target",
  "linked clone files",
  "linked startup",
  "linked ancestor honest",
  "linked ancestor missing",
  "linked ancestor forged",
  "linked junction",
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
    const junction = variant === "linked junction";
    const outside = junction
      ? mkdtempSync(join(tmpdir(), "forge-linked-outside-"))
      : undefined;
    if (outside) symlinkSync(outside, join(root, ".worktrees"), "junction");
    const ancestor = junction || variant.startsWith("linked ancestor");
    const caller = ancestor
        ? join(root, ".worktrees", "lane")
        : join(root, "caller"),
      target = join(root, "target");
    for (const path of [caller, target]) {
      mkdirSync(path, { recursive: true });
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
    const linked = variant.startsWith("linked");
    const cloneLookup =
      ancestor || ["linked clone files", "linked startup"].includes(variant);
    const main = ancestor ? root : join(root, "main"),
      common = join(main, ".git"),
      gitdir =
        ancestor && !variant.endsWith("honest")
          ? join(caller, "fake-meta")
          : join(common, "worktrees", "lane");
    const linkedRoot = variant === "linked target" ? target : processRoot;
    const mainBin = join(main, "bin"),
      probe = join(root, "project-git-ran");
    const poison = join(
      mainBin,
      process.platform === "win32" ? "git.cmd" : "git",
    );
    if (linked) {
      if (variant === "linked target") mkdirSync(join(caller, ".git"));
      mkdirSync(gitdir, { recursive: true });
      if (ancestor) mkdirSync(common, { recursive: true });
      mkdirSync(mainBin);
      writeFileSync(join(linkedRoot, ".git"), `gitdir: ${gitdir}\n`);
      if (!variant.endsWith("missing")) {
        const elsewhere = join(root, "elsewhere");
        if (variant.endsWith("forged")) mkdirSync(elsewhere);
        writeFileSync(
          join(gitdir, "commondir"),
          variant.endsWith("forged") ? elsewhere : "../..\n",
        );
      }
      writeFileSync(
        poison,
        process.platform === "win32"
          ? `@echo off\r\necho ran>"${probe}"\r\nexit /b 99\r\n`
          : `#!/bin/sh\nprintf ran > '${probe.replace(/'/g, "'\\''")}'\nexit 99\n`,
        { mode: 0o755 },
      );
    }
    const env = {
      PATH: [
        ...(linked ? [mainBin] : []),
        callerBin,
        ...(cloneLookup ? [] : [target]),
        ...(variant === "no trusted git" ? [] : [dirname(trusted)]),
      ].join(delimiter),
      PATHEXT: process.env.PATHEXT ?? ".EXE;.CMD",
      SystemRoot: process.env.SystemRoot ?? "",
      GIT_DIR: "must-not-reach-git",
    };
    const native = createAssemblyProviders(processRoot, { env });
    const scope = {
      op: "lane.start",
      effects: ["files:read", "external:process"],
      signal: AbortSignal.timeout(30000),
      deadline: Date.now() + 30000,
      processContainment: "supervised" as const,
    };
    let attempts = 0;
    const runs = mock<ProcessPort["run"]>((_executable, _args, _options) => {
      attempts++;
      if (linked && _executable.path !== trusted)
        writeFileSync(probe, "untrusted Git was launched");
      const result = {
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
      };
      if (cloneLookup)
        result.stdout = `${variant === "linked startup" ? processRoot + "\n" : ""}${gitdir}\n${common}\n`;
      return Promise.resolve(result);
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
      if (variant === "linked startup") {
        const startup = spyOn(launch, "runProcess").mockImplementation(
          (executable, args, options) =>
            runs({ kind: "resolved", path: executable }, args, options),
        );
        try {
          expect(
            await providerModule.projectStateRoot(processRoot, { env }),
          ).toBe(main);
        } finally {
          startup.mockRestore();
        }
      } else if (ancestor || variant === "linked clone files") {
        const handle = await createAssemblyProviders(
          processRoot,
          { env },
          {
            capability: "forge.process/v1",
            resolve: (name, env) => native.process(scope).resolve(name, env),
            run: runs,
          },
        ).openFiles(scope);
        await handle.close();
      } else if (expected)
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
        if (!cloneLookup) {
          expect(args).toEqual(["rev-parse", "--verify", "HEAD"]);
          expect(options.cwd).toBe(target);
        }
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
      expect(existsSync(probe)).toBe(false);
      if (linked) {
        const mutant = await withoutGuard<typeof providerModule>(
          new URL("../../src/assembly/providers.ts", import.meta.url),
          /excluded.push\(ancestor\);|excluded.push\(basename\(common\)[^\n]+/g,
        );
        expect(mutant.mutationLoaded).toBe(true);
        expect(mutant.resolveOutside).not.toBe(providerModule.resolveOutside);
        const unsafe = mutant.resolveOutside(
          native.process(scope),
          "git",
          env,
          linkedRoot,
        );
        expect(unsafe).toMatchObject({
          kind: "resolved",
          path: realpathSync.native(poison),
        });
        if (unsafe.kind === "resolved")
          await runs(unsafe, [], runs.mock.calls[0]![2]);
        expect(existsSync(probe)).toBe(true);
      }
      expect(existsSync(join(caller, ".forge", "state.sqlite"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (outside) rmSync(outside, { recursive: true, force: true });
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
