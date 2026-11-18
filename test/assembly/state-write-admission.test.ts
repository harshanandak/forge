import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStore } from "../../src/adapters/store-sqlite/index.ts";
import { openLevels } from "../../src/assembly/levels.ts";
import { LocalState } from "../../src/assembly/state.ts";
import { createStateClient } from "../../src/assembly/state-client.ts";
import type { StateOwner } from "../../src/core/state/index.ts";
import { InvocationServices } from "../../src/core/runtime/services.ts";

setDefaultTimeout(30_000);
const actor = { kind: "human", id: "fixture" } as const;
const holder = { actor, session: { id: "fixture" } };
const namespace = "forge/test";
const work = "forge/work";
const global = "autopilot:global";
const frozen = { stopped: {}, frozen: "2026-11-18T10:00:00.000Z" };
const refused = /UNAVAILABLE: .*frozen/u;

async function using(
  run: (fixture: {
    root: string;
    project: LocalState;
    owner: StateOwner;
    freeze: () => void;
    bytes: () => Buffer;
    atStep: (step: string, action: () => void) => void;
  }) => void | Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "forge-write-admission-"));
  const path = join(root, ".forge", "state.sqlite");
  let pending: { step: string; action: () => void } | undefined;
  const project = new LocalState(
    path,
    createSqliteStore(root, {
      step(name) {
        if (pending?.step !== name) return;
        const { action } = pending;
        pending = undefined;
        action();
      },
    }),
    undefined,
    undefined,
    root,
  );
  const peer = new LocalState(
    path,
    createSqliteStore(root),
    undefined,
    undefined,
    root,
  );
  try {
    const owner = (await project.open(true))!;
    const writer = (await peer.open(true))!;
    await run({
      root,
      project,
      owner,
      freeze: () => {
        writer.put(work, global, frozen, actor, { expectRevision: 0 });
      },
      bytes: () => readFileSync(path),
      atStep: (step, action) => {
        pending = { step, action };
      },
    });
  } finally {
    await peer.close();
    await project.close();
    rmSync(root, { recursive: true, force: true });
  }
}

type Mutation = (
  owner: StateOwner,
  fence: {
    subject: string;
    holder: typeof holder;
    generation: number;
  },
) => unknown;

const mutations: Record<string, Mutation> = {
  put: (owner) =>
    owner.put(namespace, "new", {}, actor, {
      expectRevision: 0,
      requestId: "new-receipt",
    }),
  delete: (owner) =>
    owner.delete(namespace, "existing", actor, { expectRevision: 1 }),
  putMany: (owner) =>
    owner.putMany(
      namespace,
      [
        { key: "existing", value: "changed", expectRevision: 1 },
        { key: "new", value: "added", expectRevision: 0 },
      ],
      actor,
    ),
  putNext: (owner) =>
    owner.putNext(namespace, "item-", () => ({ value: "next" }), actor),
  seedNumberFloor: (owner) =>
    owner.seedNumberFloor(
      namespace,
      "item-",
      { highest: 0, earlier: 0, floorRevision: 0 },
      actor,
      owner.export().eventHighWaterMark,
    ),
  acquire: (owner) =>
    owner.acquire(namespace, "unheld", holder, 60_000, "acquire"),
  renew: (owner, fence) => owner.renew(namespace, fence, 60_000),
  release: (owner, fence) => owner.release(namespace, fence),
  releaseRestoredLeases: (owner) => owner.releaseRestoredLeases(),
  checkpoint: (owner) => owner.checkpoint(),
  compact: (owner) => owner.compact(256, 0, 0),
  restore: (owner) => owner.restore(owner.export()),
  migration: (owner) =>
    owner.initialize([
      {
        namespace,
        reviewedDigest: `sha256:${"a".repeat(64)}`,
        tables: ["domain_fence"],
        migrations: [
          {
            id: "100_fence",
            statements: ["CREATE TABLE domain_fence (id TEXT PRIMARY KEY)"],
          },
        ],
      },
    ]),
  "overwrite freeze": (owner) =>
    owner.put(work, global, { stopped: {} }, actor, { expectRevision: 1 }),
  "delete freeze": (owner) =>
    owner.delete(work, global, actor, { expectRevision: 1 }),
};

