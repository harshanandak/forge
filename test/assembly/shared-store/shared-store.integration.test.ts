// [integration] Real git worktrees: every worktree of one repository reads and writes one project store.
import {
  afterAll,
  beforeAll,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import {
  cpSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { createProcessPort } from "../../../src/adapters/process/index.ts";
import { createAssembly, type Assembly } from "../../../src/assembly/index.ts";
import { blockCapture } from "../../../src/assembly/capture.ts";
import { firstPartyBlocks } from "../../../src/assembly/first-party.ts";
import { idPrefixObservation } from "../../../src/assembly/providers.ts";
import type { ResultEnvelope } from "../../../src/generated/types.ts";
import { stageBlock } from "../../blocks/memory/lib.ts";

setDefaultTimeout(60_000);

const source = resolve(import.meta.dirname, "../../../src/blocks/work");
const processPort = createProcessPort({
  supervision: {
    cleanupTimeoutMs: 5000,
    pollIntervalMs: 25,
    drainTimeoutMs: 250,
    maxConcurrent: 1,
  },
});
const env: Record<string, string> = {};
for (const [name, value] of Object.entries(process.env))
  if (value !== undefined && !/^GIT_/i.test(name)) env[name] = value;

async function git(cwd: string, ...args: string[]): Promise<void> {
  const found = processPort.resolve("git", env);
  if (found.kind !== "resolved") throw new Error("git is not installed");
  // Byte-identical checkouts keep the admitted block digest the same in both trees.
  const identity = ["-c", "user.name=Forge Test", "-c", "core.autocrlf=false"];
  const result = await processPort.run(
    found,
    [...identity, "-c", "user.email=test@example.invalid", ...args],
    { cwd, env, timeoutMs: 30_000, maxOutputBytes: 1_000_000 },
  );
  if (result.exitCode !== 0)
    throw new Error(`git ${args[0]}: ${result.stderr}`);
}

let work: string;
let seq = 0;
const opened: Assembly[] = [];
async function open(root: string, childEnv?: Readonly<Record<string, string>>) {
  const assembly = await createAssembly({
    root,
    deviceRoot: join(work, "device"),
    ...(childEnv ? { providers: { env: childEnv } } : {}),
  });
  opened.push(assembly);
  return async (
    op: string,
    input: unknown,
    caller: "agent" | "human" = "agent",
    leaseGeneration?: number,
  ) => {
    const actor = {
      kind: caller,
      id: caller === "agent" ? "agent-one" : "tester",
    };
    return assembly.catalog.invoke({
      schemaVersion: "forge.invocation/1",
      requestId: `shared-${++seq}`,
      op,
      input,
      caller,
      context: {
        actor,
        session: { id: `s-${root}` },
        project: { id: root, root },
        device: { id: assembly.deviceRoot },
        ...(leaseGeneration === undefined ? {} : { leaseGeneration }),
      },
    });
  };
}
function done(result: ResultEnvelope): Record<string, unknown> {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.result as Record<string, unknown>;
}
/** Enable the work block in `root`: staged bytes, bound to project state, admitted and granted. */
async function enableWork(root: string): Promise<void> {
  const target = join(root, "blocks/work");
  cpSync(source, target, {
    recursive: true,
    filter: (path) => !path.endsWith(".cts"),
  });
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  writeFileSync(
    join(target, "entry.cjs"),
    transpiler.transformSync(readFileSync(join(source, "entry.cts"), "utf8")),
  );
  const call = await open(root);
  const { revision } = done(await call("config.show", {}, "human"));
  const value = { source: { path: "./blocks/work" }, bind: { state: "core" } };
  done(
    await call(
      "config.apply",
      {
        expectRevision: revision,
        patch: [{ op: "set", path: "/blocks/work", value }],
      },
      "human",
    ),
  );
  expect(parse(readFileSync(join(root, ".forge/config.yaml"), "utf8"))).toEqual(
    {
      schemaVersion: "forge.config/1",
      blocks: { work: value },
    },
  );
  const { digest } = done(
    await call("block.check", { path: "./blocks/work" }, "human"),
  );
  done(await call("block.admit", { digest }, "human"));
  done(
    await call(
      "config.grant",
      {
        digest,
        effects: [
          "issue:write",
          "external:process",
          "external:network",
          "environment:read",
        ],
      },
      "human",
    ),
  );
}

let main: string;
let linked: string;
let capture: ReturnType<typeof spyOn<typeof blockCapture, "open">>;
beforeAll(async () => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "forge-shared-")));
  // Source assemblies need the compiled builtin that the installed package already ships.
  const staged = stageBlock("memory", join(work, "builtins"));
  const memory = fileURLToPath(firstPartyBlocks["forge/memory"]!);
  const open = blockCapture.open.bind(blockCapture);
  capture = spyOn(blockCapture, "open").mockImplementation((path) =>
    open(path === memory ? staged : path),
  );
  main = join(work, "repo");
  linked = join(work, "linked");
  mkdirSync(main);
  await git(main, "init", "--quiet");
  await enableWork(main);
  await git(main, "add", ".forge/config.yaml", "blocks");
  await git(main, "commit", "--quiet", "-m", "project");
  await git(main, "worktree", "add", "--quiet", linked);
}, 120_000);
afterAll(async () => {
  for (const assembly of opened) await assembly.close();
  capture.mockRestore();
  rmSync(work, { recursive: true, force: true });
}, 60_000);

