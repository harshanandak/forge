import { expect, test } from "bun:test";
import { loadEntry, memoryState, ownerApproval } from "./lib.ts";

const note = (number: number, text: string) => ({
  id: `device/note-${number}`,
  tags: [],
  links: [],
  text: { text },
});
const key = (number: number) => `note/${String(number).padStart(9, "0")}`;

function setup() {
  const entry = loadEntry("memory");
  const state = memoryState();
  const services = { state, levels: state };
  const restore = (...notes: ReturnType<typeof note>[]) =>
    entry["memory.restore"]!({
      input: {
        format: "forge.memory.export/3",
        level: "device",
        notes,
        approval: ownerApproval,
      },
      services,
    }) as Promise<{ added: number; skipped: number; conflicts: string[] }>;
  /** Another writer lands between this restore's scan and its commit. */
  const raceOnce = (change: () => void) => {
    const putMany = state.putMany.bind(state);
    let armed = true;
    state.putMany = (entries, options) => {
      if (armed) {
        armed = false;
        change();
      }
      return putMany(entries, options);
    };
  };
  return { state, restore, raceOnce };
}
async function refusedWith(run: () => Promise<unknown>, code: string) {
  try {
    await run();
  } catch (error) {
    expect(error).toMatchObject({ error: { code } });
    return;
  }
  throw new Error(`expected ${code}`);
}

test("a restore whose third note loses its key to another writer writes nothing", async () => {
  const { state, restore, raceOnce } = setup();
  raceOnce(() => {
    state.put(
      key(3),
      { text: "taken", tags: [], links: [], previous: [] },
      {
        expectRevision: 0,
      },
    );
  });
  await refusedWith(
    () => restore(note(1, "one"), note(2, "two"), note(3, "three")),
    "RESTORE_CONFLICT",
  );
  // Only the other writer's note is there: no restored note and no counter write landed.
  expect(state.list().map((record) => record.key)).toEqual([key(3)]);
  expect(state.get(key(3))?.revision).toBe(1);
  expect(state.get("meta/note-counter")).toBeUndefined();
}, 30_000);

test("a note changed after the scan makes the restore refuse and write nothing", async () => {
  const { state, restore, raceOnce } = setup();
  expect(await restore(note(1, "same"))).toMatchObject({ added: 1 });
  raceOnce(() => {
    const current = state.get(key(1))!;
    state.put(
      key(1),
      { ...(current.value as object), tags: ["edited"] },
      {
        expectRevision: current.revision,
      },
    );
  });
  await refusedWith(
    () => restore(note(1, "same"), note(2, "new")),
    "RESTORE_CONFLICT",
  );
  expect(state.get(key(2))).toBeUndefined();
  expect(state.get(key(1))?.revision).toBe(2);
  expect(state.get("meta/note-counter")?.value).toEqual({ last: 1 });
}, 30_000);
