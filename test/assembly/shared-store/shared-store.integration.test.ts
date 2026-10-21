// [integration] Real git worktrees: every worktree of one repository reads and writes one project store.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createProcessPort } from "../../../src/adapters/process/index.ts";
import { createAssembly, type Assembly } from "../../../src/assembly/index.ts";
import type { ResultEnvelope } from "../../../src/generated/types.ts";

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
async function open(root: string) {
  const assembly = await createAssembly({
    root,
    deviceRoot: join(work, "device"),
  });
  opened.push(assembly);
  return async (
    op: string,
    input: unknown,
    caller: "agent" | "human" = "agent",
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
  const { digest } = done(
    await call("block.check", { path: "./blocks/work" }, "human"),
  );
  done(await call("block.admit", { digest }, "human"));
  done(
    await call("config.grant", { digest, effects: ["issue:write"] }, "human"),
  );
}

let main: string;
let linked: string;
beforeAll(async () => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "forge-shared-")));
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

test("a project outside git keeps its store in its own folder", async () => {
  const plain = join(work, "plain");
  mkdirSync(plain);
  await enableWork(plain);
  const call = await open(plain);
  done(await call("issue.create", { title: "Alone" }));
  expect(existsSync(join(plain, ".forge/state.sqlite"))).toBe(true);
}, 60_000);