test("an issue made in the main checkout is visible and claimable from a linked worktree", async () => {
  const fromMain = await open(main);
  const fromLinked = await open(linked);
  const created = done(await fromMain("issue.create", { title: "Shared" }));
  expect(done(await fromLinked("issue.show", { id: created.id })).title).toBe(
    "Shared",
  );
  done(await fromLinked("issue.claim", { id: created.id, ttlSeconds: 60 }));
  // The worktree's claim is held for the main checkout too.
  const ready = done(await fromMain("issue.ready", {})) as {
    items: { id: string }[];
  };
  expect(ready.items.map((item) => item.id)).not.toContain(created.id);
  expect(existsSync(join(linked, ".forge/state.sqlite"))).toBe(false);
}, 60_000);

test("the shared project's name stays stable when opened from differently named worktrees", async () => {
  const fromMain = await open(main);
  const fromLinked = await open(linked);
  const observer = await open(work);
  for (const call of [fromMain, fromLinked]) {
    const { revision } = done(await call("config.show", {}, "human"));
    done(
      await call(
        "config.apply",
        {
          expectRevision: revision,
          patch: [
            {
              op: "set",
              path: "/blocks/memory",
              value: { source: { builtin: "forge/memory" } },
            },
          ],
        },
        "human",
      ),
    );
  }
  let projectId: string | undefined;
  for (const call of [fromMain, fromLinked, fromMain]) {
    const added = done(
      await call("memory.add", { text: "stable-name heron", level: "project" }),
    ) as {
      id: string;
      note: { origin: { project: { id: string; name: string } } };
    };
    projectId ??= added.note.origin.project.id;
    const identity = { id: projectId, name: "repo" };
    expect(added.note.origin.project).toEqual(identity);
    for (const read of [fromMain, fromLinked]) {
      const shown = done(await read("memory.show", { id: added.id }));
      expect(shown).toMatchObject({ note: { origin: { project: identity } } });
    }
    const pulled = done(
      await observer("memory.search", {
        query: "stable-name heron",
        projects: ["repo"],
      }),
    ) as {
      hits: { id: string; origin: { project: { id: string; name: string } } }[];
    };
    expect(pulled.hits.map((hit) => hit.id)).toContain(added.id);
    expect(pulled.hits.every((hit) => hit.origin.project.name === "repo")).toBe(
      true,
    );
  }
}, 60_000);

