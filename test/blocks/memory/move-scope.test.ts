import { expect, test } from "bun:test";
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
    expect(docs.description).not.toContain("remaining live device notes");
    const skill = renderSkills(catalog).find(
      (file) => file.noun === "memory",
    )!.text;
    expect(skill).toContain("moved.length");
    expect(skill).toContain("complete");
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
  expect(second).toMatchObject({ complete: true });
  expect(second.moved).toHaveLength(5);
  expect(second.next).toBeUndefined();
  expect(await move()).toMatchObject({
    moved: [],
    complete: true,
  });
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

test("scope scan passes pages of tombstones and other scopes and uses stored scope exactly", async () => {
  const { move, call, device } = await setup(0);
  for (let n = 0; n < 205; n += 1)
    await call("memory.add", { level: "device", scope: "beta", text: "other" });
  await call("memory.add", { level: "device", scope: "alpha", text: "last" });
  expect(await move({ ...input, limit: 1 })).toMatchObject({
    moved: [{ id: "device/note-206" }],
    complete: true,
  });
  expect(await move()).toMatchObject({ moved: [], complete: true });
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
    complete: true,
  });
  expect(project.list("note/")).toHaveLength(4);
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
    const result = await move({ ...input, limit: 1 }, 1_000 + budget);
    expect(result).toMatchObject({
      complete: false,
      next: "forge memory move --scope alpha --to project --limit 1",
    });
    expect(result.stopped).toBeUndefined();
    expect(result.moved).toHaveLength(budget <= 1_000 ? 0 : 1);
    expect(project.list("note/")).toHaveLength(result.moved.length);
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
      complete: true,
    });
    expect(third.next).toBeUndefined();
    expect(project.list("note/")).toHaveLength(3);
    for (const moved of [...first.moved, ...second.moved, ...third.moved])
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
  const results: Batch[] = [];
  for (let n = 0; n < 3; n += 1) {
    const started = now;
    const result = await move(input, started + 15_001);
    expect(now - started).toBeLessThan(15_001);
    expect(result.complete).toBe(false);
    expect(result.next).toBeDefined();
    results.push(result);
  }
  expect(results.map((r) => r.moved.length)).toEqual([1, 0, 0]);
  expect(project.list("note/")).toHaveLength(1);
  expect(device.get("note/000000802")?.value).toMatchObject({ scope: "alpha" });
  // Removing the deadline can reach the last note; bounded calls cannot scan this store fully.
  expect(await move()).toMatchObject({
    moved: [{ id: "device/note-802" }],
    complete: true,
  });
}, 30_000);

test("scope accepts one atomic page read slower than the available budget", async () => {
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
  const result = await move(input, 3_000);
  expect(now).toBe(4_000);
  expect(result).toMatchObject({ moved: [], complete: false });
  expect(result.next).toBeDefined();
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
  expect(await move()).toMatchObject({ complete: true });
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
    expect(await move()).toMatchObject({
      moved: [{ id: "device/note-1" }],
      stopped: { id: "device/note-2", code },
      complete: false,
    });
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
    expect(await move()).toMatchObject({
      moved: [{ id: "device/note-1" }],
      stopped: { id: "device/note-2", code: "VERIFY_FAILED" },
      complete: false,
    });
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
    expect(await move()).toMatchObject({
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
