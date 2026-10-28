import { afterEach, expect, test } from "bun:test";
import {
  done,
  loadEntry,
  memoryState,
  openHarness,
  type Harness,
} from "./lib.ts";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

test("an agent proposes forgetting while retaining the note's original content and earlier versions", async () => {
  const entry = loadEntry("memory");
  const state = memoryState();
  const services = { state, levels: state };
  const original = {
    text: "owner rule: retain exact text\nincluding whitespace  ",
    scope: "repo:forge",
    tags: ["rule", "owner"],
    links: ["device/note-2"],
    from: "project/0123456789abcdef/note-3",
    previous: [{ revision: 1, text: "earlier owner rule" }],
  };
  state.put(
    "note/000000001",
    { ...original, text: "earlier owner rule", previous: [] },
    { expectRevision: 0 },
  );
  state.put("note/000000001", original, { expectRevision: 1 });
  const before = state.get("note/000000001")!;
  const proposed = await entry["memory.propose-forget"]!({
    input: { id: "device/note-1", expectRevision: before.revision },
    services,
  });
  expect(proposed).toMatchObject({
    status: "proposed",
    id: "device/note-1",
    note: { proposedForget: true, text: { text: original.text } },
  });
  expect(state.get("note/000000001")!.value).toEqual({
    ...original,
    previous: [
      ...original.previous,
      { revision: before.revision, text: original.text },
    ],
    proposedForget: true,
  });
  expect(before.value).toEqual(original);
  const writes = state.counts.put;
  expect(
    await entry["memory.propose-forget"]!({
      input: { id: "note-1", expectRevision: before.revision },
      services,
    }),
  ).toMatchObject({ status: "already_proposed", id: "device/note-1" });
  expect(state.counts.put).toBe(writes);
}, 30_000);

test("the catalog admits an agent proposal, shows its marker, and leaves owner forgetting available", async () => {
  harness = await openHarness(["memory"]);
  const h = harness;
  const agent = { caller: "agent" as const, context: h.deviceOnly() };
  done(
    await h.call(
      "memory.add",
      { level: "device", text: "retain this owner rule" },
      agent,
    ),
  );
  done(
    await h.call(
      "memory.add",
      {
        id: "device/note-1",
        expectRevision: 1,
        text: "retain the updated owner rule",
      },
      agent,
    ),
  );
  const declaration = h.assembly.catalog
    .list()
    .find((op) => op.op === "memory.propose-forget");
  expect(declaration?.declaration).toMatchObject({
    args: ["id"],
    context: "device",
    callers: ["agent", "human"],
    effects: ["memory:write"],
    idempotent: true,
  });
  expect(
    done(await h.call("memory.propose-forget", { id: "device/note-1" }, agent)),
  ).toMatchObject({
    status: "proposed",
    note: { revision: 3, proposedForget: true },
  });
  expect(
    done(await h.call("memory.show", { id: "device/note-1" }, agent)),
  ).toMatchObject({
    status: "found",
    note: {
      proposedForget: true,
      text: { text: "retain the updated owner rule" },
    },
  });
  expect(
    done(
      await h.call("memory.show", { id: "device/note-1", revision: 1 }, agent),
    ),
  ).toMatchObject({
    status: "found",
    note: { text: { text: "retain this owner rule" } },
  });
  expect(
    done(
      await h.call("memory.show", { id: "device/note-1", revision: 2 }, agent),
    ),
  ).toMatchObject({
    status: "found",
    note: { text: { text: "retain the updated owner rule" } },
  });
  expect(
    done(await h.call("memory.search", { query: "owner rule" }, agent)),
  ).toMatchObject({
    matched: 1,
    hits: [{ id: "device/note-1", proposedForget: true }],
  });
  const refused = await h.call("memory.forget", { id: "device/note-1" }, agent);
  expect(refused.ok).toBe(false);
  expect(
    done(
      await h.call("memory.forget", { id: "device/note-1", expectRevision: 3 }),
    ),
  ).toEqual({
    status: "forgotten",
    id: "device/note-1",
  });
  expect(
    done(await h.call("memory.propose-forget", { id: "device/note-1" }, agent)),
  ).toEqual({
    status: "already_forgotten",
    id: "device/note-1",
  });
}, 60_000);

test("a stale proposal fails without changing the note", async () => {
  const entry = loadEntry("memory");
  const state = memoryState();
  const services = { state, levels: state };
  await entry["memory.add"]!({
    input: { level: "device", text: "original" },
    services,
  });
  await entry["memory.add"]!({
    input: { id: "device/note-1", expectRevision: 1, text: "latest" },
    services,
  });
  const before = state.get("note/000000001");
  await expect(
    entry["memory.propose-forget"]!({
      input: { id: "device/note-1", expectRevision: 1 },
      services,
    }),
  ).rejects.toMatchObject({ error: { code: "REVISION_CONFLICT" } });
  expect(state.get("note/000000001")).toEqual(before);
}, 30_000);

test("a proposal cannot overwrite a concurrent writer", async () => {
  const entry = loadEntry("memory");
  const state = memoryState();
  state.put(
    "note/000000001",
    {
      text: "original",
      tags: [],
      links: [],
      previous: [],
    },
    { expectRevision: 0 },
  );
  const racing = {
    ...state,
    put: (...args: Parameters<typeof state.put>) => {
      state.put(
        "note/000000001",
        {
          text: "concurrent owner edit",
          tags: ["owner"],
          links: [],
          previous: [],
        },
        { expectRevision: 1 },
      );
      return state.put(...args);
    },
  };
  await expect(
    entry["memory.propose-forget"]!({
      input: { id: "device/note-1" },
      services: { state: racing, levels: state },
    }),
  ).rejects.toMatchObject({ error: { code: "REVISION_CONFLICT" } });
  expect(state.get("note/000000001")!.value).toEqual({
    text: "concurrent owner edit",
    tags: ["owner"],
    links: [],
    previous: [],
  });
}, 30_000);

test("another project's note remains read-only and missing proposals write nothing", async () => {
  const entry = loadEntry("memory");
  const peer = memoryState();
  peer.put(
    "note/000000001",
    {
      text: "peer rule",
      tags: [],
      links: [],
      previous: [],
    },
    { expectRevision: 0 },
  );
  const state = memoryState(undefined, {
    peer: () =>
      Promise.resolve({
        status: "found",
        identity: { id: "0123456789abcdef", name: "peer" },
        state: peer,
      }),
  });
  const services = { state, levels: state };
  const before = peer.get("note/000000001");
  expect(
    await entry["memory.propose-forget"]!({
      input: { id: "project/0123456789abcdef/note-1" },
      services,
    }),
  ).toEqual({ status: "read_only", id: "project/0123456789abcdef/note-1" });
  expect(peer.get("note/000000001")).toEqual(before);
  expect(
    await entry["memory.propose-forget"]!({
      input: { id: "device/note-9" },
      services,
    }),
  ).toEqual({ status: "not_found", id: "device/note-9" });
  expect(state.counts.put + state.counts.putMany).toBe(0);
}, 30_000);