test("linked worktree memory pointer scope uses the normalized shared checkout name", async () => {
  const shared = join(work, "Shared-Proj");
  const lane = join(work, "Scoped-Lane");
  mkdirSync(join(shared, ".forge"), { recursive: true });
  writeFileSync(
    join(shared, ".forge/config.yaml"),
    JSON.stringify({
      schemaVersion: "forge.config/1",
      blocks: { memory: { source: { builtin: "forge/memory" } } },
    }),
  );
  await git(shared, "init", "--quiet");
  await git(shared, "add", ".forge/config.yaml");
  await git(shared, "commit", "--quiet", "-m", "project");
  await git(shared, "worktree", "add", "--quiet", lane);
  const fromMain = await open(shared);
  const fromLane = await open(lane);
  const added = done(
    await fromLane("memory.add", {
      text: "Keep the registered project name",
      level: "project",
    }),
  ) as { note: { origin: { project: { name: string } } } };
  expect(added.note.origin.project.name).toBe("Shared-Proj");
  for (const scope of ["shared-proj", "scoped-lane"])
    done(
      await fromMain("memory.add", {
        text: `Device rule for ${scope}`,
        level: "device",
        scope,
        tags: ["rule"],
      }),
    );
  const loaded = done(await fromLane("memory.rules", {})) as {
    text: { text: string };
  };
  expect(loaded.text.text).toContain("shared-proj 2");
  expect(loaded.text.text).not.toContain("scoped-lane");
  expect(loaded.text.text).not.toContain("Device rule for");
  expect(existsSync(join(lane, ".forge/state.sqlite"))).toBe(false);
  const aliases = join(work, "device", "memory-scopes.json");
  writeFileSync(
    aliases,
    JSON.stringify({
      "shared-proj": "shared-alias",
      "scoped-lane": "wrong-alias",
    }),
  );
  try {
    for (const call of [fromMain, fromLane]) {
      expect(done(await call("memory.scope", {}))).toEqual({
        scope: "shared-alias",
      });
      const rules = done(await call("memory.rules", {})) as {
        text: { text: string };
      };
      expect(rules.text.text).toContain("shared-alias 1");
      expect(rules.text.text).not.toContain("wrong-alias");
    }
  } finally {
    rmSync(aliases);
  }
}, 60_000);

test("an agent cannot use land's old close reason to bypass the receipt requirement", async () => {
  const call = await open(main);
  const { id } = done(await call("issue.create", { title: "Receipt bypass" }));
  const { generation } = done(
    await call("issue.claim", { id, ttlSeconds: 60 }),
  );
  const result = await call(
    "issue.close",
    { id, reason: "merged in abc" },
    "agent",
    generation as number,
  );
  expect(result).toMatchObject({
    ok: false,
    error: { code: "RECEIPT_REQUIRED" },
  });
  expect(done(await call("issue.show", { id }))).toMatchObject({
    status: "open",
  });
}, 60_000);

test("both checkouts can write at once and each sees the other's issues", async () => {
  const fromMain = await open(main);
  const fromLinked = await open(linked);
  const made = await Promise.all([
    ...[1, 2, 3].map((n) => fromMain("issue.create", { title: `main ${n}` })),
    ...[1, 2, 3].map((n) =>
      fromLinked("issue.create", { title: `linked ${n}` }),
    ),
  ]);
  for (const result of made) {
    const { id } = done(result);
    done(await fromMain("issue.show", { id }));
    done(await fromLinked("issue.show", { id }));
  }
}, 60_000);

test("config is still read from the worktree itself", async () => {
  const fromLinked = await open(linked);
  const { revision } = done(await fromLinked("config.show", {}, "human"));
  const patch = [{ op: "set", path: "/mcp", value: { expose: ["issue"] } }];
  done(
    await fromLinked(
      "config.apply",
      { expectRevision: revision, patch },
      "human",
    ),
  );
  expect(readFileSync(join(linked, ".forge/config.yaml"), "utf8")).toContain(
    "expose",
  );
  expect(readFileSync(join(main, ".forge/config.yaml"), "utf8")).not.toContain(
    "expose",
  );
}, 60_000);

test("a git submodule keeps its store in its own folder", async () => {
  // A submodule's `.git` is a file too, but it is not a linked worktree of the superproject.
  const library = join(work, "library");
  const superproject = join(work, "super");
  mkdirSync(library);
  mkdirSync(superproject);
  await git(library, "init", "--quiet");
  writeFileSync(join(library, "README"), "library\n");
  await git(library, "add", "README");
  await git(library, "commit", "--quiet", "-m", "library");
  await git(superproject, "init", "--quiet");
  await git(
    superproject,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "--quiet",
    library,
    "sub",
  );
  const submodule = join(superproject, "sub");
  await enableWork(submodule);
  const call = await open(submodule);
  done(await call("issue.create", { title: "In the submodule" }));
  expect(existsSync(join(submodule, ".forge/state.sqlite"))).toBe(true);
}, 60_000);

