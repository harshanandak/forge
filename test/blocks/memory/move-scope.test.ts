import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeFileCapture } from "../../../src/adapters/node-runtime/capture.ts";
import { Catalog, captureBlock } from "../../../src/core/catalog/index.ts";
import { Runtime } from "../../../src/core/runtime/index.ts";
import { TrustStore, admit, grant } from "../../fixtures/owner-approval.ts";
import {
  lintSkill,
  renderSkills,
  SKILL_MAX_BYTES,
} from "../../../src/surface/skills.ts";
import { runCli } from "../../../src/surface/cli.ts";
import {
  blockSchema,
  done,
  loadEntry,
  memoryState,
  openHarness,
  stageBlock,
} from "./lib.ts";

const projectId = "0123456789abcdef";
const input = { scope: "alpha", to: "project" };
type Batch = {
  status: string;
  moved: { id: string; to: string }[];
  complete: boolean;
  stopped?: { id: string; code: string };
  next?: string;
};

async function setup(count = 3, globals: Record<string, unknown> = {}) {
  const project = memoryState();
  const device = memoryState(undefined, {
    inProject: true,
    project: () =>
      Promise.resolve({
        identity: { id: projectId, name: "alpha" },
        projectId,
        state: project,
      }),
  });
  const entry = loadEntry("memory", undefined, globals);
  const services = { state: device, levels: device };
  const call = (op: string, value: object) =>
    entry[op]!({ input: value, services });
  for (let n = 1; n <= count; n += 1) {
    await call("memory.add", {
      level: "device",
      scope: "alpha",
      text: `old ${n}`,
      tags: ["fact"],
      links: ["device/note-1"],
    });
    await call("memory.add", {
      id: `device/note-${n}`,
      expectRevision: 1,
      text: `new ${n}`,
    });
  }
  return {
    project,
    device,
    entry,
    services,
    call,
    move: (value: object = input, deadline?: number) =>
      entry["memory.move"]!({
        input: value,
        services,
        ...(deadline === undefined ? {} : { deadline }),
      }) as Promise<Batch>,
  };
}

