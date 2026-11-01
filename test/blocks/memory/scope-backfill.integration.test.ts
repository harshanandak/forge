import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
import type { ExtendedStateClient } from "../../../src/ports/state.ts";
import { loadEntry, memoryState } from "./lib.ts";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as ObjectValue;
}
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function bytes(value: unknown): string {
  const ordered = (child: unknown): unknown =>
    Array.isArray(child)
      ? child.map(ordered)
      : child && typeof child === "object"
        ? Object.fromEntries(
            Object.entries(child)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, nested]) => [key, ordered(nested)]),
          )
        : child;
  return JSON.stringify(ordered(value));
}
const namespace = "forge/memory";
const actor = { kind: "agent", id: "backfill-test" } as const;
const keyOf = (number: number) => `note/${String(number).padStart(9, "0")}`;
const scopeOf = (number: number) =>
  ["forge", "curapod", "general"][(number - 1) % 3]!;
const scopedId = (number: number) =>
  `${scopeOf(number)}/note-${Math.ceil(number / 3)}`;
const remap = (value: string) =>
  value.replace(/device\/note-(\d+)/g, (_match, number: string) =>
    scopedId(Number(number)),
  );

/** Build the exact intended public result; every other field is retained for byte comparison. */
function numbered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(numbered);
  if (!value || typeof value !== "object") return value;
  const original = object(value);
  const result = Object.fromEntries(
    Object.entries(original).map(([key, child]) => [
      key,
      typeof child === "string" &&
      (key === "id" ||
        key === "source" ||
        (key === "text" && original.source === "memory:rules"))
        ? remap(child)
        : numbered(child),
    ]),
  );
  if (typeof original.id === "string" && typeof original.revision === "number")
    result.revision = original.revision + 1;
  return result;
}

