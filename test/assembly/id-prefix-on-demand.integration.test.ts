// [integration] Real Git origin queries and isolated project/device stores.
import { expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssembly, localCall } from "../../src/assembly/index.ts";
import { blockCapture } from "../../src/assembly/capture.ts";
import { firstPartyBlocks } from "../../src/assembly/first-party.ts";
import * as processAdapter from "../../src/adapters/process/index.ts";
import type { ProcessResult } from "../../src/ports/process.ts";
import { result as processResult } from "../adapters/process/fake-process.ts";
import { runCli } from "../../src/surface/cli.ts";
import { done, stageBlock } from "../blocks/memory/lib.ts";

setDefaultTimeout(30_000);

type OriginFailure =
  | boolean
  | "missing-git"
  | "missing-warning"
  | "permanent"
  | "unparsable"
  | "timeout"
  | "signal"
  | "truncated"
  | "spawn"
  | "unexpected";

interface TraceEvent {
  event: string;
  sid?: string;
  time?: string;
  argv?: string[];
  code?: number;
}

interface OriginLookup {
  executable: string;
  elapsedMs: number;
  timeoutMs: number;
  exitCode: number | null;
  timedOut: boolean | null;
  signal: string | null;
  truncated: boolean | null;
  stdoutBytes: number | null;
  stderrFirstLine: string | null;
  errorCode: string | null;
  trace2: TraceEvent[];
  diagnostics?: ProcessResult["diagnostics"];
}

