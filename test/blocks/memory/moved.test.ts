import { expect, test } from "bun:test";
import { accepted, blockSchema, loadEntry, memoryState } from "./lib.ts";

const projectId = "0123456789abcdef";
const destination = `project/${projectId}/note-1`;

async function setup() {
  const project = memoryState();
  const device = memoryState(undefined, {
    inProject: true,
    defaultScope: "forge-new",
    project: () =>
      Promise.resolve({
        identity: { id: projectId, name: "forge-new" },
        state: project,
      }),
  });
  const entry = loadEntry("memory");
  const services = { state: device, levels: device };
  const call = (op: string, input: object) => entry[op]!({ input, services });
  // The accepted rule a first add and accept would leave, at revision 1 so the move needs no extra read.
  const at = new Date().toISOString();
  device.put(
    "note/000000001",
    {
      text: "moved rule",
      createdAt: at,
      changedAt: at,
      textAt: at,
      scope: "forge",
      tags: ["rule", "on:deploy"],
      links: [],
      previous: [],
    },
    { expectRevision: 0 },
  );
  device.put("meta/note-counter", { last: 1 }, { expectRevision: 0 });
  await call("memory.move", {
    id: "device/note-1",
    to: "project",
    expectRevision: 1,
  });
  return { project, device, entry, services, call };
}

test("rules count a moved project note with its old scope", async () => {
  const { call } = await setup();
  const pointer = (await call("memory.rules", {})) as {
    text: { text: string };
  };
  expect(pointer.text.text).toContain("forge-new 1");
}, 30_000);

test("the start packet includes a moved project rule with its old scope", async () => {
  const { call } = await setup();
  const packet = (await call("memory.rules", { notes: true })) as {
    text: { text: string };
    receipt: { selected: { id: string }[] };
  };
  expect(packet.receipt.selected.map((n) => n.id)).toEqual([destination]);
  expect(packet.text.text).toContain("moved rule");
}, 30_000);

for (const input of [
  { ids: [destination] },
  { ids: ["device/note-1"] },
  { labels: ["deploy"] },
]) {
  test(`attach selects a moved project note by ${JSON.stringify(input)}`, async () => {
    const { call, device, project } = await setup();
    const before = device.counts.get + project.counts.get;
    const attached = (await call("memory.attach", input)) as {
      receipt: { selected: { id: string; movedFrom?: string }[] };
    };
    expect(attached.receipt.selected).toHaveLength(1);
    expect(attached.receipt.selected[0]!.id).toBe(destination);
    if ("ids" in input && input.ids[0] === "device/note-1")
      expect(attached.receipt.selected[0]!.movedFrom).toBe("device/note-1");
    expect(device.counts.get + project.counts.get - before).toBe(
      "ids" in input && input.ids[0] === "device/note-1" ? 1 : 0,
    );
  }, 30_000);
}

test("attach accepts its unchanged moved selection as seen and suppresses the note", async () => {
  const { call } = await setup();
  const attached = JSON.parse(
    JSON.stringify(await call("memory.attach", { ids: ["device/note-1"] })),
  ) as {
    receipt: {
      selected: {
        id: string;
        movedFrom?: string;
        revision: number;
        scope: string;
        reasons: string[];
      }[];
    };
  };
  expect(attached.receipt.selected).toEqual([
    {
      id: destination,
      movedFrom: "device/note-1",
      revision: 1,
      scope: "forge",
      reasons: ["asked"],
    },
  ]);
  const input = {
    ids: ["device/note-1"],
    seen: attached.receipt.selected,
  };
  expect(blockSchema("memory", "attach.input.json")(input)).toEqual([]);
  const replay = (await call("memory.attach", input)) as {
    text: { text: string };
    receipt: { selected: unknown[]; omitted: unknown[] };
  };
  expect(replay.receipt.selected).toEqual([]);
  expect(replay.receipt.omitted).toEqual([
    {
      id: destination,
      movedFrom: "device/note-1",
      revision: 1,
      scope: "forge",
      reason: "seen",
    },
  ]);
  expect(replay.text.text).not.toContain("moved rule");
}, 30_000);

test("show follows one moved hop with exactly one extra record read", async () => {
  const { call, device, project } = await setup();
  const before = device.counts.get + project.counts.get;
  expect(await call("memory.show", { id: "device/note-1" })).toMatchObject({
    status: "found",
    note: {
      id: destination,
      movedFrom: "device/note-1",
      text: { text: "moved rule" },
    },
  });
  expect(device.counts.get + project.counts.get - before).toBe(2);
  const direct = device.counts.get + project.counts.get;
  await call("memory.show", { id: destination });
  expect(device.counts.get + project.counts.get - direct).toBe(1);
}, 30_000);

