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
import { runCli } from "../../src/surface/cli.ts";
import { done, stageBlock } from "../blocks/memory/lib.ts";

setDefaultTimeout(30_000);

async function fixture(workEnabled: boolean) {
  const folder = mkdtempSync(join(tmpdir(), "forge-prefix-on-demand-"));
  const root = join(folder, "project");
  mkdirSync(join(root, ".forge"), { recursive: true });
  const trace = join(folder, "git-trace.jsonl");
  writeFileSync(trace, "");
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
        ...(workEnabled ? { work: { source: { builtin: "forge/work" } } } : {}),
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
  let originFails = false;
  const createProcess = processAdapter.createProcessPort;
  const processes = spyOn(
    processAdapter,
    "createProcessPort",
  ).mockImplementation((options) => {
    const port = createProcess(options);
    return {
      ...port,
      run(executable, args, options) {
        if (
          originFails &&
          JSON.stringify(args) ===
            JSON.stringify(["config", "--get", "remote.origin.url"])
        )
          return port.run(
            { kind: "resolved", path: process.execPath },
            ["-e", "process.exit(2)"],
            options,
          );
        return port.run(executable, args, options);
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
      failOrigin(value: boolean) {
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
        expect(result.exitCode, JSON.stringify(result.envelope)).toBe(0);
        return done(result.envelope);
      },
      resetTrace: () => writeFileSync(trace, ""),
      originQueries() {
        return readFileSync(trace, "utf8")
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { event: string; argv?: string[] })
          .filter(
            (event) =>
              event.event === "start" &&
              JSON.stringify(event.argv?.slice(-3)) ===
                JSON.stringify(["config", "--get", "remote.origin.url"]),
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
    expect(found.hits.map((hit) => hit.id)).toContain(added.id);
    expect(project.originQueries()).toBe(0);

    project.resetTrace();
    const shown = (await project.call(["config", "show"])) as {
      values: unknown[];
      effective: { blocks: { work: { config: { idPrefix: string } } } };
    };
    expect(shown.values).toContainEqual({
      pointer: "/blocks/work/config/idPrefix",
      value: "alpha",
      layer: "derived",
      origin: {
        detector: "project.detect",
        note: "the origin remote's repository name",
      },
      active: true,
    });
    expect(shown.effective.blocks.work.config.idPrefix).toBe("alpha");
    expect(project.originQueries()).toBe(1);
  } finally {
    await project.close();
  }
});

test("a missing origin uses the folder prefix and records the folder note", async () => {
  const project = await fixture(true);
  try {
    project.git("remote", "remove", "origin");
    const shown = (await project.call(["config", "show"])) as {
      values: unknown[];
    };
    expect(shown.values).toContainEqual({
      pointer: "/blocks/work/config/idPrefix",
      value: "project",
      layer: "derived",
      origin: { detector: "project.detect", note: "the project folder's name" },
      active: true,
    });
    expect(
      await project.call(["issue", "create", "--title", "Folder"]),
    ).toMatchObject({ id: "project-1" });
  } finally {
    await project.close();
  }
});

test("a failed origin lookup refuses before minting and a later call reads the origin", async () => {
  const project = await fixture(true);
  try {
    project.failOrigin(true);
    expect(
      await project.invoke("issue.create", { title: "Must not mint" }),
    ).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE", retry: "safe" },
    });
    project.failOrigin(false);
    expect(
      await project.call(["issue", "create", "--title", "Recovered"]),
    ).toMatchObject({ id: "alpha-1" });
    expect(done(await project.invoke("issue.list"))).toMatchObject({
      items: [{ id: "alpha-1", title: "Recovered" }],
    });
  } finally {
    await project.close();
  }
});

test("a device memory call still succeeds when origin lookup would fail", async () => {
  const project = await fixture(false);
  try {
    project.failOrigin(true);
    project.resetTrace();
    expect(
      await project.call(["memory", "search", "heron", "--level", "device"]),
    ).toMatchObject({ hits: [] });
    expect(project.originQueries()).toBe(0);
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
    ).toMatchObject({
      id: "harsha/delivery",
      imported: null,
    });
    expect(project.originQueries()).toBe(1);

    project.resetTrace();
    expect(await project.invoke("memory.serach")).toMatchObject({
      ok: false,
      error: { code: "UNKNOWN_COMMAND" },
    });
    expect(project.originQueries()).toBe(1);
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
    ).toMatchObject({
      id: "alpha-1",
    });
    expect(project.originQueries()).toBe(1);
    project.git(
      "remote",
      "set-url",
      "origin",
      "https://example.invalid/team/Beta.git",
    );
    project.resetTrace();
    expect(
      await project.call(["issue", "create", "--title", "Second"]),
    ).toMatchObject({
      id: "beta-2",
    });
    expect(project.originQueries()).toBe(1);
  } finally {
    await project.close();
  }
});