async function fixture(workEnabled: boolean, idPrefix?: string) {
  const folder = mkdtempSync(join(tmpdir(), "forge-prefix-on-demand-"));
  const root = join(folder, "project");
  mkdirSync(join(root, ".forge"), { recursive: true });
  const trace = join(folder, "git-trace.jsonl");
  writeFileSync(trace, "");
  const originLookups: OriginLookup[] = [];
  const originArgs = ["config", "--get", "remote.origin.url"];
  const isOrigin = (args: readonly string[]) =>
    JSON.stringify(args) === JSON.stringify(originArgs);
  function traceEvents(): TraceEvent[] {
    return readFileSync(trace, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TraceEvent);
  }
  const diagnostics = () => JSON.stringify({ originLookups });
  const env: Record<string, string> = {};
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "TEMP", "TMP"])
    if (process.env[name] !== undefined) env[name] = process.env[name]!;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = join(folder, "gitconfig");
  writeFileSync(env.GIT_CONFIG_GLOBAL, "");
  function git(...args: string[]) {
    const result = spawnSync("git", args, {
      cwd: root,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    if (result.error || result.status !== 0)
      throw new Error(result.error?.message ?? result.stderr);
  }
  git("init", "--quiet");
  git("remote", "add", "origin", "https://example.invalid/team/Alpha.git");
  writeFileSync(
    join(root, ".forge/config.yaml"),
    JSON.stringify({
      schemaVersion: "forge.config/1",
      blocks: {
        memory: { source: { builtin: "forge/memory" } },
        ...(workEnabled
          ? {
              work: {
                source: { builtin: "forge/work" },
                ...(idPrefix === undefined ? {} : { config: { idPrefix } }),
              },
            }
          : {}),
      },
    }),
  );
  const stages = new Map<string, string>();
  const builtins = join(folder, "builtins");
  const memory = fileURLToPath(firstPartyBlocks["forge/memory"]!);
  stages.set(memory, stageBlock("memory", builtins));
  if (workEnabled) {
    const source = fileURLToPath(firstPartyBlocks["forge/work"]!);
    const target = join(builtins, "work");
    cpSync(source, target, {
      recursive: true,
      filter: (path) => !path.endsWith(".cts"),
    });
    writeFileSync(
      join(target, "entry.cjs"),
      new Bun.Transpiler({ loader: "ts" }).transformSync(
        readFileSync(join(source, "entry.cts"), "utf8"),
      ),
    );
    stages.set(source, target);
  }
  const open = blockCapture.open.bind(blockCapture);
  const capture = spyOn(blockCapture, "open").mockImplementation((path) =>
    open(stages.get(path) ?? path),
  );
  let originFails: OriginFailure = false;
  const createProcess = processAdapter.createProcessPort;
  const processes = spyOn(
    processAdapter,
    "createProcessPort",
  ).mockImplementation((options) => {
    const port = createProcess(options);
    return {
      ...port,
      resolve(executable, env) {
        if (originFails === "missing-git" && executable === "git")
          return {
            kind: "unavailable",
            reason: "git missing",
            remedy: "Install git",
          };
        return port.resolve(executable, env);
      },
      async run(executable, args, options) {
        if (!isOrigin(args)) return port.run(executable, args, options);
        const started = performance.now();
        const traceOffset = traceEvents().length;
        let result: ProcessResult | undefined;
        let errorCode: string | null = null;
        try {
          result = await lookup();
          return result;
        } catch (error) {
          errorCode =
            error instanceof Error
              ? "code" in error
                ? String(error.code)
                : error.name
              : String(error);
          throw error;
        } finally {
          const events = traceEvents().slice(traceOffset);
          const sessions = new Set(
            events
              .filter(
                (event) =>
                  event.event === "start" &&
                  isOrigin(event.argv?.slice(-3) ?? []),
              )
              .map((event) => event.sid),
          );
          originLookups.push({
            executable: executable.path,
            elapsedMs: performance.now() - started,
            timeoutMs: options.timeoutMs,
            exitCode: result?.exitCode ?? null,
            timedOut: result?.timedOut ?? null,
            signal: result?.signal ?? null,
            truncated: result?.truncated ?? null,
            stdoutBytes:
              result === undefined ? null : Buffer.byteLength(result.stdout),
            stderrFirstLine: result?.stderr.split(/\r?\n/, 1)[0] ?? null,
            errorCode,
            ...(result?.diagnostics === undefined
              ? {}
              : { diagnostics: result.diagnostics }),
            trace2: events.filter(
              (event) =>
                sessions.has(event.sid) &&
                (event.event === "start" || event.event === "exit"),
            ),
          });
        }

        async function lookup() {
          if (!originFails) return port.run(executable, args, options);
          if (originFails === "unexpected")
            throw new Error("prefix provider failed");
          if (
            originFails === "timeout" ||
            originFails === "signal" ||
            originFails === "truncated"
          )
            return Promise.resolve(
              processResult({
                exitCode: originFails === "truncated" ? 0 : null,
                timedOut: originFails === "timeout",
                truncated: originFails === "truncated",
                signal: originFails === "signal" ? "SIGTERM" : null,
              }),
            );
          if (originFails === "spawn")
            throw new processAdapter.ProcessSpawnError(
              "SPAWN_FAILED",
              "git cannot start",
            );
          if (originFails === "unparsable")
            return Promise.resolve(
              processResult({
                stdout: "///",
                stderr: "  invalid origin\nsecond line",
              }),
            );
          const script =
            originFails === "permanent"
              ? "process.stderr.write('  fatal: dubious\\u0007 ownership  \\r\\nsecond line\\n');process.exit(128)"
              : originFails === "missing-warning"
                ? "process.stderr.write('unrelated warning');process.exit(1)"
                : "process.exit(2)";
          return port.run(
            { kind: "resolved", path: process.execPath },
            ["-e", script],
            options,
          );
        }
      },
    };
  });
  try {
    const assembly = await createAssembly({
      root,
      deviceRoot: join(folder, "device"),
      providers: { env: { ...env, GIT_TRACE2_EVENT: trace } },
    });
    return {
      git,
      diagnostics,
      failOrigin(value: OriginFailure) {
        originFails = value;
      },
      invoke(op: string, input: unknown = {}) {
        const { caller, context } = localCall(assembly);
        return assembly.catalog.invoke({
          schemaVersion: "forge.invocation/1",
          requestId: `prefix-fixture-${op}`,
          op,
          input,
          caller,
          context: context ?? {},
        });
      },
      async call(args: string[]) {
        const result = await runCli(
          assembly.catalog,
          args,
          localCall(assembly),
        );
        expect(
          result.exitCode,
          `${JSON.stringify(result.envelope)} ${diagnostics()}`,
        ).toBe(0);
        return done(result.envelope);
      },
      resetTrace() {
        writeFileSync(trace, "");
        originLookups.length = 0;
      },
      originQueries() {
        return traceEvents().filter(
          (event) =>
            event.event === "start" && isOrigin(event.argv?.slice(-3) ?? []),
        ).length;
      },
      async close() {
        try {
          await assembly.close();
        } finally {
          processes.mockRestore();
          capture.mockRestore();
          rmSync(folder, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    processes.mockRestore();
    capture.mockRestore();
    rmSync(folder, { recursive: true, force: true });
    throw error;
  }
}

test("memory-only searches skip origin queries while config inspection keeps the derived prefix", async () => {
  const project = await fixture(false);
  try {
    const added = (await project.call([
      "memory",
      "add",
      "prefix heron",
      "--level",
      "device",
    ])) as {
      id: string;
    };
    project.resetTrace();
    const found = (await project.call([
      "memory",
      "search",
      "heron",
      "--level",
      "device",
    ])) as {
      hits: { id: string }[];
    };
    expect(
      found.hits.map((hit) => hit.id),
      project.diagnostics(),
    ).toContain(added.id);
    expect(project.originQueries(), project.diagnostics()).toBe(0);

    project.resetTrace();
    const shown = (await project.call(["config", "show"])) as {
      values: unknown[];
      effective: { blocks: { work: { config: { idPrefix: string } } } };
    };
    expect(shown.values, project.diagnostics()).toContainEqual({
      pointer: "/blocks/work/config/idPrefix",
      value: "alpha",
      layer: "derived",
      origin: {
        detector: "project.detect",
        note: "the origin remote's repository name",
      },
      active: true,
    });
    expect(
      shown.effective.blocks.work.config.idPrefix,
      project.diagnostics(),
    ).toBe("alpha");
    expect(project.originQueries(), project.diagnostics()).toBe(1);
  } finally {
    await project.close();
  }
});

test.each(["missing-origin", "missing-git", "missing-warning"] as const)(
  "%s uses the folder prefix and records the folder note",
  async (mode) => {
    const project = await fixture(true);
    try {
      if (mode === "missing-origin") project.git("remote", "remove", "origin");
      else project.failOrigin(mode);
      const shown = (await project.call(["config", "show"])) as {
        values: unknown[];
      };
      expect(shown.values, project.diagnostics()).toContainEqual({
        pointer: "/blocks/work/config/idPrefix",
        value: "project",
        layer: "derived",
        origin: {
          detector: "project.detect",
          note: "the project folder's name",
        },
        active: true,
      });
      expect(
        await project.call(["issue", "create", "--title", "Folder"]),
        project.diagnostics(),
      ).toMatchObject({ id: "project-1" });
    } finally {
      await project.close();
    }
  },
);

test.each([
  { mode: true, retry: "never", message: "git origin failed" },
  { mode: "permanent", retry: "never", message: "fatal: dubious ownership" },
  { mode: "unparsable", retry: "never", message: "invalid origin" },
  { mode: "timeout", retry: "safe", message: "git origin failed" },
  { mode: "signal", retry: "safe", message: "git origin failed" },
  { mode: "truncated", retry: "safe", message: "git origin failed" },
  { mode: "spawn", retry: "safe", message: "git cannot start" },
] satisfies { mode: OriginFailure; retry: string; message: string }[])(
  "origin failure $mode refuses with retry $retry before minting and later recovers",
  async ({ mode, retry, message }) => {
    const project = await fixture(true);
    try {
      project.failOrigin(mode);
      expect(
        await project.invoke("issue.create", { title: "Must not mint" }),
        project.diagnostics(),
      ).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", retry, message },
      });
      project.failOrigin(false);
      expect(
        await project.call(["issue", "create", "--title", "Recovered"]),
        project.diagnostics(),
      ).toMatchObject({ id: "alpha-1" });
      expect(
        done(await project.invoke("issue.list")),
        project.diagnostics(),
      ).toMatchObject({
        items: [{ id: "alpha-1", title: "Recovered" }],
      });
    } finally {
      await project.close();
    }
  },
);

test.each([false, true])(
  "a device memory call with work enabled=%s succeeds when origin lookup would fail",
  async (workEnabled) => {
    const project = await fixture(workEnabled);
    try {
      project.failOrigin("timeout");
      project.resetTrace();
      expect(
        await project.call(["memory", "search", "heron", "--level", "device"]),
        project.diagnostics(),
      ).toMatchObject({ hits: [] });
      expect(project.originQueries(), project.diagnostics()).toBe(0);
    } finally {
      await project.close();
    }
  },
);

test("an explicit project prefix keeps work available when origin lookup times out", async () => {
  const project = await fixture(true, "configured");
  try {
    project.failOrigin("timeout");
    expect(
      await project.call(["issue", "create", "--title", "Configured"]),
      project.diagnostics(),
    ).toMatchObject({ id: "configured-1" });
    expect(
      done(await project.invoke("issue.list")),
      project.diagnostics(),
    ).toMatchObject({
      items: [{ id: "configured-1", title: "Configured" }],
    });
  } finally {
    await project.close();
  }
});

test.each([undefined, "configured"])(
  "config show with prefix=%s warns when the derived prefix cannot be read",
  async (idPrefix) => {
    const project = await fixture(true, idPrefix);
    try {
      project.failOrigin("timeout");
      const result = await project.invoke("config.show");
      expect(result, project.diagnostics()).toMatchObject({ ok: true });
      expect(result.warnings, project.diagnostics()).toEqual([
        {
          code: "ID_PREFIX_UNAVAILABLE",
          message:
            "The id prefix could not be derived from the git origin: git origin failed",
        },
      ]);
      const shown = done(result) as {
        values: { pointer: string; layer: string; value: unknown }[];
        effective: { blocks: { work: { config: { idPrefix: string } } } };
      };
      expect(
        shown.values.filter(
          ({ pointer, layer }) =>
            pointer === "/blocks/work/config/idPrefix" && layer === "derived",
        ),
        project.diagnostics(),
      ).toEqual([]);
      expect(
        shown.effective.blocks.work.config.idPrefix,
        project.diagnostics(),
      ).toBe(idPrefix ?? "work");
      expect(
        done(await project.invoke("template.list")),
        project.diagnostics(),
      ).toHaveProperty("templates");
      project.failOrigin("permanent");
      const failed = await project.invoke("config.show");
      expect(failed, project.diagnostics()).toMatchObject({ ok: true });
      expect(failed.warnings, project.diagnostics()).toEqual([
        {
          code: "ID_PREFIX_UNAVAILABLE",
          message:
            "The id prefix could not be derived from the git origin: fatal: dubious ownership",
        },
      ]);
    } finally {
      await project.close();
    }
  },
);

test("config show propagates non-git prefix errors", async () => {
  const project = await fixture(true);
  try {
    project.failOrigin("unexpected");
    expect(
      await project.invoke("config.show"),
      project.diagnostics(),
    ).toMatchObject({
      ok: false,
      error: { code: "INTERNAL", message: "prefix provider failed" },
    });
  } finally {
    await project.close();
  }
});

test("memory-only projects keep host operations and unknown names on main's path", async () => {
  const project = await fixture(false);
  try {
    project.resetTrace();
    const listed = done(await project.invoke("template.list")) as {
      templates: { id: string; imported: string | null }[];
    };
    expect(
      listed.templates.find((template) => template.id === "harsha/delivery"),
      project.diagnostics(),
    ).toMatchObject({
      id: "harsha/delivery",
      imported: null,
    });
    expect(project.originQueries(), project.diagnostics()).toBe(1);

    project.resetTrace();
    expect(
      await project.invoke("memory.serach"),
      project.diagnostics(),
    ).toMatchObject({
      ok: false,
      error: { code: "UNKNOWN_COMMAND" },
    });
    expect(project.originQueries(), project.diagnostics()).toBe(1);
  } finally {
    await project.close();
  }
});

test("enabled work derives a fresh origin prefix on each issue create", async () => {
  const project = await fixture(true);
  try {
    project.resetTrace();
    expect(
      await project.call(["issue", "create", "--title", "First"]),
      project.diagnostics(),
    ).toMatchObject({
      id: "alpha-1",
    });
    expect(project.originQueries(), project.diagnostics()).toBe(1);
    project.git(
      "remote",
      "set-url",
      "origin",
      "https://example.invalid/team/Beta.git",
    );
    project.resetTrace();
    expect(
      await project.call(["issue", "create", "--title", "Second"]),
      project.diagnostics(),
    ).toMatchObject({
      id: "beta-2",
    });
    expect(project.originQueries(), project.diagnostics()).toBe(1);
  } finally {
    await project.close();
  }
});
