import { expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSqliteStore } from "../../src/adapters/store-sqlite/index.ts";
import { openLevels } from "../../src/assembly/levels.ts";
import {
  projectManifestRoot,
  projectStateRoot,
} from "../../src/assembly/providers.ts";
import { LocalState } from "../../src/assembly/state.ts";

const actor = { kind: "human" as const, id: "test" };
const IDENTITY = "forge/core-project";
const MANIFEST_ID = "5b0f3c1e-2a4d-4e8f-9a6b-7c1d2e3f4a5b";
const OTHER_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const manifest = (id = MANIFEST_ID) =>
  `${JSON.stringify({ schema: 1, id }, null, 2)}\n`;

function fixture() {
  const sandbox = realpathSync.native(
    mkdtempSync(join(tmpdir(), "forge-project-identity-")),
  );
  const memory = () => new LocalState(":memory:", createSqliteStore(sandbox));
  const device = memory();
  const stores: LocalState[] = [device];
  /** Each in-memory store is held open for the test; its data is gone once the last lease closes. */
  const checkout = async (name: string, committed?: string) => {
    const root = join(sandbox, name);
    mkdirSync(join(root, ".forge"), { recursive: true });
    if (committed !== undefined)
      writeFileSync(join(root, ".forge", "project.json"), committed);
    const state = memory();
    stores.push(state);
    await state.open(true);
    return { root, state };
  };
  const open = (
    where: { root: string; state: LocalState },
    options: {
      write?: boolean;
      stateRoot?: string;
      manifestRoot?: string;
    } = {},
  ) =>
    openLevels({
      root: where.root,
      ...(options.manifestRoot === undefined
        ? {}
        : { manifestRoot: options.manifestRoot }),
      stateRoot: options.stateRoot ?? where.root,
      projectState: where.state,
      deviceState: device,
      namespace: "forge/test",
      actor,
      servesProject: true,
      caller: "human",
      write: options.write ?? true,
      requestId: "test",
    });
  /** The project's identity as the store holds it, for checking what was recorded beside it. */
  const recorded = async (state: LocalState) =>
    (await state.open(true))?.get(IDENTITY, "identity");
  const projectOf = async (
    where: { root: string; state: LocalState },
    options?: { write?: boolean; stateRoot?: string; manifestRoot?: string },
  ) => {
    const opened = open(where, options);
    try {
      return await opened.levels.project();
    } finally {
      await opened.close();
    }
  };
  return {
    sandbox,
    device,
    checkout,
    open,
    recorded,
    projectOf,
    async close() {
      for (const state of stores) await state.close();
      rmSync(sandbox, { recursive: true, force: true });
    },
  };
}

test("two checkouts with one committed manifest report one project id (fails when the manifest is not read)", async () => {
  const f = fixture();
  try {
    const a = await f.checkout("a", manifest());
    const b = await f.checkout("b", manifest());
    const first = await f.projectOf(a);
    const second = await f.projectOf(b);
    expect(first?.projectId).toBe(MANIFEST_ID);
    expect(second?.projectId).toBe(MANIFEST_ID);
    // Each local store keeps the id it minted for itself.
    expect(first?.identity.id).not.toBe(second?.identity.id);
    expect(first?.identity.id).toMatch(/^[0-9a-f]{16}$/);
  } finally {
    await f.close();
  }
}, 30_000);

test("without a manifest each checkout reports its own store id, as before", async () => {
  const f = fixture();
  try {
    const a = await f.checkout("a");
    const b = await f.checkout("b");
    const first = await f.projectOf(a);
    const second = await f.projectOf(b);
    expect(first?.projectId).toBe(first?.identity.id);
    expect(second?.projectId).toBe(second?.identity.id);
    expect(first?.projectId).not.toBe(second?.projectId);
    // Nothing extra is recorded when there is no manifest.
    expect((await f.recorded(a.state))?.value).toEqual({
      id: first?.identity.id,
    });
  } finally {
    await f.close();
  }
}, 30_000);

test("the project id is recorded beside the store id and never replaces it", async () => {
  const f = fixture();
  try {
    const a = await f.checkout("a", manifest());
    const first = await f.projectOf(a);
    expect((await f.recorded(a.state))?.value).toEqual({
      id: first?.identity.id,
      projectId: MANIFEST_ID,
    });
    const again = await f.projectOf(a);
    expect(again?.identity.id).toBe(first?.identity.id);
    expect(again?.projectId).toBe(MANIFEST_ID);
  } finally {
    await f.close();
  }
}, 30_000);

