import { expect, test } from "bun:test";
import { ForgeFailure } from "../../../src/contract/author.ts";
import type { StateRecord } from "../../../src/generated/types.ts";
import { loadEntry, memoryState } from "./lib.ts";

type Fault = "missing" | "mismatched" | "reordered" | "text" | "tags" | "scope";
const PROJECT_ID = "0123456789abcdef";
const NOTE_KEY = "note/000000001";

function reordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reordered);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, child]) => [key, reordered(child)]),
  );
}

/** A store can acknowledge the requested note while its next read sees different state. */
function stores(level: "device" | "project") {
  const device = memoryState();
  const project = memoryState();
  const backing = level === "device" ? device : project;
  let fault: Fault | undefined;
  let missing = false;
  let injected = 0;
  function persisted(value: unknown): unknown {
    if (fault === "reordered") return reordered(value);
    if (fault === "text" || fault === "tags" || fault === "scope") {
      // Mutate the supplied object as well as returning it: a reference is not a snapshot.
      return Object.assign(value as object, {
        [fault]:
          fault === "text"
            ? "altered text"
            : fault === "tags"
              ? ["altered"]
              : "altered",
      });
    }
    return { ...(value as object), text: "different persisted text" };
  }
  function acknowledged(
    key: string,
    value: unknown,
    revision: number,
  ): StateRecord {
    return {
      namespace: "forge/memory",
      key,
      value,
      revision,
      updatedAt: "2026-10-18T00:00:00Z",
      updatedBy: { kind: "agent", id: "a" },
    };
  }
  const target = {
    ...backing,
    get(key: string) {
      return missing && key === NOTE_KEY ? undefined : backing.get(key);
    },
    put(...args: Parameters<typeof backing.put>) {
      const [key, value, options] = args;
      if (fault === undefined || !key.startsWith("note/"))
        return backing.put(...args);
      injected += 1;
      if (fault === "missing") missing = true;
      else {
        const record = backing.put(key, persisted(value), options);
        if (fault === "text" || fault === "tags" || fault === "scope")
          return record;
      }
      return acknowledged(key, value, options.expectRevision + 1);
    },
    putMany(...args: Parameters<typeof backing.putMany>) {
      const [entries, options] = args;
      if (
        fault === undefined ||
        !entries.some((entry) => entry.key.startsWith("note/"))
      )
        return backing.putMany(...args);
      injected += 1;
      const persistedEntries = entries.flatMap((entry) => {
        if (!entry.key.startsWith("note/")) return [entry];
        if (fault === "missing") {
          missing = true;
          return [];
        }
        return [{ ...entry, value: persisted(entry.value) }];
      });
      const records = backing.putMany(persistedEntries, options);
      if (fault === "text" || fault === "tags" || fault === "scope")
        return records;
      return entries.map((entry) =>
        acknowledged(entry.key, entry.value, entry.expectRevision + 1),
      );
    },
  };
  const state = level === "device" ? target : device;
  const levels = {
    ...state,
    caller: "agent" as const,
    inProject: true,
    project: () =>
      Promise.resolve({
        identity: { id: PROJECT_ID, name: "readback" },
        state: level === "project" ? target : project,
      }),
  };
  return {
    services: { state, levels },
    target,
    setFault(value: Fault) {
      fault = value;
    },
    injected: () => injected,
  };
}

