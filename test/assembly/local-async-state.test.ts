import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStore } from "../../src/adapters/store-sqlite/index.ts";
import * as levelsModule from "../../src/assembly/levels.ts";
import {
  ASSEMBLY_PROVIDES,
  assemblyProvides,
} from "../../src/assembly/providers.ts";
import { createStateClient } from "../../src/assembly/state-client.ts";
import { LocalState } from "../../src/assembly/state.ts";
import { failureEnvelope } from "../../src/core/runtime/index.ts";
import { exitCode } from "../../src/surface/result.ts";
import { loadEntry, memoryState } from "../blocks/memory/lib.ts";

setDefaultTimeout(30_000);
const actor = { kind: "human" as const, id: "async-state" };
const namespace = "forge/test";

async function promised<T>(value: Promise<T>): Promise<T> {
  expect(value).toBeInstanceOf(Promise);
  return value;
}

async function refused(result: Promise<unknown>, code = "GRANT_REQUIRED") {
  const envelope = await promised(result).then(
    () => undefined,
    (error: unknown) => failureEnvelope(undefined, error),
  );
  const status = code === "GRANT_REQUIRED" ? "INCOMPLETE" : "FAIL";
  expect(envelope).toMatchObject({ status, error: { code } });
  expect(exitCode(envelope!)).toBe(status === "INCOMPLETE" ? 2 : 4);
}