test("attaching a moved legacy note adds only the destination read, without repeating history reads", async () => {
  const { call, device, project } = await setup();
  project.put(
    "note/000000001",
    {
      text: "legacy moved rule",
      scope: "forge",
      tags: ["rule"],
      links: [],
      previous: [],
    },
    { expectRevision: 1 },
  );
  const reads = () =>
    device.counts.get +
    project.counts.get +
    device.counts.history +
    project.counts.history;
  const direct = reads();
  await call("memory.attach", { ids: [destination] });
  const baseline = reads() - direct;
  const old = reads();
  await call("memory.attach", { ids: ["device/note-1"] });
  expect(reads() - old).toBe(baseline + 1);
}, 30_000);

test("outside the destination project show and attach keep a pointer with a next step", async () => {
  const { entry, device } = await setup();
  for (const inProject of [false, true]) {
    const levels = memoryState(undefined, { inProject });
    const services = { state: device, levels };
    const pointer = (await entry["memory.show"]!({
      input: { id: "device/note-1" },
      services,
    })) as { next: string };
    expect(pointer).toMatchObject({ status: "moved", to: destination });
    expect(pointer.next).toContain(projectId);
    const attached = (await entry["memory.attach"]!({
      input: { ids: ["device/note-1"] },
      services,
    })) as {
      receipt: { moved: { to: string; next: string }[] };
    };
    expect(attached.receipt.moved[0]).toMatchObject({
      to: destination,
      next: pointer.next,
    });
  }
}, 30_000);

test("attach returns unresolved moved pointers once in requested id order", async () => {
  const { call, entry, device } = await setup();
  await call("memory.add", {
    level: "device",
    scope: "general",
    text: "live note",
  });
  for (const number of [3, 4]) {
    await call("memory.add", { level: "device", text: `moved note ${number}` });
    await call("memory.move", {
      id: `device/note-${number}`,
      to: "project",
      expectRevision: 1,
    });
  }
  const services = {
    state: device,
    levels: memoryState(undefined, { inProject: false }),
  };
  for (const [requested, moved, selected] of [
    [[4, 3, 1], [4, 3, 1], []],
    [[4, 99, 3, 2, 4, 1], [4, 3, 1], [2]],
    [[3, 1, 3, 99], [3, 1], []],
  ] as const) {
    const attached = (await entry["memory.attach"]!({
      input: { ids: requested.map((number) => `device/note-${number}`) },
      services,
    })) as {
      receipt: {
        moved: { id: string }[];
        selected: { id: string }[];
      };
    };
    expect(attached.receipt.moved.map((note) => note.id)).toEqual(
      moved.map((number) => `device/note-${number}`),
    );
    expect(attached.receipt.selected.map((note) => note.id)).toEqual(
      selected.map((number) => `device/note-${number}`),
    );
  }
}, 30_000);

test("a device note's unchanged old-id link resolves to the moved project note", async () => {
  const { call } = await setup();
  const added = (await call("memory.add", {
    level: "device",
    text: "linker",
    links: ["device/note-1"],
  })) as { id: string };
  const linker = (await call("memory.show", { id: added.id })) as {
    note: { links: string[] };
  };
  expect(linker.note.links).toEqual(["device/note-1"]);
  expect(await call("memory.show", { id: linker.note.links[0] })).toMatchObject(
    {
      status: "found",
      note: { id: destination, movedFrom: "device/note-1" },
    },
  );
}, 30_000);

test("a second moved tombstone returns its pointer without following again", async () => {
  const { call, project, device } = await setup();
  const record = project.get("note/000000001")!;
  project.put(
    record.key,
    {
      text: "",
      tags: [],
      links: [],
      previous: [],
      deleted: true,
      movedTo: "device/note-1",
    },
    { expectRevision: record.revision },
  );
  const before = device.counts.get + project.counts.get;
  expect(await call("memory.show", { id: "device/note-1" })).toMatchObject({
    status: "moved",
    to: "device/note-1",
  });
  expect(device.counts.get + project.counts.get - before).toBe(2);
  expect(await call("memory.attach", { ids: ["device/note-1"] })).toMatchObject(
    {
      receipt: { selected: [], moved: [{ to: "device/note-1" }] },
    },
  );
}, 30_000);

test("other device scopes stay excluded from rules and attachment", async () => {
  const { call } = await setup();
  const other = await accepted<{ id: string }>(call, {
    level: "device",
    scope: "other",
    text: "foreign rule",
    tags: ["rule", "on:deploy"],
  });
  expect(
    JSON.stringify(await call("memory.rules", { notes: true })),
  ).not.toContain("foreign rule");
  expect(
    JSON.stringify(
      await call("memory.attach", { ids: [other.id], labels: ["deploy"] }),
    ),
  ).not.toContain("foreign rule");
}, 30_000);
