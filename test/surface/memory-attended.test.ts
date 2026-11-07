import { afterEach, beforeEach, expect, test } from "bun:test";
import { AGENT_MARKERS } from "../../src/assembly/identity.ts";
import { done, openHarness, type Harness } from "../blocks/memory/lib.ts";

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
  h = await openHarness(["memory"], {}, { terminal: terminal(stdin, answer) });
  const note = done(
    await h.call("memory.add", { level: "device", text: "temporary" }),
  ) as { id: string };
  live.on = true;
  const result = await h.call("memory.forget", { id: note.id });
  live.on = false;
  const shown = done(await h.call("memory.show", { id: note.id }));
  return { result, shown };
}

test("a person at a terminal who types the phrase can forget a note without a relayed reply", async () => {
  const { result, shown } = await forget(true, true);
  expect(result).toMatchObject({ ok: true, result: { status: "forgotten" } });
  expect(shown).toMatchObject({
    status: "forgotten",
    approval: { by: "owner" },
  });
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
