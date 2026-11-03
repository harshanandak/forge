import { expect, spyOn, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStore } from "../../src/adapters/store-sqlite/index.ts";
import {
  openLevels,
  requireRegisteredStore,
} from "../../src/assembly/levels.ts";
import { LocalState } from "../../src/assembly/state.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import { loadEntry, memoryState } from "../blocks/memory/lib.ts";

const actor = { kind: "human" as const, id: "test" };
const oldId = "0123456789abcdef";
const registry = "forge/core-projects";

function denySavedPath(denied: string, touched: string[] = []) {
  const native = realpathSync.native;
  return spyOn(realpathSync, "native").mockImplementation(
    new Proxy(native, {
      apply(target, receiver, args: Parameters<typeof native>) {
        touched.push(String(args[0]));
        if (String(args[0]) === denied)
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        return Reflect.apply<
          unknown,
          Parameters<typeof native>,
          ReturnType<typeof native>
        >(target, receiver, args);
      },
    }),
  );
}

async function fixture() {
  const root = realpathSync.native(
    mkdtempSync(join(tmpdir(), "forge-registry-")),
  );
  const memory = () => new LocalState(":memory:", createSqliteStore(root));
  const device = memory();
  const owner = (await device.open(true))!;
  const project = memory();
  const open = (stateRoot: string, requestId = "test") =>
    openLevels({
      root: stateRoot,
      stateRoot,
      projectState: project,
      deviceState: device,
      namespace: "forge/test",
      actor,
      servesProject: true,
      caller: "human",
      write: true,
      requestId,
    });
  return {
    root,
    device,
    owner,
    project,
    open,
    async close() {
      await project.close();
      await device.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("two first project writes with overlapping registry reads both succeed", async () => {
  const f = await fixture();
  const first = f.open(f.root, "first");
  const second = f.open(f.root, "second");
  const entry = loadEntry("memory");
  const state = memoryState();
  const add = (opened: typeof first, text: string) =>
    entry["memory.add"]!({
      input: { text, level: "project" },
      services: { state, levels: opened.levels },
    });
  const get = f.owner.get.bind(f.owner);
  // Hold the second writer's absent read across the first writer's commit.
  const before = f.owner.list(registry);
  expect(before).toEqual([]);
  let reads: ReturnType<typeof spyOn<typeof f.owner, "get">> | undefined;
  try {
    const a = (await add(first, "first note")) as { id: string };
    reads = spyOn(f.owner, "get")
      .mockImplementation(get)
      .mockImplementationOnce((namespace, key) => {
        expect(namespace).toBe(registry);
        expect(key).toStartWith("project/");
        expect(get(namespace, key)?.revision).toBe(1);
        return before.find((record) => record.key === key);
      });
    const b = (await add(second, "second note")) as { id: string };
    reads.mockRestore();
    expect(a.id).not.toBe(b.id);
    expect(f.owner.list(registry)).toHaveLength(1);
    expect(f.owner.list(registry)[0]?.revision).toBe(1);
    const project = await first.levels.project();
    expect(
      project?.state
        .list("note/")
        .map((record) => (record.value as { text: string }).text),
    ).toEqual(["first note", "second note"]);
  } finally {
    reads?.mockRestore();
    await first.close();
    await second.close();
    await f.close();
  }
}, 30_000);

test("registration preserves a different winner and propagates other store failures", async () => {
  for (const kind of ["different winner", "store failure"] as const) {
    const f = await fixture();
    const opened = f.open(f.root);
    const put = f.owner.put.bind(f.owner);
    const failure = new ForgeFailure({
      code: "UNAVAILABLE",
      message: "injected store failure",
      retry: "never",
    });
    const writes = spyOn(f.owner, "put")
      .mockImplementation(put)
      .mockImplementationOnce((namespace, key, value, actor, options) => {
        if (kind === "store failure") throw failure;
        put(namespace, key, { name: "other", root: f.root }, actor, options);
        return put(namespace, key, value, actor, options);
      });
    try {
      if (kind === "store failure")
        await expect(opened.levels.project()).rejects.toBe(failure);
      else {
        await expect(opened.levels.project()).rejects.toMatchObject({
          error: { code: "REVISION_CONFLICT" },
        });
        expect(f.owner.list(registry)[0]?.value).toEqual({
          name: "other",
          root: f.root,
        });
      }
    } finally {
      writes.mockRestore();
      await opened.close();
      await f.close();
    }
  }
}, 30_000);

test("a fresh database never adopts a stale location's identity after the old project moved", async () => {
  const f = await fixture();
  const a = join(f.root, "a"),
    b = join(f.root, "b");
  mkdirSync(a);
  mkdirSync(b);
  // A still has stale evidence while the old database now lives at B.
  f.owner.put(registry, `project/${oldId}`, { name: "old", root: a }, actor, {
    expectRevision: 0,
  });
  const opened = f.open(a);
  try {
    const fresh = await opened.levels.project();
    expect(fresh).toBeDefined();
    expect(fresh?.identity.id).not.toBe(oldId);
    expect(f.owner.get(registry, `project/${oldId}`)?.value).toEqual({
      name: "old",
      root: a,
    });
  } finally {
    await opened.close();
    await f.close();
  }
}, 30_000);

test("unrelated inaccessible and malformed saved paths cannot block reads or first writes", async () => {
  const f = await fixture();
  const denied = join(f.root, "denied");
  f.owner.put(
    registry,
    `project/${oldId}`,
    { name: "other", root: denied },
    actor,
    { expectRevision: 0 },
  );
  f.owner.put(registry, "project/bad", { name: "bad", root: "\0" }, actor, {
    expectRevision: 0,
  });
  const touched: string[] = [];
  const spy = denySavedPath(denied, touched);
  const opened = f.open(f.root);
  try {
    await requireRegisteredStore(f.device, f.root);
    expect(await opened.levels.project()).toBeDefined();
    expect(touched).not.toContain(denied);
  } finally {
    spy.mockRestore();
    await opened.close();
    await f.close();
  }
}, 30_000);

test("a junction at an old recorded location cannot make a fresh location look established", async () => {
  const f = await fixture();
  const a = join(f.root, "a"),
    b = join(f.root, "b"),
    fresh = join(f.root, "fresh");
  mkdirSync(a);
  mkdirSync(fresh);
  f.owner.put(
    registry,
    `project/${oldId}`,
    { name: "old", root: realpathSync.native(a) },
    actor,
    { expectRevision: 0 },
  );
  renameSync(a, b);
  symlinkSync(fresh, a, process.platform === "win32" ? "junction" : "dir");
  try {
    await requireRegisteredStore(f.device, fresh);
    await requireRegisteredStore(f.device, a);
  } finally {
    await f.close();
  }
}, 30_000);

test("registration of a moved database does not resolve its previously recorded path", async () => {
  const f = await fixture();
  const denied = join(f.root, "denied");
  const project = (await f.project.open(true))!;
  project.put("forge/core-project", "identity", { id: oldId }, actor, {
    expectRevision: 0,
  });
  f.owner.put(
    registry,
    `project/${oldId}`,
    { name: "old", root: denied },
    actor,
    { expectRevision: 0 },
  );
  const spy = denySavedPath(denied);
  const opened = f.open(f.root);
  try {
    expect((await opened.levels.project())?.identity.id).toBe(oldId);
    expect(f.owner.get(registry, `project/${oldId}`)?.value).toMatchObject({
      root: f.root,
    });
  } finally {
    spy.mockRestore();
    await opened.close();
    await f.close();
  }
}, 30_000);