test("integration: chunked scope backfill preserves every visible field and all prior SQLite history", async () => {
  const opened = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!opened.ok) throw new Error(opened.unavailable.reason);
  let now = Date.UTC(2026, 9, 1);
  const owner = new StateOwner(opened.handle.value, { now: () => now });
  owner.initialize();
  const client = owner.client(namespace, actor);
  let batches = 0;
  // VM results cross a serialized host boundary in the runtime; preserve that boundary here.
  const state: ExtendedStateClient = {
    ...client,
    put: (key, value, options) => client.put(key, copy(value), options),
    putMany: (entries, options) => {
      batches++;
      return client.putMany(copy(entries), options);
    },
  };
  const levels = {
    ...memoryState(undefined, { defaultScope: "forge" }),
    ...state,
  };
  const entry = loadEntry("memory");
  const call = async (
    op: string,
    input: ObjectValue,
    config: ObjectValue = {},
  ) => copy(await entry[op]!({ input, config, services: { state, levels } }));
  try {
    for (let number = 1; number <= 63; number++) {
      const key = keyOf(number);
      const scope = scopeOf(number);
      const first = `backfill topic ${number} original`;
      let value: ObjectValue = {
        text: first,
        ...(scope === "general" ? {} : { scope }),
        tags: number % 2 ? ["rule", "owner"] : ["fact"],
        links: number === 1 ? [] : ["device/note-1"],
        previous: [],
      };
      now += 86_400_000;
      const created = new Date(now).toISOString();
      if (number % 3 === 0)
        value = {
          ...value,
          createdAt: created,
          changedAt: created,
          textAt: created,
        };
      owner.put(namespace, key, value, actor, { expectRevision: 0 });
      if (number % 4 !== 0) {
        now += 86_400_000;
        const changed = new Date(now).toISOString();
        value = {
          ...value,
          text: `backfill topic ${number} revised`,
          previous: [
            {
              revision: 1,
              text: first,
              ...(number % 2 ? { at: created } : {}),
            },
          ],
          ...(number % 3 === 0 ? { changedAt: changed, textAt: changed } : {}),
        };
        owner.put(namespace, key, value, actor, { expectRevision: 1 });
        if (number % 2 === 0) {
          now += 86_400_000;
          value = { ...value, textRevision: 2, proposedForget: true };
          owner.put(namespace, key, value, actor, { expectRevision: 2 });
        }
      }
    }
    owner.put(namespace, "meta/note-counter", { last: 63 }, actor, {
      expectRevision: 0,
    });
    const records = copy(client.list("note/"));
    const histories = records.map(({ key }) => copy(client.events(key)));
    const historyPages = records.map(({ key }) =>
      copy(client.history({ key, limit: 1000 })),
    );
    const snapshot = async () => {
      const shows: unknown[] = [];
      const versions: unknown[] = [];
      for (let number = 1; number <= 63; number++) {
        const id = `device/note-${number}`;
        const shown = object(await call("memory.show", { id }));
        expect(shown.status).toBe("found");
        shows.push(shown);
        for (const version of object(shown.note).versions as ObjectValue[])
          versions.push(
            await call("memory.show", { id, revision: version.revision }),
          );
      }
      const searches: unknown[] = [];
      const found: string[] = [];
      let cursor: string | undefined;
      do {
        const page = object(
          await call("memory.search", {
            query: "backfill topic",
            level: "device",
            limit: 10,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        );
        searches.push(page);
        found.push(
          ...(page.hits as ObjectValue[]).map((hit) => String(hit.id)),
        );
        cursor = page.next as string | undefined;
        expect(searches.length).toBeLessThan(20);
      } while (cursor !== undefined);
      expect(new Set(found).size).toBe(63);
      expect(found).toHaveLength(63);
      const exports: ObjectValue[] = [];
      let after = 0;
      do {
        const page = object(
          await call("memory.export", { level: "device", after }),
        );
        exports.push(page);
        if (!page.truncated) break;
        expect(page.next as number).toBeGreaterThan(after);
        after = page.next as number;
        expect(exports.length).toBeLessThan(10);
      } while (exports.at(-1)?.truncated === true);
      expect(exports.flatMap((page) => page.notes as unknown[])).toHaveLength(
        63,
      );
      const rules = [];
      for (const scope of ["general", "forge", "curapod"]) {
        levels.defaultScope = scope;
        rules.push(await call("memory.rules", { notes: true }, { scope }));
      }
      levels.defaultScope = "forge";
      return { shows, versions, searches, exports, rules };
    };
    const before = await snapshot();
    expect(entry["memory.renumber"]).toBeFunction();
    now += 86_400_000;
    const migrationAt = new Date(now).toISOString();
    let total = 0;
    let chunks = 0;
    let complete = false;
    do {
      const priorBatches = batches;
      const result = object(await call("memory.renumber", {}));
      expect(batches - priorBatches).toBe(1);
      expect(result.indexed as number).toBeGreaterThan(0);
      expect(result.indexed as number).toBeLessThanOrEqual(25);
      total += result.indexed as number;
      chunks++;
      complete = result.complete as boolean;
      expect(chunks).toBeLessThan(5);
    } while (!complete);
    expect(total).toBe(63);
    expect(chunks).toBe(3);
    for (const [index, old] of records.entries()) {
      const current = client.get(old.key)!;
      const identity = {
        scope: scopeOf(index + 1),
        number: Math.ceil((index + 1) / 3),
        backfill: old.revision,
      };
      expect(current.revision).toBe(old.revision + 1);
      expect(current.updatedAt).toBe(migrationAt);
      expect(current.updatedBy).toEqual(actor);
      expect(current.value).toEqual({
        ...object(old.value),
        scopeNumber: identity,
      });
      const events = client.events(old.key);
      expect(JSON.stringify(events.slice(0, -1))).toBe(
        JSON.stringify(histories[index]),
      );
      expect(events).toHaveLength(histories[index]!.length + 1);
      expect(events.at(-1)).toMatchObject({
        revision: current.revision,
        at: migrationAt,
        data: current.value,
      });
      expect(identity.backfill + 1).toBe(events.at(-1)!.revision);
      expect(
        JSON.stringify(client.history({ key: old.key, limit: 1000 }).slice(1)),
      ).toBe(JSON.stringify(historyPages[index]));
      expect(await call("memory.show", { id: scopedId(index + 1) })).toEqual(
        await call("memory.show", { id: `note-${index + 1}` }),
      );
    }
    const expected = object(numbered(before));
    for (const page of expected.exports as ObjectValue[])
      for (const note of page.notes as ObjectValue[]) {
        const old = records.find(
          (record) => scopedId(Number(record.key.slice(5))) === note.id,
        )!;
        note.scopeNumber = {
          scope: scopeOf(Number(old.key.slice(5))),
          number: Math.ceil(Number(old.key.slice(5)) / 3),
          backfill: old.revision,
        };
      }
    for (const rule of expected.rules as ObjectValue[]) {
      const text = String(object(rule.text).text);
      const receipt = object(rule.receipt);
      receipt.packet = {
        utf8Bytes: Buffer.byteLength(text),
        characters: [...text].length,
        characterUnit: "Unicode code points",
      };
      object(receipt.cap).used = text
        .split("\n")
        .filter((line) => line.startsWith("- ["))
        .join("\n").length;
    }
    expect(bytes(await snapshot())).toBe(bytes(expected));
    const after = JSON.stringify(client.list());
    const events = JSON.stringify(client.events());
    const priorBatches = batches;
    expect(await call("memory.renumber", {})).toMatchObject({
      complete: true,
      indexed: 0,
    });
    expect(batches).toBe(priorBatches);
    expect(JSON.stringify(client.list())).toBe(after);
    expect(JSON.stringify(client.events())).toBe(events);
  } finally {
    await opened.handle.close();
  }
}, 30_000);