for (const level of ["device", "project"] as const) {
  for (const operation of ["add", "edit"] as const) {
    for (const fault of ["missing", "mismatched"] as const) {
      test(`memory.add refuses a ${fault} persisted ${level} note after ${operation}`, async () => {
        const entry = loadEntry("memory");
        const h = stores(level);
        const id =
          level === "device" ? "device/note-1" : `project/${PROJECT_ID}/note-1`;
        if (operation === "edit") {
          expect(
            await entry["memory.add"]!({
              input: { level, text: "original text" },
              services: h.services,
            }),
          ).toMatchObject({ status: "added", id });
        }
        h.setFault(fault);
        let refused: unknown;
        try {
          await entry["memory.add"]!({
            input: {
              level,
              text: "requested text",
              ...(operation === "edit" ? { id, expectRevision: 1 } : {}),
            },
            services: h.services,
          });
        } catch (error) {
          refused = error;
        }
        expect(h.injected()).toBe(1);
        expect(refused).toBeInstanceOf(ForgeFailure);
        const failure = refused as ForgeFailure;
        expect(failure.error.code).toBe("INTERNAL");
        expect(failure.error.message).toContain("memory.add");
        expect(failure.error.message).toMatch(/reconcil/i);
        expect(failure.error.message).toMatch(/memory[ .]show/);
        if (fault === "missing") expect(h.target.get(NOTE_KEY)).toBeUndefined();
        else
          expect(h.target.get(NOTE_KEY)?.value).toMatchObject({
            text: "different persisted text",
          });
      }, 30_000);
    }
  }

  for (const order of ["normal", "reordered"] as const) {
    test(`memory.add returns added and updated for ${order} persisted ${level} notes`, async () => {
      const entry = loadEntry("memory");
      const h = stores(level);
      if (order === "reordered") h.setFault("reordered");
      const added = (await entry["memory.add"]!({
        input: {
          level,
          text: "original text",
          tags: ["one", "two"],
          links: [],
        },
        services: h.services,
      })) as { id: string };
      expect(added).toMatchObject({
        status: "added",
        note: {
          revision: 1,
          text: { text: "original text" },
          tags: ["one", "two"],
        },
      });
      expect(
        await entry["memory.add"]!({
          input: { id: added.id, expectRevision: 1, text: "edited text" },
          services: h.services,
        }),
      ).toMatchObject({
        status: "updated",
        id: added.id,
        note: {
          revision: 2,
          text: { text: "edited text" },
          tags: ["one", "two"],
        },
      });
      expect(h.target.get(NOTE_KEY)).toMatchObject({
        revision: 2,
        value: {
          text: "edited text",
          previous: [{ revision: 1, text: "original text" }],
        },
      });
      expect(h.injected()).toBe(order === "reordered" ? 2 : 0);
    }, 30_000);
  }
}

for (const level of ["device", "project"] as const) {
  for (const operation of ["add", "edit"] as const) {
    for (const field of ["text", "tags", "scope"] as const) {
      test(`memory.add refuses matching altered ${field} storage and acknowledgment for ${level} ${operation}`, async () => {
        const entry = loadEntry("memory");
        const h = stores(level);
        const id =
          level === "device" ? "device/note-1" : `project/${PROJECT_ID}/note-1`;
        if (operation === "edit")
          await entry["memory.add"]!({
            input: { level, text: "original", tags: ["old"], scope: "old" },
            services: h.services,
          });
        h.setFault(field);
        let refused: unknown;
        try {
          await entry["memory.add"]!({
            input: {
              level,
              text: "requested",
              tags: ["requested"],
              scope: "requested",
              ...(operation === "edit" ? { id, expectRevision: 1 } : {}),
            },
            services: h.services,
          });
        } catch (error) {
          refused = error;
        }
        expect(h.injected()).toBe(1);
        expect(refused).toBeInstanceOf(ForgeFailure);
        const failure = refused as ForgeFailure;
        expect(failure.error.code).toBe("INTERNAL");
        expect(failure.error.message).toContain("memory.add");
        expect(failure.error.message).toMatch(/reconcil/i);
        expect(failure.error.message).toMatch(/memory[ .]show/);
        expect(h.target.get(NOTE_KEY)?.value).toMatchObject({
          [field]:
            field === "text"
              ? "altered text"
              : field === "tags"
                ? ["altered"]
                : "altered",
        });
      }, 30_000);
    }
  }

  test(`memory.add ${level} edits preserve omitted fields and normalize null scope`, async () => {
    const entry = loadEntry("memory");
    const h = stores(level);
    const added = (await entry["memory.add"]!({
      input: {
        level,
        text: "original",
        tags: ["kept"],
        links: ["device/note-7"],
        scope: "kept",
      },
      services: h.services,
    })) as { id: string };
    expect(
      await entry["memory.add"]!({
        input: { id: added.id, expectRevision: 1, text: "edited" },
        services: h.services,
      }),
    ).toMatchObject({
      status: "updated",
      note: { tags: ["kept"], links: ["device/note-7"], scope: "kept" },
    });
    expect(
      await entry["memory.add"]!({
        input: {
          id: added.id,
          expectRevision: 2,
          text: "cleared",
          scope: null,
        },
        services: h.services,
      }),
    ).toMatchObject({
      status: "updated",
      note: { tags: ["kept"], links: ["device/note-7"] },
    });
    const value = h.target.get(NOTE_KEY)?.value as Record<string, unknown>;
    expect(Object.hasOwn(value, "scope")).toBe(false);
    expect(value).toMatchObject({
      text: "cleared",
      tags: ["kept"],
      links: ["device/note-7"],
    });
  }, 30_000);
}