for (const budget of [15_000, 30_000]) {
  test(`scope returns a resumable partial batch before a ${budget} ms invocation expires`, async () => {
    let now = 1_000;
    const { entry, services, device, project, call } = await setup(100, {
      Date: class extends Date {
        static override now() {
          return now;
        }
      },
    });
    const putMany = project.putMany.bind(project);
    let commits = 0;
    project.putMany = (...args) => {
      // A late disk stall outgrows the previous slowest note plus the fixed 1 s reserve.
      for (const entry of args[0]) {
        if (entry.key.startsWith("note/"))
          now += (budget / 15_000) * (++commits === 17 ? 2_400 : 800);
      }
      return putMany(...args);
    };
    const root = mkdtempSync(join(tmpdir(), "move-deadline-"));
    try {
      const staged = stageBlock("memory", root);
      copyFileSync(
        join(staged, "forge.block.json"),
        join(staged, "block.json"),
      );
      const block = captureBlock(staged, nodeFileCapture);
      const catalog = new Catalog(
        {
          schemaVersion: "forge.config/1",
          blocks: {
            memory: {
              source: { path: "./memory" },
              operationTimeouts: { "memory.move": budget },
            },
          },
        },
        new Map([["memory", block]]),
        undefined,
        ["forge.state@1.0.0", "forge.project-state@1.0.0"],
      );
      const trust = new TrustStore();
      admit(trust, block.digest);
      grant(trust, block.digest, ["memory:write"]);
      const runtime = new Runtime(catalog, trust, {
        clock: { now: () => now },
        services: () =>
          Promise.resolve({ ownership: "borrowed", value: services }),
        isolation: {
          open: () =>
            Promise.resolve({
              ok: true,
              handle: {
                ownership: "owned",
                close: () => Promise.resolve(),
                value: {
                  async run(options) {
                    return options.encode(
                      await entry[options.operation]!(
                        options.args as Parameters<(typeof entry)[string]>[0],
                      ),
                    );
                  },
                },
              },
            }),
        },
      });
      const moved: Batch["moved"] = [];
      let complete = false;
      for (let batch = 0; batch <= 100 && !complete; batch++) {
        const started = now;
        const result = await runtime.invoke({
          schemaVersion: "forge.invocation/1",
          requestId: `move-${batch}`,
          op: "memory.move",
          input: { ...input, limit: 100 },
          caller: "human",
          context: {
            actor: { kind: "human", id: "tester" },
            device: { id: "test" },
          },
        });
        expect(result).toMatchObject({ ok: true });
        expect(now - started).toBeLessThan(budget);
        const value = done(result) as Batch;
        expect(value.stopped).toBeUndefined();
        if (batch === 0) {
          expect(value.moved.length).toBeGreaterThan(0);
          expect(value.moved.length).toBeLessThan(100);
        }
        moved.push(...value.moved);
        complete = value.complete;
        expect(value.next).toBe(
          complete
            ? undefined
            : "forge memory move --scope alpha --to project --limit 100",
        );
      }
      expect(complete).toBe(true);
      expect(moved).toHaveLength(100);
      expect(new Set(moved.map((note) => note.id)).size).toBe(100);
      expect(new Set(moved.map((note) => note.to)).size).toBe(100);
      expect(project.list("note/")).toHaveLength(100);
      for (const [i, { id, to }] of moved.entries()) {
        expect(
          device.get(`note/${String(i + 1).padStart(9, "0")}`)?.value,
        ).toMatchObject({
          deleted: true,
          movedTo: to,
        });
        expect(await call("memory.show", { id })).toMatchObject({
          note: {
            id: to,
            movedFrom: id,
            text: { text: `new ${i + 1}` },
            tags: ["fact"],
            links: ["device/note-1"],
            versions: [{ revision: 1 }, { revision: 2 }],
          },
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
}

test("scope resizes a collected group after sparse matches consume page-read budget", async () => {
  let now = 1_000;
  const { move, call, device, project } = await setup(8, {
    Date: class extends Date {
      static override now() {
        return now;
      }
    },
  });
  for (let n = 0; n < 592; n += 1)
    await call("memory.add", { level: "device", scope: "beta", text: "other" });
  await call("memory.add", { level: "device", scope: "alpha", text: "last" });
  const page = device.listRange.bind(device);
  device.listRange = (...args) => {
    now += 2_000;
    return page(...args);
  };
  const putMany = project.putMany.bind(project);
  project.putMany = (entries) => {
    now +=
      entries.filter((entry) => entry.key.startsWith("note/")).length * 1_000;
    return putMany(entries);
  };
  const first = await move({ ...input, limit: 100 }, 16_000);
  expect(now).toBeLessThan(16_000);
  expect(first.stopped).toBeUndefined();
  expect(first.complete).toBe(false);
  expect(first.moved.length).toBeGreaterThan(0);
  expect(first.moved.some((note) => note.id === "device/note-601")).toBe(false);
  expect(device.get("note/000000601")?.value).toMatchObject({
    scope: "alpha",
    text: "last",
  });
  expect(device.get("note/000000601")?.revision).toBe(1);
  const resumed = await move({ ...input, limit: 100 });
  const moved = [...first.moved, ...resumed.moved];
  expect(moved.map((note) => note.id)).toEqual([
    ...Array.from({ length: 8 }, (_, i) => `device/note-${i + 1}`),
    "device/note-601",
  ]);
  expect(new Set(moved.map((note) => note.to)).size).toBe(9);
  expect(project.list("note/")).toHaveLength(9);
  expect(await move()).toMatchObject({ moved: [], complete: true });
}, 30_000);

test("scope reserves buffered writes while scanning a long other-scope tail", async () => {
  let now = 1_000;
  const { move, call, device, project } = await setup(10, {
    Date: class extends Date {
      static override now() {
        return now;
      }
    },
  });
  for (let n = 0; n < 1_000; n += 1)
    await call("memory.add", { level: "device", scope: "beta", text: "other" });
  const page = device.listRange.bind(device);
  let pages = 0;
  device.listRange = (...args) => {
    pages += 1;
    now += 2_000;
    return page(...args);
  };
  const putMany = project.putMany.bind(project);
  project.putMany = (entries) => {
    now +=
      entries.filter((entry) => entry.key.startsWith("note/")).length * 800;
    return putMany(entries);
  };
  const first = await move({ ...input, limit: 100 }, 16_000);
  expect(now).toBeLessThan(16_000);
  expect(pages).toBeLessThan(6);
  expect(first.stopped).toBeUndefined();
  expect(first.complete).toBe(false);
  expect(first.moved.length).toBeGreaterThan(0);
  const resumed = await move({ ...input, limit: 100 });
  const moved = [...first.moved, ...resumed.moved];
  expect(moved.map((note) => note.id)).toEqual(
    Array.from({ length: 10 }, (_, i) => `device/note-${i + 1}`),
  );
  expect(new Set(moved.map((note) => note.to)).size).toBe(10);
  expect(project.list("note/")).toHaveLength(10);
  expect(await move()).toMatchObject({ moved: [], complete: true });
}, 30_000);

test("scope rechecks the write budget after destination preparation", async () => {
  let now = 1_000;
  const { move, device, project } = await setup(8, {
    Date: class extends Date {
      static override now() {
        return now;
      }
    },
  });
  const get = project.get.bind(project);
  project.get = (key) => {
    if (key.startsWith("transfer/") && key !== "transfer/device/note-1")
      now += 600;
    return get(key);
  };
  const putMany = project.putMany.bind(project);
  project.putMany = (entries) => {
    now +=
      entries.filter((entry) => entry.key.startsWith("note/")).length * 1_000;
    return putMany(entries);
  };
  const first = await move({ ...input, limit: 100 }, 16_000);
  expect(now).toBeLessThan(16_000);
  expect(first.stopped).toBeUndefined();
  expect(first.moved.length).toBeGreaterThan(0);
  expect(first.complete).toBe(false);
  expect(device.get("note/000000008")?.revision).toBe(2);
  const resumed = await move({ ...input, limit: 100 });
  const moved = [...first.moved, ...resumed.moved];
  expect(moved.map((note) => note.id)).toEqual(
    Array.from({ length: 8 }, (_, i) => `device/note-${i + 1}`),
  );
  expect(new Set(moved.map((note) => note.to)).size).toBe(8);
  expect(project.list("note/")).toHaveLength(8);
}, 30_000);

test("scope rechecks the budget between conflict fallback retirements and verification", async () => {
  let now = 1_000;
  const { move, device, project } = await setup(10, {
    Date: class extends Date {
      static override now() {
        return now;
      }
    },
  });
  const putMany = project.putMany.bind(project);
  project.putMany = (entries) => {
    now +=
      entries.filter((entry) => entry.key.startsWith("note/")).length * 800;
    return putMany(entries);
  };
  const sourcePutMany = device.putMany.bind(device);
  let conflicted = false;
  device.putMany = (entries) => {
    if (!conflicted) {
      conflicted = true;
      now += 2_000;
      return sourcePutMany(
        entries.map((entry, i) =>
          i === 0 ? { ...entry, expectRevision: 0 } : entry,
        ),
      );
    }
    return sourcePutMany(entries);
  };
  const put = device.put.bind(device);
  device.put = (...args) => {
    if (args[0] !== "note/000000001") now += 2_000;
    return put(...args);
  };
  const get = device.get.bind(device);
  device.get = (key) => {
    const record = get(key);
    if ((record?.value as { deleted?: boolean } | undefined)?.deleted)
      now += 1_000;
    return record;
  };
  const first = await move({ ...input, limit: 100 }, 16_000);
  expect(conflicted).toBe(true);
  expect(now).toBeLessThan(16_000);
  expect(first.stopped).toBeUndefined();
  expect(first.complete).toBe(false);
  expect(first.moved.map((note) => note.id)).toEqual([
    "device/note-1",
    "device/note-2",
  ]);
  expect(device.get("note/000000003")?.revision).toBe(2);
  const resumed = await move({ ...input, limit: 100 });
  const moved = [...first.moved, ...resumed.moved];
  expect(moved.map((note) => note.id)).toEqual(
    Array.from({ length: 10 }, (_, i) => `device/note-${i + 1}`),
  );
  expect(new Set(moved.map((note) => note.to)).size).toBe(10);
  expect(project.list("note/")).toHaveLength(10);
  expect(await move()).toMatchObject({ moved: [], complete: true });
}, 30_000);

test("scope budgets each note's reads after sparse scanning reaches a page of matches", async () => {
  let now = 1_000;
  const { move, call, device, project } = await setup(2, {
    Date: class extends Date {
      static override now() {
        return now;
      }
    },
  });
  for (let n = 0; n < 1_998; n += 1)
    await call("memory.add", { level: "device", scope: "beta", text: "other" });
  for (let n = 0; n < 16; n += 1)
    await call("memory.add", {
      level: "device",
      scope: "alpha",
      text: `last ${n}`,
    });
  const page = device.listRange.bind(device);
  device.listRange = (...args) => {
    now += 2_000;
    return page(...args);
  };
  const get = project.get.bind(project);
  project.get = (key) => {
    if (key.startsWith("transfer/")) now += 600;
    return get(key);
  };
  const first = await move({ ...input, limit: 100 }, 30_000);
  expect(now).toBeLessThan(30_000);
  expect(first.stopped).toBeUndefined();
  expect(first.complete).toBe(false);
  expect(first.moved.length).toBeGreaterThan(0);
  expect(device.get("note/000002016")?.revision).toBe(1);
  const resumed = await move({ ...input, limit: 100 });
  const moved = [...first.moved, ...resumed.moved];
  expect(moved.map((note) => note.id)).toEqual([
    "device/note-1",
    "device/note-2",
    ...Array.from({ length: 16 }, (_, i) => `device/note-${i + 2_001}`),
  ]);
  expect(new Set(moved.map((note) => note.to)).size).toBe(18);
  expect(project.list("note/")).toHaveLength(18);
  expect(await move()).toMatchObject({ moved: [], complete: true });
}, 30_000);

test("scope budgets buffered marker re-checks and resumes all 100 notes without duplicates", async () => {
  let now = 1_000;
  const { move, call, device, project } = await setup(100, {
    Date: class extends Date {
      static override now() {
        return now;
      }
    },
  });
  const get = project.get.bind(project);
  project.get = (key) => {
    if (key.startsWith("transfer/") && key !== "transfer/device/note-1")
      now += 600;
    return get(key);
  };
  const putMany = project.putMany.bind(project);
  project.putMany = (entries) => {
    now +=
      entries.filter((entry) => entry.key.startsWith("note/")).length * 100;
    return putMany(entries);
  };
  const deadline = now + 15_000;
  const first = await move({ ...input, limit: 100 }, deadline);
  expect(now).toBeLessThan(deadline);
  expect(first.stopped).toBeUndefined();
  expect(first.complete).toBe(false);
  expect(first.moved.length).toBeGreaterThan(0);
  expect(first.moved.length).toBeLessThan(100);
  expect(first.next).toBe(
    "forge memory move --scope alpha --to project --limit 100",
  );
  const resumed = await move({ ...input, limit: 100 });
  expect(resumed.stopped).toBeUndefined();
  const moved = [...first.moved, ...resumed.moved];
  expect(moved.map((note) => note.id)).toEqual(
    Array.from({ length: 100 }, (_, i) => `device/note-${i + 1}`),
  );
  expect(new Set(moved.map((note) => note.to)).size).toBe(100);
  expect(project.list("note/")).toHaveLength(100);
  for (const [i, { id, to }] of moved.entries()) {
    expect(
      device.get(`note/${String(i + 1).padStart(9, "0")}`)?.value,
    ).toMatchObject({ deleted: true, movedTo: to });
    expect(await call("memory.show", { id })).toMatchObject({
      note: { id: to, text: { text: `new ${i + 1}` } },
    });
  }
  expect(await move()).toMatchObject({ moved: [], complete: true });
}, 30_000);

test("scope input and batch output are admitted alongside unchanged single moves", async () => {
  expect(blockSchema("memory", "move.input.json")(input)).toEqual([]);
  expect(
    blockSchema(
      "memory",
      "move.input.json",
    )({ id: "device/note-1", to: "project", expectRevision: 1 }),
  ).toEqual([]);
  const { move } = await setup();
  const result = await move();
  expect(result).not.toHaveProperty("remaining");
  expect(
    blockSchema(
      "memory",
      "move.output.json",
    )(JSON.parse(JSON.stringify(result))),
  ).toEqual([]);
}, 30_000);

test("scope move docs and generated skill describe bounded completion within the skill cap", async () => {
  const h = await openHarness(["memory"]);
  try {
    const catalog = h.assembly.catalog.list();
    const docs = catalog.find((entry) => entry.op === "memory.move")!.docs;
    expect(docs.description).toContain("single atomic store read or move");
    expect(docs.description).toContain("full scan exceeds the call budget");
    expect(docs.description).toContain(
      "complete only when the scan reaches the end and moves 0 notes",
    );
    expect(docs.description).toContain("one zero-move confirmation call");
    expect(docs.description).not.toContain("remaining live device notes");
    const skill = renderSkills(catalog).find(
      (file) => file.noun === "memory",
    )!.text;
    expect(skill).toContain("moved.length");
    expect(skill).toContain(
      "complete only when the scan reaches the end and moves 0 notes",
    );
    expect(Buffer.byteLength(skill)).toBeLessThanOrEqual(SKILL_MAX_BYTES);
    expect(lintSkill(skill, catalog)).toEqual([]);
  } finally {
    await h.close();
  }
}, 30_000);

test("scope batches move 25, then 5, then zero, preserving every record and old-id resolution", async () => {
  const { move, call, device, project } = await setup(30);
  for (const scope of ["beta", "beta", "beta", "general", "general"])
    await call("memory.add", { level: "device", scope, text: scope });
  const originals = device.list("note/");
  const first = await move();
  expect(first).toMatchObject({
    status: "moved",
    complete: false,
  });
  expect(first.moved.map((n) => n.id)).toEqual(
    Array.from({ length: 25 }, (_, i) => `device/note-${i + 1}`),
  );
  expect(first.next).toBe(
    "forge memory move --scope alpha --to project --limit 25",
  );
  const second = await move();
  expect(second).toMatchObject({ complete: false });
  expect(second.moved).toHaveLength(5);
  expect(second.next).toBe(
    "forge memory move --scope alpha --to project --limit 25",
  );
  const confirmation = await move();
  expect(confirmation).toMatchObject({ moved: [], complete: true });
  expect(confirmation.next).toBeUndefined();
  for (const { id, to } of [...first.moved, ...second.moved]) {
    const n = Number(id.split("-").at(-1));
    const source = originals.find(
      (r) => r.key === `note/${String(n).padStart(9, "0")}`,
    )!;
    const destination = project.get(
      `note/${to.split("-").at(-1)!.padStart(9, "0")}`,
    )!;
    expect(destination.value).toMatchObject(source.value as object);
    expect(device.get(source.key)?.value).toMatchObject({
      deleted: true,
      movedTo: to,
    });
    expect(await call("memory.show", { id })).toMatchObject({
      status: "found",
      note: {
        id: to,
        movedFrom: id,
        text: { text: `new ${n}` },
        versions: [{ revision: 1 }, { revision: 2 }],
      },
    });
  }
  expect(device.list("note/").slice(30)).toEqual(originals.slice(30));
}, 30_000);

test("scope moves 100 notes with at most five write commits per store", async () => {
  const { move, call, device, project } = await setup(100);
  const originals = device.list("note/");
  const projectWrites = project.counts.putMany;
  const deviceWrites = device.counts.put + device.counts.putMany;
  const result = await move({ ...input, limit: 100 });
  expect(result).toMatchObject({ complete: false });
  expect(result.stopped).toBeUndefined();
  expect(result.moved).toHaveLength(100);
  expect(project.counts.putMany - projectWrites).toBeLessThanOrEqual(5);
  expect(
    device.counts.put + device.counts.putMany - deviceWrites,
  ).toBeLessThanOrEqual(5);
  expect(project.list("note/")).toHaveLength(100);
  for (const [i, { id, to }] of result.moved.entries()) {
    expect(id).toBe(`device/note-${i + 1}`);
    const original = originals[i]!;
    const destination = project.get(
      `note/${to.split("-").at(-1)!.padStart(9, "0")}`,
    )!;
    expect(destination.value).toMatchObject(original.value as object);
    expect(device.get(original.key)?.value).toMatchObject({
      deleted: true,
      movedTo: to,
    });
    expect(await call("memory.show", { id })).toMatchObject({
      status: "found",
      note: {
        id: to,
        movedFrom: id,
        text: { text: `new ${i + 1}` },
        tags: ["fact"],
        links: ["device/note-1"],
        versions: [{ revision: 1 }, { revision: 2 }],
      },
    });
    expect(await call("memory.show", { id, revision: 1 })).toMatchObject({
      note: { text: { text: `old ${i + 1}` } },
    });
  }
  expect(await move({ ...input, limit: 100 })).toMatchObject({
    moved: [],
    complete: true,
  });
}, 30_000);

test("scope batch retires notes in order up to a concurrent source edit and resumes without duplicates", async () => {
  const { move, call, device, project } = await setup(6);
  const key = "note/000000004";
  const putMany = device.putMany.bind(device);
  let raced = false;
  device.putMany = (entries) => {
    if (!raced && entries.some((entry) => entry.key === key)) {
      raced = true;
      const original = device.get(key)!;
      device.put(
        key,
        { ...(original.value as object), text: "concurrent 4" },
        { expectRevision: original.revision },
      );
    }
    return putMany(entries);
  };
  const first = await move();
  expect(raced).toBe(true);
  expect(first).toMatchObject({
    moved: [
      { id: "device/note-1" },
      { id: "device/note-2" },
      { id: "device/note-3" },
    ],
    stopped: { id: "device/note-4", code: "REVISION_CONFLICT" },
    complete: false,
  });
  expect(first.moved).toHaveLength(3);
  expect(project.list("note/")).toHaveLength(6);
  expect(device.get(key)).toMatchObject({
    revision: 3,
    value: { text: "concurrent 4" },
  });
  for (const n of [5, 6])
    expect(device.get(`note/${String(n).padStart(9, "0")}`)?.revision).toBe(2);
  await expect(move()).rejects.toMatchObject({
    error: { code: "TRANSFER_CONFLICT" },
  });
  expect(project.list("note/")).toHaveLength(6);
  // Reconcile the edited source into its existing copy before explicitly retiring that source.
  const marker = project.get("transfer/device/note-4")!.value as {
    number: number;
  };
  const to = `project/${projectId}/note-${marker.number}`;
  await call("memory.add", { id: to, expectRevision: 1, text: "concurrent 4" });
  device.put(key, { deleted: true, movedTo: to }, { expectRevision: 3 });
  const resumed = await move();
  expect(resumed).toMatchObject({
    moved: [{ id: "device/note-5" }, { id: "device/note-6" }],
    complete: false,
  });
  expect(resumed.moved).toHaveLength(2);
  expect(resumed.stopped).toBeUndefined();
  expect(await move()).toMatchObject({ moved: [], complete: true });
  expect(project.list("note/")).toHaveLength(6);
  expect(
    new Set(
      project
        .list("note/")
        .map((note) => (note.value as { from: string }).from),
    ).size,
  ).toBe(6);
  for (let n = 1; n <= 6; n += 1) {
    expect(
      device.get(`note/${String(n).padStart(9, "0")}`)?.value,
    ).toMatchObject({ deleted: true });
    expect(await call("memory.show", { id: `device/note-${n}` })).toMatchObject(
      {
        note: { text: { text: n === 4 ? "concurrent 4" : `new ${n}` } },
      },
    );
  }
}, 30_000);

function expectReportedRetirements(
  device: ReturnType<typeof memoryState>,
  project: ReturnType<typeof memoryState>,
  batches: readonly Batch[],
) {
  const sources = device.list("note/");
  const copies = project.list("note/");
  const retired = sources.flatMap((record) => {
    const value = record.value as { deleted?: boolean; movedTo?: string };
    return value.deleted === true &&
      value.movedTo?.startsWith(`project/${projectId}/`)
      ? [
          {
            id: `device/note-${Number(record.key.slice(5))}`,
            to: value.movedTo,
          },
        ]
      : [];
  });
  const byId = (a: { id: string }, b: { id: string }) =>
    a.id.localeCompare(b.id);
  expect(batches.flatMap((batch) => batch.moved).sort(byId)).toEqual(
    retired.sort(byId),
  );
  for (const source of sources) {
    const id = `device/note-${Number(source.key.slice(5))}`;
    expect(
      copies.filter((copy) => (copy.value as { from?: string }).from === id),
    ).toHaveLength(1);
  }
}

test("scope reports an edited existing copy after retiring its source and resumes without duplicates", async () => {
  const { move, call, device, project } = await setup(5);
  const copied = (await call("memory.move", {
    id: "device/note-2",
    to: "project",
    expectRevision: 2,
    keep: true,
  })) as { to: string };
  await call("memory.add", {
    id: copied.to,
    expectRevision: 1,
    text: "edited at destination",
  });
  const first = await move();
  expect(first.moved.map((pair) => pair.id)).toEqual([
    "device/note-1",
    "device/note-2",
  ]);
  expect(first).toMatchObject({
    stopped: { id: "device/note-2", code: "VERIFY_FAILED" },
    complete: false,
  });
  const second = await move();
  expect(second.moved.map((pair) => pair.id)).toEqual([
    "device/note-3",
    "device/note-4",
    "device/note-5",
  ]);
  expect(second.complete).toBe(false);
  expect(second.stopped).toBeUndefined();
  const confirmation = await move();
  expect(confirmation).toMatchObject({ moved: [], complete: true });
  expect(confirmation.stopped).toBeUndefined();
  expect(project.list("note/")).toHaveLength(5);
  expect(await call("memory.show", { id: copied.to })).toMatchObject({
    note: { text: { text: "edited at destination" } },
  });
  expectReportedRetirements(device, project, [first, second, confirmation]);
}, 30_000);

for (const fault of [
  "edited copy",
  "copy missing after retirement",
  "source missing after retirement",
  "copy missing before retirement",
]) {
  test(`scope reports every grouped retirement with ${fault}`, async () => {
    const { move, device, project } = await setup(6);
    const key = "note/000000003";
    const sourceGet = device.get.bind(device);
    const copyGet = project.get.bind(project);
    if (fault === "source missing after retirement") {
      device.get = (readKey) => {
        const record = sourceGet(readKey);
        return readKey === key && record && record.revision >= 3
          ? undefined
          : record;
      };
    } else {
      project.get = (readKey) => {
        const record = copyGet(readKey);
        if (readKey !== key || !record) return record;
        if (fault === "edited copy")
          return {
            ...record,
            value: { ...(record.value as object), text: "edited copy" },
          };
        const source = sourceGet(key)?.value as { deleted?: boolean };
        return fault === "copy missing before retirement" ||
          source.deleted === true
          ? undefined
          : record;
      };
    }
    const first = await move();
    const beforeRetirement = fault === "copy missing before retirement";
    expect(first.moved.map((pair) => pair.id)).toEqual(
      Array.from(
        { length: beforeRetirement ? 2 : 6 },
        (_, i) => `device/note-${i + 1}`,
      ),
    );
    expect(first).toMatchObject({
      stopped: {
        id: "device/note-3",
        code: beforeRetirement ? "REVISION_CONFLICT" : "VERIFY_FAILED",
      },
      complete: false,
    });
    const batches = [first];
    if (beforeRetirement) {
      for (let n = 3; n <= 6; n += 1)
        expect(sourceGet(`note/${String(n).padStart(9, "0")}`)).toMatchObject({
          revision: 2,
          value: { text: `new ${n}` },
        });
    } else {
      const confirmation = await move();
      expect(confirmation).toMatchObject({ moved: [], complete: true });
      expect(confirmation.stopped).toBeUndefined();
      batches.push(confirmation);
    }
    expect(project.list("note/")).toHaveLength(6);
    expectReportedRetirements(device, project, batches);
  }, 30_000);
}

for (const sourceConflict of [true, false]) {
  test(`scope preserves a source whose copy was forgotten before ${sourceConflict ? "conflicting" : "conflict-free"} grouped retirement`, async () => {
    const { move, call, device, project } = await setup(6);
    const copyKey = "note/000000003";
    let forgotten = false;
    const forgetCopy = () => {
      const copy = project.get(copyKey)!;
      project.put(
        copyKey,
        { deleted: true, text: "", tags: [], links: [], previous: [] },
        { expectRevision: copy.revision },
      );
      forgotten = true;
    };
    if (sourceConflict) {
      const putMany = device.putMany.bind(device);
      device.putMany = (entries) => {
        if (
          !forgotten &&
          entries.some((entry) => entry.key === "note/000000004")
        ) {
          const source = device.get("note/000000004")!;
          device.put(
            source.key,
            { ...(source.value as object), text: "concurrent 4" },
            { expectRevision: source.revision },
          );
          forgetCopy();
        }
        return putMany(entries);
      };
    } else {
      const putMany = project.putMany.bind(project);
      project.putMany = (entries) => {
        const result = putMany(entries);
        if (
          !forgotten &&
          entries.some((entry) => entry.key === "transfer/device/note-3")
        )
          forgetCopy();
        return result;
      };
    }
    const result = await move();
    expect(forgotten).toBe(true);
    expect(result).toMatchObject({
      moved: [{ id: "device/note-1" }, { id: "device/note-2" }],
      stopped: { id: "device/note-3", code: "TRANSFER_CONFLICT" },
      complete: false,
    });
    expect(result.moved).toHaveLength(2);
    expect(device.get(copyKey)).toMatchObject({
      revision: 2,
      value: { text: "new 3" },
    });
    expect(project.get(copyKey)?.value).toMatchObject({ deleted: true });
    expect(await call("memory.show", { id: "device/note-3" })).toMatchObject({
      status: "found",
      note: { id: "device/note-3", text: { text: "new 3" } },
    });
    expect(device.get("note/000000004")).toMatchObject({
      revision: sourceConflict ? 3 : 2,
      value: { text: sourceConflict ? "concurrent 4" : "new 4" },
    });
    expect(project.list("note/")).toHaveLength(6);
    for (let n = 1; n <= 6; n += 1) {
      const key = `note/${String(n).padStart(9, "0")}`;
      const source = device.get(key)!.value as { deleted?: boolean };
      const copy = project.get(key)!.value as { deleted?: boolean };
      expect(source.deleted !== true || copy.deleted !== true).toBe(true);
      if (n > 3) expect(source.deleted).toBeUndefined();
    }
  }, 30_000);
}

test("scope batch recovers all committed copies after a fault before grouped source retirement", async () => {
  const { move, call, device, project } = await setup(6);
  const putMany = device.putMany.bind(device);
  let crashed = false;
  device.putMany = (entries) => {
    if (!crashed && entries.length > 1) {
      crashed = true;
      throw new Error("crash before grouped tombstones");
    }
    return putMany(entries);
  };
  await expect(move()).rejects.toThrow("crash before grouped tombstones");
  expect(crashed).toBe(true);
  const copies = project.list("note/");
  expect(copies).toHaveLength(6);
  expect(device.get("note/000000001")?.value).toMatchObject({ deleted: true });
  for (let n = 2; n <= 6; n += 1)
    expect(device.get(`note/${String(n).padStart(9, "0")}`)?.revision).toBe(2);
  const resumed = await move();
  expect(resumed.moved.map((note) => note.id)).toEqual(
    Array.from({ length: 5 }, (_, i) => `device/note-${i + 2}`),
  );
  expect(resumed.stopped).toBeUndefined();
  expect(await move()).toMatchObject({ moved: [], complete: true });
  expect(project.list("note/")).toEqual(copies);
  for (let n = 1; n <= 6; n += 1) {
    expect(
      device.get(`note/${String(n).padStart(9, "0")}`)?.value,
    ).toMatchObject({
      deleted: true,
      movedTo: `project/${projectId}/note-${n}`,
    });
    expect(await call("memory.show", { id: `device/note-${n}` })).toMatchObject(
      {
        note: {
          text: { text: `new ${n}` },
          versions: [{ revision: 1 }, { revision: 2 }],
        },
      },
    );
  }
}, 30_000);

test("scope scan passes pages of tombstones and other scopes and uses stored scope exactly", async () => {
  const { move, call, device } = await setup(0);
  for (let n = 0; n < 205; n += 1)
    await call("memory.add", { level: "device", scope: "beta", text: "other" });
  await call("memory.add", { level: "device", scope: "alpha", text: "last" });
  expect(await move({ ...input, limit: 1 })).toMatchObject({
    moved: [{ id: "device/note-206" }],
    complete: false,
    next: "forge memory move --scope alpha --to project --limit 1",
  });
  const confirmation = await move();
  expect(confirmation).toMatchObject({ moved: [], complete: true });
  expect(confirmation.next).toBeUndefined();
  expect(
    device
      .list("note/")
      .filter((r) => (r.value as { deleted?: boolean }).deleted !== true),
  ).toHaveLength(205);
}, 30_000);

test("scope deadline keeps the slowest note estimate and resumes the remaining notes", async () => {
  let now = 1_000;
  const { move, device, project } = await setup(4, {
    Date: class extends Date {
      static override now() {
        return now;
      }
    },
  });
  const put = device.put.bind(device);
  const durations = [3_000, 1_000, 4_000, 1_000];
  device.put = (...args) => {
    now += durations.shift()!;
    return put(...args);
  };
  const first = await move(input, 8_500);
  expect(now).toBe(5_000);
  expect(first).toMatchObject({
    moved: [{ id: "device/note-1" }, { id: "device/note-2" }],
    complete: false,
    next: "forge memory move --scope alpha --to project --limit 25",
  });
  expect(first.stopped).toBeUndefined();
  expect(project.list("note/")).toHaveLength(2);
  expect(device.get("note/000000003")?.revision).toBe(2);
  expect(await move(input, 20_000)).toMatchObject({
    moved: [{ id: "device/note-3" }, { id: "device/note-4" }],
    complete: false,
    next: "forge memory move --scope alpha --to project --limit 25",
  });
  const confirmation = await move(input, 20_000);
  expect(confirmation).toMatchObject({ moved: [], complete: true });
  expect(confirmation.next).toBeUndefined();
  expect(project.list("note/")).toHaveLength(4);
}, 30_000);

test("scope moves after a slow first page and confirms completion on the next call", async () => {
  let now = 1_000;
  const { move, device, project, call } = await setup(1, {
    Date: class extends Date {
      static override now() {
        return now;
      }
    },
  });
  const page = device.listRange.bind(device);
  device.listRange = (...args) => {
    now += 13_600;
    return page(...args);
  };
  const putMany = project.putMany.bind(project);
  project.putMany = (...args) => {
    now += 100;
    return putMany(...args);
  };
  const started = now;
  const first = await move(input, now + 15_000);
  expect(now - started).toBe(13_700);
  expect(first).toMatchObject({
    moved: [{ id: "device/note-1", to: `project/${projectId}/note-1` }],
    complete: false,
    next: "forge memory move --scope alpha --to project --limit 25",
  });
  expect(first.stopped).toBeUndefined();
  const confirmationStarted = now;
  const confirmation = await move(input, now + 15_000);
  expect(now - confirmationStarted).toBe(13_600);
  expect(confirmation).toEqual({ status: "moved", moved: [], complete: true });
  expect(project.list("note/")).toHaveLength(1);
  expect(device.get("note/000000001")?.value).toMatchObject({
    deleted: true,
    movedTo: first.moved[0]!.to,
  });
  expect(await call("memory.show", { id: "device/note-1" })).toMatchObject({
    note: { id: first.moved[0]!.to, text: { text: "new 1" } },
  });
}, 30_000);

test("scope refuses the first move below its one-second floor without destination writes", async () => {
  let now = 1_000;
  const { move, device, project } = await setup(1, {
    Date: class extends Date {
      static override now() {
        return now;
      }
    },
  });
  const sourceWrites = device.counts.puttedRecords;
  const page = device.listRange.bind(device);
  device.listRange = (...args) => {
    now += 14_600;
    return page(...args);
  };
  const putMany = project.putMany.bind(project);
  project.putMany = (...args) => {
    now += 800;
    return putMany(...args);
  };
  const started = now;
  await expect(move(input, now + 15_000)).rejects.toMatchObject({
    error: { code: "INSUFFICIENT_BUDGET" },
  });
  expect(now - started).toBe(14_600);
  expect(project.counts.putMany).toBe(0);
  expect(project.counts.puttedRecords).toBe(0);
  expect(project.list("note/")).toHaveLength(0);
  expect(device.get("note/000000001")?.revision).toBe(2);
  expect(device.counts.puttedRecords).toBe(sourceWrites);
}, 30_000);

for (const budget of [0, 999, 1_000, 2_000]) {
  test(`scope deadline respects a ${budget} ms budget before the first page`, async () => {
    let now = 1_000;
    const { move, device, project } = await setup(2, {
      Date: class extends Date {
        static override now() {
          return now;
        }
      },
    });
    const page = device.listRange.bind(device);
    device.listRange = (...args) => {
      now += 100;
      return page(...args);
    };
    if (budget <= 1_000) {
      await expect(
        move({ ...input, limit: 1 }, 1_000 + budget),
      ).rejects.toThrow(
        'INSUFFICIENT_BUDGET: Scope move made no progress within its budget. Increase blocks.memory.operationTimeouts["memory.move"] in .forge/config.yaml',
      );
      expect(project.list("note/")).toHaveLength(0);
    } else {
      const result = await move({ ...input, limit: 1 }, 1_000 + budget);
      expect(result).toMatchObject({
        complete: false,
        next: "forge memory move --scope alpha --to project --limit 1",
      });
      expect(result.stopped).toBeUndefined();
      expect(result.moved).toHaveLength(1);
      expect(project.list("note/")).toHaveLength(1);
    }
    expect(device.counts.listedRecords).toBe(budget <= 1_000 ? 0 : 2);
    expect(device.get("note/000000002")?.revision).toBe(2);
  }, 30_000);
}

for (const step of ["setup", "move", "verify", "page"]) {
  test(`scope deadline bounds injected slow ${step} steps with progress`, async () => {
    let now = 1_000;
    const { move, device, project } = await setup(100, {
      Date: class extends Date {
        static override now() {
          return now;
        }
      },
    });
    const page = device.listRange.bind(device);
    device.listRange = (...args) => {
      now += step === "page" ? 3_000 : 2_000;
      return page(...args);
    };
    const open = device.project.bind(device);
    let opened = false;
    device.project = (...args) => {
      if (!opened && step === "setup") now += 7_000;
      opened = true;
      return open(...args);
    };
    const put = device.put.bind(device);
    device.put = (...args) => {
      now += step === "move" ? 3_000 : 1_000;
      return put(...args);
    };
    const get = device.get.bind(device);
    device.get = (key) => {
      const record = get(key);
      if (
        step === "verify" &&
        (record?.value as { deleted?: boolean })?.deleted
      )
        now += 2_000;
      return record;
    };
    const result = await move({ ...input, limit: 100 }, 16_001);
    expect(now).toBeLessThan(16_001);
    expect(result.complete).toBe(false);
    expect(result.moved.length).toBeGreaterThan(0);
    expect(result.next).toBe(
      "forge memory move --scope alpha --to project --limit 100",
    );
    expect(result.stopped).toBeUndefined();
    expect(project.list("note/")).toHaveLength(result.moved.length);
    expect(device.counts.listedRecords).toBe(100);
  }, 30_000);
}

for (const change of ["re-scope", "restore"]) {
  test(`scope restarts at note zero after an older note joins by ${change}`, async () => {
    const { move, call, device, project } = await setup();
    if (change === "re-scope")
      await call("memory.add", {
        id: "device/note-1",
        expectRevision: 2,
        text: "new 1",
        scope: "beta",
      });
    else
      await call("memory.forget", {
        id: "device/note-1",
        approval: { by: "owner", quote: "Forget the fixture" },
      });
    const open = device.project.bind(device);
    let opens = 0;
    let changed = false;
    device.project = async (...args) => {
      if (++opens === 2) {
        if (change === "re-scope")
          await call("memory.add", {
            id: "device/note-1",
            expectRevision: 3,
            text: "new 1",
            scope: "alpha",
          });
        else
          await call("memory.forget", {
            id: "device/note-1",
            undo: true,
            approval: { by: "owner", quote: "Restore the fixture" },
          });
        changed = true;
      }
      return open(...args);
    };
    const first = await move({ ...input, limit: 1 });
    expect(changed).toBe(true);
    expect(first).toMatchObject({
      moved: [{ id: "device/note-2" }],
      complete: false,
    });
    expect(first.next).toBe(
      "forge memory move --scope alpha --to project --limit 1",
    );
    const second = await move({ ...input, limit: 1 });
    expect(second).toMatchObject({
      moved: [{ id: "device/note-1" }],
      complete: false,
    });
    const third = await move({ ...input, limit: 1 });
    expect(third).toMatchObject({
      moved: [{ id: "device/note-3" }],
      complete: false,
      next: "forge memory move --scope alpha --to project --limit 1",
    });
    const confirmation = await move({ ...input, limit: 1 });
    expect(confirmation).toMatchObject({ moved: [], complete: true });
    expect(confirmation.next).toBeUndefined();
    expect(project.list("note/")).toHaveLength(3);
    for (const moved of [...first.moved, ...second.moved, ...third.moved])
      expect(await call("memory.show", { id: moved.id })).toMatchObject({
        note: { id: moved.to },
      });
  }, 30_000);
}

for (const change of ["re-scope", "restore"]) {
  test(`scope confirms completion after an older note joins by ${change} with two notes`, async () => {
    const { move, call, device, project } = await setup(2);
    if (change === "re-scope")
      await call("memory.add", {
        id: "device/note-1",
        expectRevision: 2,
        text: "new 1",
        scope: "beta",
      });
    else
      await call("memory.forget", {
        id: "device/note-1",
        approval: { by: "owner", quote: "Forget the fixture" },
      });
    const open = device.project.bind(device);
    let opens = 0;
    let changed = false;
    device.project = async (...args) => {
      if (++opens === 2) {
        if (change === "re-scope")
          await call("memory.add", {
            id: "device/note-1",
            expectRevision: 3,
            text: "new 1",
            scope: "alpha",
          });
        else
          await call("memory.forget", {
            id: "device/note-1",
            undo: true,
            approval: { by: "owner", quote: "Restore the fixture" },
          });
        changed = true;
      }
      return open(...args);
    };
    const first = await move({ ...input, limit: 1 });
    expect(changed).toBe(true);
    expect(first).toMatchObject({
      moved: [{ id: "device/note-2" }],
      complete: false,
    });
    expect(first.next).toBe(
      "forge memory move --scope alpha --to project --limit 1",
    );
    const second = await move({ ...input, limit: 1 });
    expect(second).toMatchObject({
      moved: [{ id: "device/note-1" }],
      complete: false,
    });
    expect(second.next).toBe(
      "forge memory move --scope alpha --to project --limit 1",
    );
    const confirmation = await move({ ...input, limit: 1 });
    expect(confirmation).toMatchObject({ moved: [], complete: true });
    expect(confirmation.next).toBeUndefined();
    expect(project.list("note/")).toHaveLength(2);
    for (const moved of [...first.moved, ...second.moved])
      expect(await call("memory.show", { id: moved.id })).toMatchObject({
        note: { id: moved.to },
      });
  }, 30_000);
}

test("scope documents the large-store scan limit and bounds every call", async () => {
  let now = 1_000;
  const { move, call, device, project } = await setup(1, {
    Date: class extends Date {
      static override now() {
        return now;
      }
    },
  });
  for (let n = 0; n < 800; n += 1)
    await call("memory.add", { level: "device", scope: "beta", text: "other" });
  await call("memory.add", { level: "device", scope: "alpha", text: "last" });
  const page = device.listRange.bind(device);
  device.listRange = (...args) => {
    now += 4_000;
    return page(...args);
  };
  const first = await move(input, now + 15_001);
  expect(first).toMatchObject({
    moved: [{ id: "device/note-1" }],
    complete: false,
  });
  expect(first.next).toBeDefined();
  for (let n = 0; n < 2; n += 1) {
    const started = now;
    await expect(move(input, started + 15_001)).rejects.toMatchObject({
      error: { code: "INSUFFICIENT_BUDGET" },
    });
    expect(now - started).toBeLessThan(15_001);
  }
  expect(project.list("note/")).toHaveLength(1);
  expect(device.get("note/000000802")?.value).toMatchObject({ scope: "alpha" });
  // Removing the deadline can reach the last note; bounded calls cannot scan this store fully.
  expect(await move()).toMatchObject({
    moved: [{ id: "device/note-802" }],
    complete: false,
    next: "forge memory move --scope alpha --to project --limit 25",
  });
  const confirmation = await move();
  expect(confirmation).toMatchObject({ moved: [], complete: true });
  expect(confirmation.next).toBeUndefined();
}, 30_000);

test("scope refuses no progress after an atomic page read exceeds the budget", async () => {
  let now = 1_000;
  const { move, device, project } = await setup(1, {
    Date: class extends Date {
      static override now() {
        return now;
      }
    },
  });
  const page = device.listRange.bind(device);
  device.listRange = (...args) => {
    now += 3_000;
    return page(...args);
  };
  await expect(move(input, 3_000)).rejects.toMatchObject({
    error: { code: "INSUFFICIENT_BUDGET" },
  });
  expect(now).toBe(4_000);
  expect(project.list("note/")).toHaveLength(0);
}, 30_000);

test("scope deadline lets a started note finish and verify before returning", async () => {
  let now = 1_000;
  const { move, device, project } = await setup(2, {
    Date: class extends Date {
      static override now() {
        return now;
      }
    },
  });
  const put = device.put.bind(device);
  device.put = (...args) => {
    now += 2_000;
    return put(...args);
  };
  const first = await move(input, 2_500);
  expect(first).toMatchObject({
    moved: [{ id: "device/note-1" }],
    complete: false,
  });
  expect(first.stopped).toBeUndefined();
  expect(project.list("note/")).toHaveLength(1);
  expect(device.get("note/000000001")?.value).toMatchObject({
    deleted: true,
    movedTo: first.moved[0]!.to,
  });
  expect(device.get("note/000000002")?.revision).toBe(2);
}, 30_000);

test("interrupted scope batch resumes the committed copy without duplication", async () => {
  const { move, device, project } = await setup();
  const put = device.put.bind(device);
  let crash = true;
  device.put = (...args) => {
    if (crash) {
      crash = false;
      throw new Error("crash before tombstone");
    }
    return put(...args);
  };
  const failure: unknown = await move().catch((error: unknown) => error);
  expect(String(failure)).toContain("crash before tombstone");
  expect(project.list("note/")).toHaveLength(1);
  expect(await move()).toMatchObject({
    complete: false,
    moved: [
      { id: "device/note-1" },
      { id: "device/note-2" },
      { id: "device/note-3" },
    ],
    next: "forge memory move --scope alpha --to project --limit 25",
  });
  const confirmation = await move();
  expect(confirmation).toMatchObject({ moved: [], complete: true });
  expect(confirmation.next).toBeUndefined();
  expect(project.list("note/")).toHaveLength(3);
}, 30_000);

test("scope batch scans each page once to find the next match", async () => {
  const { move, call, device } = await setup(1);
  for (let n = 0; n < 999; n += 1)
    await call("memory.add", { level: "device", scope: "beta", text: "other" });
  await call("memory.add", { level: "device", scope: "alpha", text: "last" });
  const pages: Parameters<typeof device.listRange>[0][] = [];
  const listRange = device.listRange.bind(device);
  device.listRange = (options) => {
    pages.push(options);
    return listRange(options);
  };
  const before = device.counts.listedRecords;
  expect(await move({ ...input, limit: 1 })).toMatchObject({
    moved: [{ id: "device/note-1" }],
    complete: false,
  });
  expect(device.counts.listedRecords - before).toBe(1001);
  expect(pages.length).toBe(6);
  expect(pages.every((page) => page.limit <= 200 && !page.descending)).toBe(
    true,
  );
}, 30_000);

test("scope continuation flags parse back to the same CLI input", async () => {
  const { move } = await setup(2);
  const value = { ...input, limit: 1 };
  const batch = await move(value);
  expect(batch.next).toBe(
    "forge memory move --scope alpha --to project --limit 1",
  );
  const h = await openHarness(["memory"]);
  try {
    let parsed: unknown;
    const response = await runCli(
      {
        list: () => h.assembly.catalog.list(),
        invoke: (request) => {
          parsed = request.input;
          return h.call(request.op, request.input);
        },
      },
      batch.next!.split(" ").slice(1),
    );
    expect(response.exitCode).toBe(0);
    expect(parsed).toEqual(value);
  } finally {
    await h.close();
  }
}, 30_000);

for (const code of ["REVISION_CONFLICT", "TRANSFER_CONFLICT"]) {
  test(`scope batch stops at ${code} without skipping the conflicting note`, async () => {
    const { move, device, project } = await setup();
    if (code === "REVISION_CONFLICT") {
      const get = device.get.bind(device);
      let raced = false;
      device.get = (key) => {
        if (key === "note/000000002" && !raced) {
          raced = true;
          device.put(key, get(key)!.value, { expectRevision: 2 });
        }
        return get(key);
      };
    } else {
      project.put(
        "transfer/device/note-2",
        { number: 99, revision: 1, sourceRevision: 1 },
        { expectRevision: 0 },
      );
    }
    const stoppedResult = await move();
    expect(stoppedResult).toMatchObject({
      moved: [{ id: "device/note-1" }],
      stopped: { id: "device/note-2", code },
      complete: false,
    });
    expect(stoppedResult.next).toContain("forge memory move --scope");
    expect(project.list("note/")).toHaveLength(1);
    expect(device.get("note/000000003")?.revision).toBe(2);
  }, 30_000);
}

for (const to of ["project/fedcba9876543210/note-2", "device/note-2"]) {
  test(`scope verification rejects a concurrent move to ${to}`, async () => {
    const { move, device, project } = await setup();
    const key = "note/000000002";
    const original = device.get(key)!;
    project.put(key, original.value, { expectRevision: 0 });
    const later = device.get("note/000000003");
    const get = device.get.bind(device);
    let raced = false;
    device.get = (readKey) => {
      if (readKey === key && !raced) {
        raced = true;
        device.put(
          key,
          { ...(original.value as object), deleted: true, movedTo: to },
          { expectRevision: original.revision },
        );
      }
      return get(readKey);
    };
    const projectGet = project.get.bind(project);
    let wrongDestinationReads = 0;
    project.get = (readKey) => {
      if (readKey === key) wrongDestinationReads += 1;
      return projectGet(readKey);
    };
    const stoppedResult = await move();
    expect(stoppedResult).toMatchObject({
      moved: [{ id: "device/note-1" }],
      stopped: { id: "device/note-2", code: "VERIFY_FAILED" },
      complete: false,
    });
    expect(stoppedResult.next).toContain("forge memory move --scope");
    expect(raced).toBe(true);
    expect(wrongDestinationReads).toBe(0);
    expect(device.get("note/000000003")).toEqual(later);
    expect(projectGet("note/000000003")).toBeUndefined();
  }, 30_000);
}

for (const field of ["text", "tags", "links", "scope", "movedTo"]) {
  test(`scope verification stops on a ${field} mismatch`, async () => {
    const { move, device, project } = await setup();
    const store = field === "movedTo" ? device : project;
    const get = store.get.bind(store);
    store.get = (key) => {
      const record = get(key);
      if (
        key !== "note/000000001" ||
        !record ||
        (field === "movedTo" && record.revision < 3)
      )
        return record;
      return {
        ...record,
        value: {
          ...(record.value as object),
          [field]: field === "tags" || field === "links" ? ["wrong"] : "wrong",
        },
      };
    };
    const result = await move();
    expect(result.moved).toEqual([
      { id: "device/note-1", to: `project/${projectId}/note-1` },
    ]);
    expect(result).toMatchObject({
      stopped: { id: "device/note-1", code: "VERIFY_FAILED" },
      complete: false,
    });
    expect(device.get("note/000000002")?.revision).toBe(2);
  }, 30_000);
}

for (const value of [
  { ...input, to: "device" },
  { ...input, scope: "general" },
  { ...input, keep: false },
  { ...input, limit: 0 },
  { ...input, limit: 101 },
  { ...input, id: "device/note-1", expectRevision: 2 },
]) {
  test(`scope refuses invalid input without writes: ${JSON.stringify(value)}`, async () => {
    expect(blockSchema("memory", "move.input.json")(input)).toEqual([]);
    expect(
      blockSchema("memory", "move.input.json")(value).length,
    ).toBeGreaterThan(0);
    const h = await openHarness(["memory"]);
    try {
      console.log(`FORGE_DEVICE_ROOT=${h.deviceRoot}`);
      expect(h.deviceRoot.startsWith(h.work)).toBe(true);
      done(
        await h.call("memory.add", {
          level: "device",
          scope: "alpha",
          text: "untouched",
        }),
      );
      const before = done(await h.call("memory.export", { level: "device" }));
      const refused = await h.call("memory.move", value);
      expect(refused).toMatchObject({
        ok: false,
        error: { code: "INPUT_INVALID" },
      });
      expect(done(await h.call("memory.export", { level: "device" }))).toEqual(
        before,
      );
      expect(
        done(await h.call("memory.export", { level: "project" })),
      ).toMatchObject({ count: 0 });
    } finally {
      await h.close();
    }
  }, 30_000);
}

test("scope move refuses a host with no project before any write", async () => {
  const { entry, device, project } = await setup();
  const before = device.counts.puttedRecords + project.counts.puttedRecords;
  let failure: unknown;
  try {
    await entry["memory.move"]!({
      input,
      services: { state: device, levels: memoryState() },
    });
  } catch (error) {
    failure = error;
  }
  expect(JSON.stringify(failure)).toContain("LEVEL_UNAVAILABLE");
  expect(device.counts.puttedRecords + project.counts.puttedRecords).toBe(
    before,
  );
}, 30_000);
