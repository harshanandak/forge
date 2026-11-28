import { expect } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { HOOK_STOP_TEXT_MAX } from "../../src/contract/hooks.ts";
import { key } from "./fixtures.ts";
import {
  deny,
  failure,
  guard,
  hookTest,
  hung,
  r3,
  session,
  silence,
  stop,
} from "./hook-fixtures.ts";

const timeout = 30_000;
const check = hookTest(timeout);
const block = (text: string) => ({ type: "text", text });
const assistant = (...content: unknown[]) => ({
  type: "assistant",
  message: { content },
});
const lines = (...rows: unknown[]) =>
  rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
const outgoing = (text: string) => ({
  path: "/hook/stop",
  method: "POST",
  bearer: "Bearer " + key,
  type: "application/json",
  body: { host: "claude", hostSessionId: "s1", text },
});
const final = (last_assistant_message: string) => ({
  ...stop,
  last_assistant_message,
});

check("T5 active Stop stays silent and does not deliver", async (f) => {
  const path = f.path("turn.jsonl");
  await writeFile(path, lines(assistant(block("Should not be sent"))));
  expect(
    await f.run("stop", {
      ...stop,
      stop_hook_active: true,
      transcript_path: path,
    }),
  ).toEqual(silence);
  expect(f.seen).toEqual([]);
});

check(
  "T6 and X3 direct text wins, else last assistant text blocks",
  async (f) => {
    const path = f.path("turn.jsonl");
    const direct = {
      ...final(" Done.\n"),
      transcript_path: f.path("missing.jsonl"),
    };
    expect(await f.run("stop", direct)).toEqual(silence);
    expect(f.seen).toEqual([outgoing("Done.")]);
    await writeFile(
      path,
      lines(
        assistant(block("earlier")),
        assistant(
          block(" Final"),
          { type: "thinking", text: "ignore" },
          block("\u2028answer\u2029done.\n"),
        ),
        { type: "user" },
      ).replace("\n", "\r\n"),
    );
    for (const last_assistant_message of [undefined, 123]) {
      expect(
        await f.run("stop", {
          ...stop,
          transcript_path: path,
          last_assistant_message,
        }),
      ).toEqual(silence);
      expect(f.seen.at(-1)).toEqual(outgoing("Final\u2028answer\u2029done."));
    }
    expect(f.seen).toHaveLength(3);
  },
);

check(
  "T7 empty direct text suppresses fallback and long text is bounded",
  async (f) => {
    const path = f.path("turn.jsonl");
    await writeFile(path, lines(assistant(block("Earlier"))));
    for (const text of ["", " \n "])
      expect(
        await f.run("stop", { ...final(text), transcript_path: path }),
      ).toEqual(silence);
    expect(f.seen).toEqual([]);
    expect(
      await f.run("stop", final("x".repeat(HOOK_STOP_TEXT_MAX + 500))),
    ).toEqual(silence);
    expect(f.seen).toEqual([outgoing("x".repeat(HOOK_STOP_TEXT_MAX))]);
  },
);

for (const [name, respond] of [
  ["timeout", hung],
  ["401", () => failure(401, "UNAUTHENTICATED")],
  ["503", () => failure(503, "BLOCK_DISABLED")],
  ["invalid reply", () => new Response("not json")],
] as const) {
  check("T8 Stop attempts POST and stays silent on " + name, async (f) => {
    f.respond = (_path, signal) => respond(signal);
    const started = performance.now();
    expect(await f.run("stop", final("Finish"))).toEqual(silence);
    expect(performance.now() - started).toBeLessThan(12_000);
    expect(f.seen).toEqual([outgoing("Finish")]);
  });
}

check("T8 missing URL, bad key and closed port never trap Stop", async (f) => {
  const input = final("Finish");
  for (const env of [
    { FORGE_HUB_URL: "" },
    { FORGE_HUB_HOST_KEY_FILE: f.path("missing") },
  ])
    expect(await f.run("stop", input, env)).toEqual(silence);
  await writeFile(f.keyPath, "bad");
  expect(await f.run("stop", input)).toEqual(silence);
  expect(f.seen).toEqual([]);
  await writeFile(f.keyPath, key);
  await f.stopServer();
  expect(await f.run("stop", input)).toEqual(silence);
});

check("T9 and Y1 malformed input and transcript never get sent", async (f) => {
  const path = f.path("turn.jsonl");
  const directory = f.path("directory");
  await mkdir(directory);
  const invalid = [
    "[]",
    "null",
    '"x"',
    {},
    { ...stop, session_id: 42 },
    { ...stop, stop_hook_active: "no" },
    ...[path, directory].map((transcript_path) => ({
      ...stop,
      transcript_path,
    })),
  ];
  for (const input of invalid)
    expect(await f.run("stop", input)).toEqual(silence);
  const transcripts = [
    "",
    lines({ type: "user" }),
    lines(assistant(block("earlier"))) + "{\n",
    lines(assistant({ type: "text", text: 7 })),
  ];
  for (const text of transcripts) {
    await writeFile(path, text);
    expect(await f.run("stop", { ...stop, transcript_path: path })).toEqual(
      silence,
    );
  }
  expect(f.seen).toEqual([]);
});

check(
  "Y4 uncaught input read is closed in PreToolUse and silent elsewhere",
  async (f) => {
    const preload = pathToFileURL(f.path("preload.mjs"));
    await writeFile(
      preload,
      'Object.defineProperty(process, "stdin", { get() { throw new Error("Synthetic stdin failure"); } });',
    );
    for (const [hook, input, expected] of [
      ["pre-tool", guard(f.root), deny(r3("INVALID_INPUT"))],
      ["session-start", session, silence],
      ["stop", final("Finish"), silence],
    ] as const)
      expect(await f.run(hook, input, {}, ["--import", preload.href])).toEqual(
        expected,
      );
    expect(f.seen).toEqual([]);
  },
);