test("issue ids carry the repository's name in every worktree, and earlier names keep resolving", async () => {
  // No remote yet: the main checkout's folder names the project, even from the linked worktree.
  const fromLinked = await open(linked);
  const before = done(await fromLinked("issue.create", { title: "Named" }));
  expect(before.id).toMatch(/^repo-\d+$/);
  const number = String(before.id).slice("repo-".length);
  await git(
    main,
    "remote",
    "add",
    "origin",
    "https://example.invalid/o/Forge.git",
  );
  // The same long-lived assembly (an MCP server) follows the new origin on its next call.
  const after = done(await fromLinked("issue.create", { title: "Renamed" }));
  expect(after.id).toMatch(/^forge-\d+$/);
  expect(
    done(await fromLinked("issue.show", { id: `repo-${number}` })).id,
  ).toBe(`forge-${number}`);
  const foreign = await fromLinked("issue.show", { id: `scoreeasy-${number}` });
  expect(foreign.ok).toBe(false);
  expect(JSON.stringify(foreign)).toContain("Unknown id prefix scoreeasy");
}, 60_000);

test("overlapping catalog creates retain the origin prefix under supervisor contention", async () => {
  await git(
    main,
    "config",
    "remote.origin.url",
    "https://example.invalid/o/Forge.git",
  );
  const call = await open(main);
  const results = await Promise.all([
    call("issue.create", { title: "overlap one" }),
    call("issue.create", { title: "overlap two" }),
  ]);
  const ids = results.map((result) => done(result).id);
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(2);
  for (const id of ids) expect(id).toMatch(/^forge-\d+$/);
  // The next call still reads the actual origin.
  expect(
    done(await call("issue.create", { title: "after overlap" })).id,
  ).toMatch(/^forge-\d+$/);
}, 60_000);

test("zero process capacity cannot be mistaken for an absent origin", async () => {
  await expect(
    idPrefixObservation(main, main, {
      supervision: {
        cleanupTimeoutMs: 5000,
        pollIntervalMs: 25,
        drainTimeoutMs: 250,
        maxConcurrent: 0,
      },
    }),
  ).rejects.toMatchObject({
    error: { code: "PROCESS_LIMIT_EXCEEDED" },
  });
  expect(await idPrefixObservation(main, main)).toHaveLength(1);
}, 60_000);

test("a project outside git keeps its store in its own folder", async () => {
  const plain = join(work, "plain");
  mkdirSync(plain);
  await enableWork(plain);
  const call = await open(plain);
  done(await call("issue.create", { title: "Alone" }));
  expect(existsSync(join(plain, ".forge/state.sqlite"))).toBe(true);
}, 60_000);

