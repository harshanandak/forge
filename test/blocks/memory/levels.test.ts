import { expect, test } from "bun:test";
import { ownerApproval, loadEntry, memoryState } from "./lib.ts";

// Block-level level tests with in-memory stores: the level policy with no project, and the
// transfer cases that need a failure injected between two stores. The real-store journeys are in
// levels.integration.test.ts, in the serial integration lane.

test("on a host with no project, nearest is the device and a project level is refused", async () => {
  const entry = loadEntry("memory");
  const state = memoryState(undefined, { caller: "human", inProject: false });
  const services = { state, levels: state };
  const config = { levels: { human: "nearest", agent: "required" } };
  const added = (await entry["memory.add"]!({
    input: { text: "a person with no project" },
    config,
    services,
  })) as { id: string };
  expect(added.id).toBe("device/note-1");
  let refused: unknown;
  try {
    await entry["memory.add"]!({
      input: { text: "x", level: "project" },
      config,
      services,
    });
  } catch (error) {
    refused = error;
  }
  expect(JSON.stringify(refused)).toContain("LEVEL_UNAVAILABLE");
}, 30_000);

/** Block-level fakes: a device and a project store, where the device's next write can fail once. */
function crashStores() {
  const device = memoryState(undefined, {});
  const project = memoryState();
  let crash = false;
  const deviceWrites = {
    ...device,
    put: (...args: Parameters<typeof device.put>) => {
      if (crash) {
        crash = false;
        throw new Error("the process stopped before the source was retired");
      }
      return device.put(...args);
    },
  };
  const state = {
    ...deviceWrites,
    caller: "agent" as const,
    inProject: true,
    project: () =>
      Promise.resolve({
        identity: { id: "0123456789abcdef", name: "alpha" },
        state: project,
      }),
    peer: (ref: string) =>
      Promise.resolve({ status: "not_found" as const, ref }),
  };
  return {
    services: { state, levels: state },
    device,
    project,
    crashNextDeviceWrite: () => {
      crash = true;
    },
  };
}
/** The transfer record: looked up before the copy, written with it. */
const MOVE_FIX = [
  {
    from: "const made = target.state.get(marker);",
    to: "const made = undefined;",
  },
  {
    // Each attempt would then record its copy under a key of its own.
    from: "key: marker,",
    to: "key: `${marker}/${counter.last}`,",
  },
];

async function crashJourney(entry: ReturnType<typeof loadEntry>) {
  const stores = crashStores();
  await entry["memory.add"]!({
    input: { text: "move me without losing me", level: "device" },
    services: stores.services,
  });
  stores.crashNextDeviceWrite();
  const move = () =>
    entry["memory.move"]!({
      input: { id: "device/note-1", to: "project", expectRevision: 1 },
      services: stores.services,
    });
  // The copy lands in the project; the device write that retires the source fails.
  let stopped: unknown;
  try {
    await move();
  } catch (error) {
    stopped = error;
  }
  expect(String(stopped)).toMatch(/process stopped/);
  expect(stores.device.get("note/000000001")?.value).toMatchObject({
    text: "move me without losing me",
  });
  const retried = (await move()) as { status: string; to: string };
  const copies = stores.project
    .list("note/")
    .filter((record) => (record.value as { deleted?: true }).deleted !== true);
  return { retried, copies, device: stores.device };
}

test("a move that fails between the two stores finishes on retry with one copy and no loss", async () => {
  const { retried, copies, device } = await crashJourney(loadEntry("memory"));
  expect(retried).toMatchObject({
    status: "moved",
    to: "project/0123456789abcdef/note-1",
  });
  expect(copies).toHaveLength(1);
  expect(device.get("note/000000001")?.value).toMatchObject({
    deleted: true,
    movedTo: "project/0123456789abcdef/note-1",
  });
}, 30_000);

test("without the transfer record the same retry leaves a duplicate", async () => {
  const { copies } = await crashJourney(loadEntry("memory", MOVE_FIX));
  expect(copies).toHaveLength(2);
}, 30_000);

