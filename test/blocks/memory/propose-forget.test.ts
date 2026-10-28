import { afterEach, expect, test } from "bun:test";
import { runCli } from "../../../src/surface/cli.ts";
import {
  blockSchema,
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
    textRevision: before.revision,
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

test("proposal metadata keeps all five retained texts and the pre-proposal current revision readable", async () => {
  const entry = loadEntry("memory");
  const state = memoryState();
  const services = { state, levels: state };
  await entry["memory.add"]!({
    input: { level: "device", text: "version-1" },
    services,
  });
  for (let revision = 2; revision <= 6; revision += 1)
    await entry["memory.add"]!({
      input: {
        id: "device/note-1",
        expectRevision: revision - 1,
        text: `version-${revision}`,
      },
      services,
    });
  const before = state.get("note/000000001")!;
  await entry["memory.propose-forget"]!({
    input: { id: "device/note-1" },
    services,
  });
  for (let revision = 1; revision <= 6; revision += 1)
    expect(
      await entry["memory.show"]!({
        input: { id: "device/note-1", revision },
        services,
      }),
    ).toMatchObject({
      status: "found",
      note: { text: { text: `version-${revision}` } },
    });
  expect(state.get("note/000000001")!.value).toMatchObject({
    previous: (before.value as { previous: unknown }).previous,
  });
  await entry["memory.add"]!({
    input: {
      id: "device/note-1",
      expectRevision: 7,
      text: "edited after proposal",
    },
    services,
  });
  expect(
    await entry["memory.show"]!({
      input: { id: "device/note-1", revision: 6 },
      services,
    }),
  ).toMatchObject({
    status: "found",
    note: { text: { text: "version-6" } },
  });
}, 30_000);

test("generated CLI lets either caller withdraw a proposal without changing text or history", async () => {
  harness = await openHarness(["memory"]);
  const h = harness;
  done(
    await h.call("memory.add", { level: "device", text: "retain this text" }),
  );
  for (const caller of ["agent", "human"] as const) {
    done(await h.call("memory.propose-forget", { id: "device/note-1" }));
    const before = done(
      await h.call("memory.show", { id: "device/note-1" }),
    ) as {
      note: { revision: number; versions: unknown; text: { text: string } };
    };
    const input = {
      id: "device/note-1",
      withdraw: true,
      expectRevision: before.note.revision,
    };
    expect(blockSchema("memory", "propose-forget.input.json")(input)).toEqual(
      [],
    );
    const options = { caller, context: h.deviceOnly() };
    const stale = await runCli(
      h.assembly.catalog,
      [
        "memory",
        "propose-forget",
        "device/note-1",
        "--withdraw",
        "--expect-revision",
        String(before.note.revision - 1),
      ],
      options,
    );
    expect(JSON.parse(stale.stdout)).toMatchObject({
      ok: false,
      error: { code: "REVISION_CONFLICT" },
    });
    const withdrawn = await runCli(
      h.assembly.catalog,
      [
        "memory",
        "propose-forget",
        "device/note-1",
        "--withdraw",
        "--expect-revision",
        String(before.note.revision),
      ],
      options,
    );
    expect(JSON.parse(withdrawn.stdout)).toMatchObject({
      ok: true,
      result: {
        status: "withdrawn",
        note: { text: { text: before.note.text.text } },
      },
    });
    const after = done(
      await h.call("memory.show", { id: "device/note-1" }),
    ) as { note: Record<string, unknown> };
    expect(after.note.proposedForget).toBeUndefined();
    expect(after.note.versions).toEqual(before.note.versions);
    const repeated = await runCli(
      h.assembly.catalog,
      ["memory", "propose-forget", "device/note-1", "--withdraw"],
      options,
    );
    expect(JSON.parse(repeated.stdout)).toMatchObject({
      ok: true,
      result: {
        status: "not_proposed",
        note: { revision: after.note.revision },
      },
    });
  }
}, 60_000);

test("moves and copies carry a proposed note's marker to the destination", async () => {
  for (const keep of [false, true]) {
    const entry = loadEntry("memory");
    const project = memoryState();
    const state = memoryState(undefined, {
      inProject: true,
      project: () =>
        Promise.resolve({
          identity: { id: "0123456789abcdef", name: "project" },
          state: project,
        }),
    });
    const services = { state, levels: state };
    await entry["memory.add"]!({
      input: { level: "device", text: "pending owner decision" },
      services,
    });
    await entry["memory.propose-forget"]!({
      input: { id: "device/note-1" },
      services,
    });
    await entry["memory.move"]!({
      input: { id: "device/note-1", to: "project", expectRevision: 2, keep },
      services,
    });
    expect(
      await entry["memory.show"]!({
        input: { id: "project/0123456789abcdef/note-1" },
        services,
      }),
    ).toMatchObject({
      status: "found",
      note: { proposedForget: true, text: { text: "pending owner decision" } },
    });
  }
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