async function fixture() {
  // This assertion is the intentional red on the unmodified catalog, before any new module loads.
  expect(assemblyProvides("forge.state@2")).toBe(true);
  expect(assemblyProvides("forge.project-state@2")).toBe(true);
  const { createLocalAsyncStateClient } =
    await import("../../src/assembly/async-state-client.ts");
  const root = realpathSync.native(
    mkdtempSync(join(tmpdir(), "forge-async-state-")),
  );
  const store = createSqliteStore(root);
  const device = new LocalState(":memory:", store);
  const project = new LocalState(":memory:", store);
  const owner = (await device.open(true))!;
  const sync = createStateClient({
    owner,
    namespace,
    context: { variant: "device", actor, device: { id: "test" } },
    write: true,
    requestId: "async-state",
  });
  const opened: ReturnType<typeof levelsModule.openLevels>[] = [];
  const peers: LocalState[] = [];
  const open = (stateRoot: string, write: boolean, state = project) => {
    const result = levelsModule.openLevels({
      root: stateRoot,
      stateRoot,
      projectState: state,
      deviceState: device,
      namespace,
      actor,
      servesProject: true,
      caller: "human",
      write,
      requestId: "async-levels",
    });
    opened.push(result);
    return {
      sync: result.levels,
      async: levelsModule.createAsyncLevels(result.levels),
    };
  };
  return {
    root,
    store,
    device,
    project,
    owner,
    sync,
    open,
    peers,
    bridge: createLocalAsyncStateClient,
    async: createLocalAsyncStateClient(sync),
    async close() {
      for (const result of opened.reverse()) await result.close();
      for (const peer of peers) await peer.close();
      await project.close();
      await device.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

// The design's acceptance table: input / status / exit / eligibility / unchanged.
const cases: readonly [string, (f: Fixture) => void | Promise<void>][] = [
  [
    "Local parity",
    async (f) => {
      const first = f.sync.put(
        "note/1",
        { text: "one" },
        { expectRevision: 0 },
      );
      expect(await promised(f.async.get("note/1"))).toEqual(first);
      const second = await promised(
        f.async.put("note/1", { text: "two" }, { expectRevision: 1 }),
      );
      expect(f.sync.get("note/1")).toEqual(second);
      const entries = [
        { key: "note/2", value: "two", expectRevision: 0 },
        { key: "note/3", value: "three", expectRevision: 0 },
      ];
      const batch = await promised(
        f.async.putMany(entries, {
          readSet: [{ key: "note/1", expectRevision: 2 }],
        }),
      );
      expect(batch).toEqual(entries.map(({ key }) => f.sync.get(key)!));
      const range = {
        from: "note/1",
        to: "note/3",
        limit: 1,
        descending: true,
      };
      expect(await promised(f.async.range(range))).toEqual(
        f.sync.listRange(range),
      );
      const history = { key: "note/1", limit: 1, before: 3 };
      expect(await promised(f.async.history(history))).toEqual(
        f.sync.history(history),
      );
      expect(await promised(f.async.count("note/"))).toBe(3);
      expect(await promised(f.async.max("note/"))).toBe(3);
      expect(f.sync.events()).toHaveLength(4);
      const before = f.sync.events();
      for (const attempt of [
        () => f.async.put("note/1", "stale", { expectRevision: 1 }),
        () =>
          f.async.putMany([
            { key: "note/4", value: "no", expectRevision: 0 },
            { key: "note/1", value: "stale", expectRevision: 1 },
          ]),
        () =>
          f.async.putMany([{ key: "note/4", value: "no", expectRevision: 0 }], {
            readSet: [{ key: "note/1", expectRevision: 1 }],
          }),
      ]) {
        await refused(attempt(), "REVISION_CONFLICT");
      }
      expect(f.sync.get("note/4")).toBeUndefined();
      expect(f.sync.events()).toEqual(before);
      expect(Object.keys(f.async).sort()).toEqual(
        "count get history max put putMany range".split(" "),
      );
    },
  ],
  [
    "Local levels",
    async (f) => {
      const peerRoot = join(f.root, "peer");
      const peerState = new LocalState(
        join(peerRoot, ".forge", "state.sqlite"),
      );
      f.peers.push(peerState);
      const peer = f.open(peerRoot, true, peerState);
      const peerProject = (await peer.async.project())!;
      await peerProject.state.put("note/1", "peer", { expectRevision: 0 });
      const own = f.open(join(f.root, "own"), true);
      const ownProject = (await own.async.project())!;
      await ownProject.state.put("note/1", "own", { expectRevision: 0 });
      await f.async.put("note/1", "device", { expectRevision: 0 });
      expect((await f.async.get("note/1"))?.value).toBe("device");
      expect((await own.sync.project())!.state.get("note/1")?.value).toBe(
        "own",
      );
      expect(ownProject.identity).toEqual((await own.sync.project())!.identity);
      expect(ownProject.projectId).toBe((await own.sync.project())!.projectId);
      const registryBefore = f.owner.events("forge/core-projects");
      const identityBefore = f.project.current!.events("forge/core-project");
      const reader = f.open(join(f.root, "own"), false);
      expect(reader.async.caller).toBe(reader.sync.caller);
      expect(reader.async.inProject).toBe(true);
      expect(reader.async.defaultScope).toBe(reader.sync.defaultScope);
      expect(reader.async.warnings).toEqual(reader.sync.warnings);
      expect((await reader.async.project())?.identity).toEqual(
        ownProject.identity,
      );
      for (const ref of [peerProject.identity.id, "peer"]) {
        const found = await reader.async.peer(ref);
        expect(found.status).toBe("found");
        if (found.status !== "found") throw Error("registered peer missing");
        expect(found.identity).toEqual(peerProject.identity);
        expect((await promised(found.state.get("note/1")))?.value).toBe("peer");
        for (const attempt of [
          () => found.state.put("note/1", "forbidden", { expectRevision: 1 }),
          () =>
            found.state.putMany([
              { key: "note/2", value: "forbidden", expectRevision: 0 },
            ]),
        ]) {
          await refused(attempt());
        }
      }
      expect(await reader.async.peer("unknown")).toEqual({
        status: "not_found",
        ref: "unknown",
      });
      expect(f.owner.events("forge/core-projects")).toEqual(registryBefore);
      expect(f.project.current!.events("forge/core-project")).toEqual(
        identityBefore,
      );
      expect((await peerProject.state.get("note/1"))?.revision).toBe(1);
      expect(await peerProject.state.get("note/2")).toBeUndefined();
    },
  ],
  [
    "v1 consumer",
    async (f) => {
      expect(
        ASSEMBLY_PROVIDES.filter((id) =>
          /forge\.(state|project-state)@1\./.test(id),
        ),
      ).toEqual(["forge.state@1.0.0", "forge.project-state@1.0.0"]);
      const value = f.sync.put("note/1", "sync", { expectRevision: 0 });
      expect(value).not.toBeInstanceOf(Promise);
      for (const result of [
        f.sync.get("note/1"),
        f.sync.list(),
        f.sync.events(),
        f.sync.count("note/"),
        f.sync.maxNumber("note/"),
        f.sync.listRange({ limit: 1 }),
        f.sync.history({ key: "note/1", limit: 1 }),
        f.sync.putMany([
          { key: "note/2", value: "sync batch", expectRevision: 0 },
        ]),
      ])
        expect(result).not.toBeInstanceOf(Promise);
      expect(f.sync.get("note/1")).toEqual(value);
      expect(assemblyProvides("forge.state@3")).toBe(false);
      const legacy = memoryState(undefined, {
        caller: "human",
        inProject: false,
      });
      const added = await loadEntry("memory")["memory.add"]!({
        input: { text: "existing synchronous consumer", level: "device" },
        services: { state: legacy, levels: legacy },
      });
      expect(added).toMatchObject({ id: "device/note-1" });
    },
  ],
  [
    "Read/no effect",
    async (f) => {
      const missingRoot = join(f.root, "absent");
      const missing = new LocalState(
        join(missingRoot, "state.sqlite"),
        f.store,
      );
      const lease = await missing.acquire(false);
      try {
        const empty = f.bridge(
          createStateClient({
            owner: lease.value,
            namespace,
            context: { variant: "stateless" },
            write: false,
            requestId: "empty",
          }),
        );
        expect(await promised(empty.get("none"))).toBeUndefined();
        expect(await promised(empty.range({ limit: 1 }))).toEqual([]);
        expect(
          await promised(empty.history({ key: "none", limit: 1 })),
        ).toEqual([]);
        expect(await promised(empty.count(""))).toBe(0);
        expect(await promised(empty.max(""))).toBe(0);
        const levels = f.open(missingRoot, false, missing);
        expect(await levels.async.project()).toBeUndefined();
        for (const attempt of [
          () => empty.put("none", "no", { expectRevision: 0 }),
          () =>
            empty.putMany([{ key: "none", value: "no", expectRevision: 0 }]),
        ]) {
          await refused(attempt());
        }
        expect(existsSync(missingRoot)).toBe(false);
        expect(missing.current).toBeUndefined();
      } finally {
        await lease.close();
        await missing.close();
      }
    },
  ],
];
for (const [name, run] of cases)
  test(name, async () => {
    const f = await fixture();
    try {
      await run(f);
    } finally {
      await f.close();
    }
  });