for (const [name, mutate] of Object.entries(mutations)) {
  test(`freeze refuses ${name} on an already open writer and preserves the database`, () =>
    using(({ owner, freeze, bytes }) => {
      owner.put(namespace, "existing", 1, actor, { expectRevision: 0 });
      const { generation } = owner.acquire(
        namespace,
        "held",
        holder,
        60_000,
        "held",
      );
      freeze();
      const before = bytes();
      expect(() =>
        mutate(owner, { subject: "held", holder, generation }),
      ).toThrow(refused);
      expect(bytes()).toEqual(before);
      expect(owner.get(work, global)?.value).toEqual(frozen);
    }));
}

test("opening an already migrated frozen store requires no project writes", () =>
  using(async ({ root, freeze, bytes }) => {
    freeze();
    const before = bytes();
    const fresh = new LocalState(
      join(root, ".forge", "state.sqlite"),
      createSqliteStore(root),
      undefined,
      undefined,
      root,
    );
    try {
      expect((await fresh.open(true))?.get(work, global)?.value).toEqual(
        frozen,
      );
      expect(bytes()).toEqual(before);
    } finally {
      await fresh.close();
    }
  }));

test("a peer can freeze after a writer reads and before it locks for the write", () =>
  using(({ owner, freeze, bytes, atStep }) => {
    const revision = owner.get(namespace, "missing")?.revision ?? 0;
    let before: Buffer | undefined;
    atStep("write-pre-lock", () => {
      freeze();
      before = bytes();
    });
    expect(() =>
      owner.put(namespace, "missing", {}, actor, { expectRevision: revision }),
    ).toThrow(refused);
    expect(before).toBeDefined();
    expect(bytes()).toEqual(before!);
  }));

test("restore refuses a freeze committed before final approval of the swap", () =>
  using(({ owner, freeze, bytes, atStep }) => {
    const snapshot = owner.export();
    let before: Buffer | undefined;
    atStep("prepared", () => {
      freeze();
      before = bytes();
    });
    expect(() => owner.restore(snapshot)).toThrow(refused);
    expect(before).toBeDefined();
    expect(bytes()).toEqual(before!);
  }));

test("a registered cleanup finalizer cannot delete its owned record after freeze", () =>
  using(async ({ owner, freeze, bytes }) => {
    const state = createStateClient({
      owner,
      namespace,
      context: { variant: "project", actor, project: { id: "fixture" } },
      write: true,
      requestId: "finalizer",
    });
    const scope = new InvocationServices(Date.now() + 5_000, () => {});
    const key = "cleanup:work-1";
    scope.authorizeFinalizer(state, key);
    const wrapped = (
      scope.wrap({ state }) as {
        state: typeof state & {
          finalizeDelete(key: string, revision: number): void;
        };
      }
    ).state;
    const row = wrapped.put(key, "keep", { expectRevision: 0 });
    wrapped.finalizeDelete(key, row.revision);
    freeze();
    const before = bytes();
    scope.stop();
    await expect(scope.drain()).rejects.toThrow(refused);
    expect(bytes()).toEqual(before);
  }));

test("project identity repair cannot add a manifest id to a frozen store", () =>
  using(async ({ root, project, owner, freeze, bytes }) => {
    owner.put(
      "forge/core-project",
      "identity",
      { id: "0123456789abcdef" },
      actor,
      {
        expectRevision: 0,
      },
    );
    writeFileSync(
      join(root, ".forge", "project.json"),
      JSON.stringify({
        schema: 1,
        id: "01234567-0123-4123-8123-0123456789ab",
      }),
    );
    freeze();
    const before = bytes();
    const deviceState = new LocalState(
      join(root, "device.sqlite"),
      createSqliteStore(root),
    );
    const opened = openLevels({
      root,
      stateRoot: root,
      projectState: project,
      deviceState,
      namespace,
      actor,
      servesProject: true,
      caller: "human",
      write: true,
      requestId: "repair",
    });
    try {
      await expect(opened.levels.project()).rejects.toThrow(refused);
      expect(bytes()).toEqual(before);
    } finally {
      await opened.close();
      await deviceState.close();
    }
  }));