test("a read reports the manifest id but never writes it into the store", async () => {
  const f = fixture();
  try {
    const a = await f.checkout("a");
    const minted = await f.projectOf(a);
    writeFileSync(join(a.root, ".forge", "project.json"), manifest());
    const before = await f.recorded(a.state);
    const read = await f.projectOf(a, { write: false });
    expect(read?.projectId).toBe(MANIFEST_ID);
    expect(read?.identity.id).toBe(minted?.identity.id);
    expect(await f.recorded(a.state)).toEqual(before);
  } finally {
    await f.close();
  }
}, 30_000);

test("a store that recorded another project id refuses writes and names both ids", async () => {
  const f = fixture();
  try {
    const a = await f.checkout("a", manifest());
    await f.projectOf(a);
    // The same store now sits under a checkout whose committed manifest says something else.
    writeFileSync(join(a.root, ".forge", "project.json"), manifest(OTHER_ID));
    const failure = await f.projectOf(a).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      error: { code: "PROJECT_ID_CONFLICT", retry: "never" },
    });
    const message = (failure as { error: { message: string } }).error.message;
    expect(message).toContain(MANIFEST_ID);
    expect(message).toContain(OTHER_ID);
    // The store keeps the id it accepted; nothing switched silently.
    expect(
      ((await f.recorded(a.state))?.value as { projectId: string }).projectId,
    ).toBe(MANIFEST_ID);
    const read = await f.projectOf(a, { write: false });
    expect(read?.projectId).toBe(MANIFEST_ID);
  } finally {
    await f.close();
  }
}, 30_000);

test("a recorded project id outlives a branch that has no manifest", async () => {
  const f = fixture();
  try {
    const a = await f.checkout("a", manifest());
    await f.projectOf(a);
    rmSync(join(a.root, ".forge", "project.json"));
    expect((await f.projectOf(a))?.projectId).toBe(MANIFEST_ID);
    expect((await f.projectOf(a, { write: false }))?.projectId).toBe(
      MANIFEST_ID,
    );
  } finally {
    await f.close();
  }
}, 30_000);

test("a manifest with an unknown field is refused before any project work", async () => {
  const f = fixture();
  try {
    const a = await f.checkout("a", manifest());
    await f.projectOf(a);
    writeFileSync(
      join(a.root, ".forge", "project.json"),
      JSON.stringify({ schema: 1, id: MANIFEST_ID, token: "secret" }),
    );
    for (const write of [true, false])
      await expect(f.projectOf(a, { write })).rejects.toMatchObject({
        error: { code: "INPUT_INVALID" },
      });
  } finally {
    await f.close();
  }
}, 30_000);

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=Forge Test",
      "-c",
      "user.email=test@example.invalid",
      ...args,
    ],
    { cwd, encoding: "utf8", windowsHide: true, timeout: 20_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}

test("a git worktree reports the manifest id of the repository it belongs to", async () => {
  const f = fixture();
  try {
    const main = await f.checkout("main", manifest());
    git(main.root, "init");
    git(main.root, "add", "-f", ".forge/project.json");
    git(main.root, "commit", "-m", "fixture");
    const tree = join(f.sandbox, "tree");
    git(main.root, "worktree", "add", "--detach", tree);
    const stateRoot = await projectStateRoot(tree);
    // The worktree opens the main checkout's store but reads its own checked-out manifest.
    const shared = { root: tree, state: main.state };
    const fromTree = await f.projectOf(shared, { stateRoot });
    const fromMain = await f.projectOf(main);
    expect(fromTree?.projectId).toBe(MANIFEST_ID);
    expect(fromMain?.projectId).toBe(MANIFEST_ID);
    expect(fromTree?.identity.id).toBe(fromMain?.identity.id);
  } finally {
    await f.close();
  }
}, 60_000);