test("assembled close verifies stored receipts and exposes no write capability", async () => {
  const fake = join(work, "close-gh");
  mkdirSync(fake);
  const node = processPort.resolve("node", env);
  if (node.kind !== "resolved") throw new Error("node is not installed");
  const response = join(fake, "response.json");
  const script = join(fake, "gh.mjs");
  writeFileSync(
    script,
    `import { readFileSync } from "node:fs";\nconsole.log(readFileSync(${JSON.stringify(response)}, "utf8"));\n`,
  );
  if (process.platform === "win32")
    writeFileSync(join(fake, "gh.cmd"), `@"${node.path}" "${script}" %*\r\n`);
  else {
    const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
    writeFileSync(
      join(fake, "gh"),
      `#!/bin/sh\nexec ${quote(node.path)} ${quote(script)} "$@"\n`,
    );
    chmodSync(join(fake, "gh"), 0o755);
  }
  const target = join(main, "quality");
  const checkSource = resolve(source, "../check");
  cpSync(checkSource, target, {
    recursive: true,
    filter: (path) => !path.endsWith(".cts"),
  });
  const operation = (effects: string[]) => ({
    input: "fixture.json",
    output: "fixture.json",
    context: "project",
    effects,
    idempotent: false,
    callers: ["human", "agent"],
    stability: "experimental",
    timeoutMs: 15000,
  });
  const manifest = JSON.parse(
    readFileSync(join(target, "forge.block.json"), "utf8"),
  ) as { requires: unknown[]; operations: Record<string, unknown> };
  manifest.requires.push({ slot: "receipts", interface: "forge.receipts@1" });
  manifest.operations["proof.store"] = operation(["proof:write"]);
  manifest.operations["proof.inspect"] = operation([]);
  writeFileSync(join(target, "forge.block.json"), JSON.stringify(manifest));
  const docs = JSON.parse(readFileSync(join(target, "docs.json"), "utf8")) as {
    operations: Record<string, unknown>;
  };
  for (const name of ["proof.store", "proof.inspect"])
    docs.operations[name] = {
      title: name,
      summary: "Exercise receipt binding.",
    };
  writeFileSync(join(target, "docs.json"), JSON.stringify(docs));
  writeFileSync(join(target, "fixture.json"), "{}");
  writeFileSync(
    join(target, "entry.cjs"),
    new Bun.Transpiler({ loader: "ts" }).transformSync(
      readFileSync(join(checkSource, "entry.cts"), "utf8"),
    ) +
      "\nObject.assign(module.exports,{'proof.store':({input,services})=>services.state.put('runs/'+input.id,input,{expectRevision:0}),'proof.inspect':({services})=>Object.keys(services.receipts)});",
  );
  const childEnv = Object.fromEntries(
    Object.entries(env).filter(([name]) => name.toLowerCase() !== "path"),
  );
  childEnv.PATH = [fake, env.PATH ?? env.Path ?? ""].join(delimiter);
  const call = await open(main, childEnv);
  const { revision } = done(await call("config.show", {}, "human"));
  done(
    await call(
      "config.apply",
      {
        expectRevision: revision,
        patch: [
          {
            op: "set",
            path: "/blocks/check",
            value: {
              source: { path: "./quality" },
              config: {
                commands: {
                  pass: { argv: ["git", "--version"] },
                  fail: { argv: ["git", "not-a-command"] },
                },
                report: "exit-code",
                inputs: ["quality/fixture.json"],
                environment: ["PATH", "PATHEXT", "SystemRoot", "TEMP", "TMP"],
              },
            },
          },
        ],
      },
      "human",
    ),
  );
  const { digest } = done(
    await call("block.check", { path: "./quality" }, "human"),
  );
  done(await call("block.admit", { digest }, "human"));
  done(
    await call(
      "config.grant",
      {
        digest,
        effects: [
          "proof:write",
          "check:write",
          "process:write",
          "external:process",
          "external:write",
          "files:read",
          "environment:read",
        ],
      },
      "human",
    ),
  );
  expect(await call("proof.inspect", {})).toMatchObject({
    ok: true,
    result: ["get"],
  });
  const pass = done(await call("check.run", { checks: ["pass"] }));
  writeFileSync(
    response,
    JSON.stringify({
      state: "MERGED",
      headRefOid: pass.subject,
      mergeCommit: { oid: "b".repeat(40) },
    }),
  );
  const failed = await call("check.run", { checks: ["fail"] });
  expect(failed).toMatchObject({ ok: false, status: "FAIL" });
  const failedReceipt = failed.result as { id: string };
  done(
    await call("proof.store", {
      ...pass,
      id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      reason: "tampered",
    }),
  );
  for (const receipt of [
    failedReceipt.id,
    "cccccccc-cccc-cccc-cccc-cccccccccccc",
    "unknown",
  ]) {
    const { id } = done(
      await call("issue.create", { title: "Refuse evidence" }),
    );
    const { generation } = done(await call("issue.claim", { id }));
    expect(
      await call("issue.close", { id, receipt }, "agent", generation as number),
    ).toMatchObject({ ok: false, error: { code: "RECEIPT_INVALID" } });
    expect(done(await call("issue.show", { id }))).toMatchObject({
      status: "open",
      revision: 1,
    });
  }
  const { id } = done(await call("issue.create", { title: "Delivered" }));
  const { generation } = done(await call("issue.claim", { id }));
  done(
    await call(
      "issue.link",
      {
        id,
        relation: "delivers",
        url: "https://github.com/example/repo/pull/1",
      },
      "agent",
      generation as number,
    ),
  );
  expect(
    done(
      await call(
        "issue.close",
        { id, receipt: pass.id },
        "agent",
        generation as number,
      ),
    ),
  ).toMatchObject({ status: "closed", receipt: pass.id });
  expect(done(await call("issue.show", { id }))).toMatchObject({
    status: "closed",
    receipt: pass.id,
  });
}, 120_000);

test("a linked worktree reports the missing shared store's canonical path", async () => {
  const fromLinked = await open(linked);
  const fromMain = await open(main);
  done(await fromMain("issue.create", { title: "Before store loss" }));
  const path = join(realpathSync.native(main), ".forge/state.sqlite");
  const backup = join(main, ".forge/state.saved");
  renameSync(path, backup);
  try {
    const result = await fromLinked("issue.list", {});
    expect(result).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE" },
    });
    if (result.ok) throw Error("Expected missing shared store");
    expect(result.error.message).toContain(path);
    expect(existsSync(join(linked, ".forge/state.sqlite"))).toBe(false);
  } finally {
    renameSync(backup, path);
  }
}, 60_000);
