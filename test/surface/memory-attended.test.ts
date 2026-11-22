import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { AGENT_MARKERS } from "../../src/assembly/identity.ts";
import { LocalState } from "../../src/assembly/state.ts";
import { record } from "../../src/surface/dispatch.ts";
import {
  decisionItem,
  done,
  openHarness,
  type Harness,
} from "../blocks/memory/lib.ts";

const MARKERS = [...AGENT_MARKERS, "FORGE_HARNESS"];
const saved = MARKERS.map((key) => [key, process.env[key]] as const);
let h: Harness | undefined;
beforeEach(() => {
  for (const key of MARKERS) delete process.env[key];
});
afterEach(async () => {
  live.on = false;
  await h?.close();
  h = undefined;
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** The terminal is attended only while `live` is set, so harness setup still takes the relayed path. */
const live = { on: false };
const terminal = (stdin: boolean, answer: boolean) => ({
  tty: () => ({ stdin: live.on && stdin, stderr: true }),
  confirm: () => Promise.resolve(answer),
});

async function forget(stdin: boolean, answer: boolean) {
  let ask: string | undefined;
  const tty = terminal(stdin, answer);
  const confirm = (_op: string, prompt: string) => {
    ask = prompt;
    return tty.confirm();
  };
  h = await openHarness(["memory"], {}, { terminal: { ...tty, confirm } });
  const note = done(
    await h.call("memory.add", { level: "device", text: "temporary" }),
  ) as { id: string };
  live.on = true;
  const result = await h.call("memory.forget", { id: note.id });
  live.on = false;
  const shown = done(await h.call("memory.show", { id: note.id }));
  return { result, shown, ask, id: note.id };
}

test("a person at a terminal who types the phrase can forget a note without a relayed reply", async () => {
  const { result, shown, ask, id } = await forget(true, true);
  expect(result).toMatchObject({ ok: true, result: { status: "forgotten" } });
  expect(shown).toMatchObject({
    status: "forgotten",
    approval: { by: "owner" },
  });
  expect(ask).toBe(
    `Forget note "${id}". Its text is hidden and kept only as a private backup.`,
  );
  const trust = new LocalState(join(h!.deviceRoot, "trust.sqlite"));
  try {
    const rows = (await trust.open(false))?.list("forge/core-approvals");
    const saved = rows?.find(
      (row) => record(row.value)?.op === "memory.forget",
    );
    expect(saved?.value).toMatchObject({
      method: "attended",
      ask: `Forget note ${id}. Its text is hidden and kept only as a private backup.`,
    });
  } finally {
    await trust.close();
  }
}, 30_000);

test("piped input, a wrong phrase or an agent session keep the existing refusal", async () => {
  for (const [stdin, answer] of [
    [false, true],
    [true, false],
  ] as const) {
    const { result, shown } = await forget(stdin, answer);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "HUMAN_REQUIRED" },
    });
    expect(shown).toMatchObject({ status: "found" });
    await h?.close();
    h = undefined;
  }
  process.env.CLAUDECODE = "1";
  const { result, shown } = await forget(true, true);
  expect(result).toMatchObject({
    ok: false,
    error: { code: "HUMAN_REQUIRED" },
  });
  expect(shown).toMatchObject({ status: "found" });
}, 30_000);

test("attended accept and reject receive the original note text as one quoted fragment", async () => {
  const asks: string[] = [];
  const tty = terminal(true, true);
  const confirm = (_op: string, ask: string) => {
    asks.push(ask);
    return Promise.resolve(true);
  };
  h = await openHarness(["memory"], {}, { terminal: { ...tty, confirm } });
  const text = 'Keep\r\nthe full text. "\\u0009\t\u{e0001}';
  for (const op of ["memory.accept", "memory.reject"]) {
    const added = done(
      await h.call("memory.add", {
        level: "device",
        text: `${op}: ${text}`,
        tags: ["rule"],
      }),
    ) as { id: string } & Parameters<typeof decisionItem>[1];
    const id = added.id;
    live.on = true;
    const reply = await h.call(op, { items: [decisionItem(id, added)] });
    live.on = false;
    const status = op === "memory.accept" ? "accepted" : "rejected";
    expect(reply).toMatchObject({
      ok: true,
      result: { results: [{ id, status }] },
    });
  }
  expect(asks.map((ask) => ask.split("\n").at(-1))).toEqual([
    '    "memory.accept: Keep\\u000d\\u000athe full text. \\"\\\\u0009\\u0009\\udb40\\udc01"',
    '    "memory.reject: Keep\\u000d\\u000athe full text. \\"\\\\u0009\\u0009\\udb40\\udc01"',
  ]);
}, 30_000);