/** A settled transfer, from the copy's own record: the copy was made and is not redone. */
const SETTLED_FIX = {
  from: "if (made && recorded) {",
  to: "if (false) {",
};

async function laterChange(
  entry: ReturnType<typeof loadEntry>,
  change: "edit" | "forget",
) {
  const stores = crashStores();
  await entry["memory.add"]!({
    input: { text: "copy me once", level: "device" },
    services: stores.services,
  });
  const request = () =>
    entry["memory.move"]!({
      input: {
        id: "device/note-1",
        to: "project",
        expectRevision: 1,
        keep: true,
      },
      services: stores.services,
    });
  const original = await request();
  // After the copy, someone edits or forgets it in the project.
  const copied = stores.project.get("note/000000001")!;
  stores.project.put(
    "note/000000001",
    change === "edit"
      ? { ...(copied.value as object), text: "edited after the copy" }
      : { text: "", tags: [], links: [], previous: [], deleted: true },
    { expectRevision: copied.revision },
  );
  const writes = () =>
    stores.project.counts.put + stores.project.counts.putMany;
  const before = writes();
  // A delayed retry of the same request.
  const retried = await request();
  return {
    original,
    retried,
    written: writes() - before,
    note: stores.project.get("note/000000001")!,
  };
}

test("a delayed retry after the copy was edited returns the first result and writes nothing", async () => {
  const { original, retried, written, note } = await laterChange(
    loadEntry("memory"),
    "edit",
  );
  expect(retried).toEqual(original);
  expect(written).toBe(0);
  expect(note.value).toMatchObject({ text: "edited after the copy" });
  expect(note.revision).toBe(2);
}, 30_000);

test("a delayed retry after the copy was forgotten does not bring it back", async () => {
  const { original, retried, written, note } = await laterChange(
    loadEntry("memory"),
    "forget",
  );
  expect(retried).toEqual(original);
  expect(written).toBe(0);
  expect(note.value).toMatchObject({ deleted: true });
}, 30_000);

test("without the settled-transfer check the same retries overwrite the edit and revive the forgotten copy", async () => {
  const edited = await laterChange(loadEntry("memory", SETTLED_FIX), "edit");
  expect(edited.written).toBe(1);
  expect(edited.note.value).toMatchObject({ text: "copy me once" });
  const forgotten = await laterChange(
    loadEntry("memory", SETTLED_FIX),
    "forget",
  );
  expect(forgotten.note.value).not.toMatchObject({ deleted: true });
}, 30_000);

test("a new copy of a changed source over a changed copy is a conflict, not a retry, and writes nothing", async () => {
  for (const change of ["edit", "forget"] as const) {
    const entry = loadEntry("memory");
    const stores = crashStores();
    await entry["memory.add"]!({
      input: { text: "copy me", level: "device" },
      services: stores.services,
    });
    const copy = (expectRevision: number) =>
      entry["memory.move"]!({
        input: {
          id: "device/note-1",
          to: "project",
          expectRevision,
          keep: true,
        },
        services: stores.services,
      });
    expect(await copy(1)).toMatchObject({ status: "copied" });
    // Both sides change: the source is edited to revision 2, and the copy is edited or forgotten.
    await entry["memory.add"]!({
      input: {
        id: "device/note-1",
        expectRevision: 1,
        text: "copy me, revised",
      },
      services: stores.services,
    });
    const copied = stores.project.get("note/000000001")!;
    stores.project.put(
      "note/000000001",
      change === "edit"
        ? { ...(copied.value as object), text: "edited copy" }
        : { text: "", tags: [], links: [], previous: [], deleted: true },
      { expectRevision: copied.revision },
    );
    const writes = () =>
      stores.project.counts.put + stores.project.counts.putMany;
    const before = writes();
    let refused: unknown;
    try {
      await copy(2);
    } catch (error) {
      refused = error;
    }
    expect(JSON.stringify(refused)).toContain("TRANSFER_CONFLICT");
    expect(writes() - before).toBe(0);
  }
}, 30_000);