test("two writers with different manifests cannot both record an id for one store", async () => {
  const f = fixture();
  const gates: (() => void)[] = [];
  const acquire = f.device.acquire.bind(f.device);
  const gate = spyOn(f.device, "acquire").mockImplementation(
    (write) =>
      new Promise((release) => {
        gates.push(() => release(acquire(write)));
      }),
  );
  const parked = async (count: number) => {
    for (let turn = 0; turn < 1000 && gates.length < count; turn++)
      await new Promise((resume) => setImmediate(resume));
    expect(gates).toHaveLength(count);
  };
  const first = f.checkout("first", manifest());
  const second = f.checkout("second", manifest(OTHER_ID));
  const [a, b] = await Promise.all([first, second]);
  // Both checkouts share one store, so both writers see no recorded project id.
  const shared = { root: b.root, state: a.state };
  const writerA = f.open(a);
  const writerB = f.open(shared, { stateRoot: a.root });
  try {
    const recordA = writerA.levels.project();
    await parked(1);
    const recordB = writerB.levels.project();
    await parked(2);
    // Both passed the conflict check; A records its id first, then B reaches its write.
    gates[0]!();
    expect((await recordA)?.projectId).toBe(MANIFEST_ID);
    gates[1]!();
    const failure = await recordB.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      error: { code: "PROJECT_ID_CONFLICT" },
    });
    const message = (failure as { error: { message: string } }).error.message;
    expect(message).toContain(MANIFEST_ID);
    expect(message).toContain(OTHER_ID);
    expect(
      ((await f.recorded(a.state))?.value as { projectId: string }).projectId,
    ).toBe(MANIFEST_ID);
  } finally {
    gate.mockRestore();
    await writerA.close();
    await writerB.close();
    await f.close();
  }
}, 30_000);

test("a call from a nested folder reads its checkout's manifest, in the main checkout and a linked worktree", async () => {
  const f = fixture();
  try {
    const main = await f.checkout("main", manifest());
    git(main.root, "init");
    git(main.root, "add", "-f", ".forge/project.json");
    git(main.root, "commit", "-m", "fixture");
    const tree = join(f.sandbox, "tree");
    git(main.root, "worktree", "add", "--detach", tree);
    const nestedMain = join(main.root, "src", "deep");
    const nestedTree = join(tree, "src");
    mkdirSync(nestedMain, { recursive: true });
    mkdirSync(nestedTree, { recursive: true });
    for (const [nested, checkout] of [
      [nestedMain, main.root],
      [nestedTree, tree],
    ] as const) {
      const manifestRoot = projectManifestRoot(nested);
      expect(manifestRoot).toBe(checkout);
      const project = await f.projectOf(
        { root: nested, state: main.state },
        { stateRoot: main.root, manifestRoot },
      );
      expect(project?.projectId).toBe(MANIFEST_ID);
    }
    // Outside git there is no checkout root to find: the root itself is used.
    expect(projectManifestRoot(f.sandbox)).toBe(f.sandbox);
  } finally {
    await f.close();
  }
}, 60_000);

test("the repository gitignore keeps the manifest tracked and local .forge files ignored", () => {
  const repo = resolve(import.meta.dirname, "../..");
  const ignored = (path: string): number | null => {
    const result = spawnSync(
      "git",
      ["check-ignore", "-q", "--no-index", "--", path],
      { cwd: repo, encoding: "utf8", windowsHide: true, timeout: 20_000 },
    );
    expect(result.error).toBeUndefined();
    return result.status;
  };
  expect(ignored(".forge/project.json")).toBe(1);
  expect(ignored(".forge/config.yaml")).toBe(1);
  expect(ignored(".forge/scratch.json")).toBe(0);
  expect(ignored(".forge/state.sqlite")).toBe(0);
}, 30_000);

test("minting a store id never overwrites an identity another writer committed after the first read", async () => {
  const f = fixture();
  try {
    const a = await f.checkout("a", manifest());
    const owner = (await a.state.open(true))!;
    const real = owner.get.bind(owner);
    const rival = { id: "b0b0b0b0b0b0b0b0", projectId: OTHER_ID };
    let reads = 0;
    let committing = false;
    // The writer's first three identity reads (store id, recorded project id, mint) see an empty
    // store; the rival commits its full identity just before the mint read returns. Later reads are real.
    const spy = spyOn(owner, "get").mockImplementation((...args) => {
      if (committing || args[0] !== IDENTITY || args[1] !== "identity")
        return real(...args);
      reads++;
      if (reads === 3) {
        committing = true;
        try {
          owner.put(IDENTITY, "identity", rival, actor, { expectRevision: 0 });
        } finally {
          committing = false;
        }
      }
      return reads <= 3 ? undefined : real(...args);
    });
    try {
      const failure = await f.projectOf(a).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({
        error: { code: "PROJECT_ID_CONFLICT" },
      });
      const message = (failure as { error: { message: string } }).error.message;
      expect(message).toContain(MANIFEST_ID);
      expect(message).toContain(OTHER_ID);
    } finally {
      spy.mockRestore();
    }
    // The rival's store id and project id are untouched.
    expect((await f.recorded(a.state))?.value).toEqual(rival);
  } finally {
    await f.close();
  }
}, 30_000);