test("a project export restored under another project identity keeps its links between its own notes", async () => {
  const entry = loadEntry("memory");
  const project = (id: string) => {
    const device = memoryState();
    const store = memoryState();
    const levels = {
      ...device,
      caller: "human" as const,
      inProject: true,
      project: () =>
        Promise.resolve({ identity: { id, name: "app" }, state: store }),
      peer: (ref: string) =>
        Promise.resolve({ status: "not_found" as const, ref }),
    };
    return { services: { state: device, levels }, store };
  };
  const OLD = "aaaaaaaaaaaaaaaa";
  const NEW = "bbbbbbbbbbbbbbbb";
  const first = project(OLD);
  const target = (await entry["memory.add"]!({
    input: { text: "the linked target", level: "project" },
    services: first.services,
  })) as { id: string };
  await entry["memory.add"]!({
    input: {
      text: "points at the target and elsewhere",
      level: "project",
      links: [target.id, "device/note-7", "project/cccccccccccccccc/note-9"],
    },
    services: first.services,
  });
  const exported = JSON.parse(
    JSON.stringify(
      await entry["memory.export"]!({
        input: { level: "project" },
        services: first.services,
      }),
    ),
  ) as unknown;
  // A new clone of the project, or another project, has its own identity.
  const clone = project(NEW);
  expect(
    await entry["memory.restore"]!({
      input: { ...(exported as object), approval: ownerApproval },
      services: clone.services,
    }),
  ).toEqual({ added: 2, skipped: 0, conflicts: [] });
  const shown = (await entry["memory.show"]!({
    input: { id: `project/${NEW}/note-2` },
    services: clone.services,
  })) as { note: { links: string[] } };
  expect(shown.note.links).toEqual([
    `project/${NEW}/note-1`,
    "device/note-7",
    "project/cccccccccccccccc/note-9",
  ]);
  expect(
    await entry["memory.show"]!({
      input: { id: shown.note.links[0]! },
      services: clone.services,
    }),
  ).toMatchObject({
    status: "found",
    note: { text: { text: "the linked target" } },
  });
}, 30_000);

test("a partial project export relinks only to the notes it restores", async () => {
  const entry = loadEntry("memory");
  const project = (id: string) => {
    const device = memoryState();
    const store = memoryState();
    const levels = {
      ...device,
      caller: "human" as const,
      inProject: true,
      project: () =>
        Promise.resolve({ identity: { id, name: "app" }, state: store }),
      peer: (ref: string) =>
        Promise.resolve({ status: "not_found" as const, ref }),
    };
    return { services: { state: device, levels }, store };
  };
  const OLD = "aaaaaaaaaaaaaaaa";
  const NEW = "bbbbbbbbbbbbbbbb";
  const first = project(OLD);
  const add = async (text: string, scope: string, links: string[] = []) =>
    (
      (await entry["memory.add"]!({
        input: { text, level: "project", scope, links },
        services: first.services,
      })) as { id: string }
    ).id;
  const kept = await add("restored target", "repo:a");
  const left = await add("left out of the export", "repo:b");
  await add("links to both", "repo:a", [kept, left]);
  // A scoped export carries the first and third notes, not the second.
  const exported = JSON.parse(
    JSON.stringify(
      await entry["memory.export"]!({
        input: { level: "project", scope: "repo:a" },
        services: first.services,
      }),
    ),
  ) as { notes: { id: string }[] };
  expect(exported.notes.map((note) => note.id)).toEqual([
    kept,
    `project/${OLD}/note-3`,
  ]);
  const clone = project(NEW);
  expect(
    await entry["memory.restore"]!({
      input: { ...(exported as object), approval: ownerApproval },
      services: clone.services,
    }),
  ).toEqual({ added: 2, skipped: 0, conflicts: [] });
  const shown = (await entry["memory.show"]!({
    input: { id: `project/${NEW}/note-3` },
    services: clone.services,
  })) as { note: { links: string[] } };
  // The restored note's link follows it; the link to the note left out is unchanged.
  expect(shown.note.links).toEqual([`project/${NEW}/note-1`, left]);
}, 30_000);
