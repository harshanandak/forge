import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HOOK_STOP_TEXT_MAX } from "../../src/contract/hooks.ts";
import { key } from "./fixtures.ts";
import {
  failure,
  guard,
  hookFixture,
  hung,
  r3,
  session,
  silence,
  stop,
} from "./hook-fixtures.ts";

const timeout = 30_000;
const answer = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});
const jsonl = (...rows: unknown[]) =>
  rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
const outgoing = (text: string) => ({
  path: "/hook/stop",
  method: "POST",
  bearer: "Bearer " + key,
  type: "application/json",
  body: { host: "claude", hostSessionId: "s1", text },
});

test(
  "T5 active Stop is silent and makes no request",
  async () => {
    const f = await hookFixture();
    try {
      const file = join(f.root, "turn.jsonl");
      await writeFile(file, jsonl(answer("Should not be sent")));
      expect(
        await f.run("stop", {
          ...stop,
          stop_hook_active: true,
          transcript_path: file,
        }),
      ).toEqual(silence);
      expect(f.seen).toEqual([]);
    } finally {
      await f.close();
    }
  },
  timeout,
);

test(
  "T6 and X3 launched Stop prefers direct text and falls back to the last assistant text blocks",
  async () => {
    const f = await hookFixture();
    try {
      const missing = join(f.root, "missing.jsonl");
      expect(
        await f.run("stop", {
          ...stop,
          transcript_path: missing,
          last_assistant_message: " Done.\n",
        }),
      ).toEqual(silence);
      expect(f.seen).toEqual([outgoing("Done.")]);
      const path = join(f.root, "turn.jsonl");
      await writeFile(
        path,
        jsonl(
          answer("earlier"),
          {
            type: "assistant",
            message: {
              content: [
                { type: "text", text: " Final" },
                { type: "thinking", text: "ignore" },
                { type: "text", text: " answer.\n" },
              ],
            },
          },
          { type: "user" },
        ),
      );
      for (const provided of [undefined, 123]) {
        expect(
          await f.run("stop", {
            ...stop,
            transcript_path: path,
            last_assistant_message: provided,
          }),
        ).toEqual(silence);
        expect(f.seen.at(-1)).toEqual(outgoing("Final answer."));
      }
      expect(f.seen).toHaveLength(3);
    } finally {
      await f.close();
    }
  },
  timeout,
);

test(
  "T7 empty direct strings suppress the fallback and long answers are bounded",
  async () => {
    const f = await hookFixture();
    try {
      const path = join(f.root, "turn.jsonl");
      await writeFile(path, jsonl(answer("Earlier")));
      for (const last_assistant_message of ["", " \n "])
        expect(
          await f.run("stop", {
            ...stop,
            transcript_path: path,
            last_assistant_message,
          }),
        ).toEqual(silence);
      expect(f.seen).toEqual([]);
      expect(
        await f.run("stop", {
          ...stop,
          last_assistant_message: "x".repeat(HOOK_STOP_TEXT_MAX + 500),
        }),
      ).toEqual(silence);
      expect(f.seen).toEqual([outgoing("x".repeat(HOOK_STOP_TEXT_MAX))]);
    } finally {
      await f.close();
    }
  },
  timeout,
);

for (const [name, respond] of [
  ["timeout", hung],
  ["401", () => failure(401, "UNAUTHENTICATED")],
  ["503", () => failure(503, "BLOCK_DISABLED")],
  ["invalid response", () => new Response("not json")],
] as const) {
  test(
    `T8 Stop quietly attempts POST on ${name}`,
    async () => {
      const f = await hookFixture();
      f.respond = (_path, signal) => respond(signal);
      try {
        const started = performance.now();
        expect(
          await f.run("stop", { ...stop, last_assistant_message: "Finish" }),
        ).toEqual(silence);
        expect(performance.now() - started).toBeLessThan(12_000);
        expect(f.seen).toEqual([outgoing("Finish")]);
      } finally {
        await f.close();
      }
    },
    timeout,
  );
}

test(
  "T8 Stop key/URL failures and closed port are silent",
  async () => {
    const f = await hookFixture();
    try {
      const input = { ...stop, last_assistant_message: "Finish" };
      expect(await f.run("stop", input, { FORGE_HUB_URL: "" })).toEqual(
        silence,
      );
      expect(
        await f.run("stop", input, {
          FORGE_HUB_HOST_KEY_FILE: join(f.root, "missing"),
        }),
      ).toEqual(silence);
      await writeFile(f.keyPath, "bad");
      expect(await f.run("stop", input)).toEqual(silence);
      expect(f.seen).toEqual([]);
      await writeFile(f.keyPath, key);
      await f.stopServer();
      expect(await f.run("stop", input)).toEqual(silence);
    } finally {
      await f.close();
    }
  },
  timeout,
);

test(
  "T9 and Y1 unrecognized transcript or input shapes never get sent",
  async () => {
    const f = await hookFixture();
    try {
      const path = join(f.root, "turn.jsonl");
      const directory = join(f.root, "directory");
      await mkdir(directory);
      for (const input of [
        "[]",
        "null",
        '"x"',
        {},
        { ...stop, session_id: 42 },
        { ...stop, stop_hook_active: "no" },
        { ...stop, transcript_path: path },
        { ...stop, transcript_path: directory },
      ])
        expect(await f.run("stop", input)).toEqual(silence);
      for (const text of [
        "",
        jsonl({ type: "user" }),
        jsonl(answer("earlier")) + "{\n",
        jsonl({
          type: "assistant",
          message: { content: [{ type: "text", text: 7 }] },
        }),
      ]) {
        await writeFile(path, text);
        expect(await f.run("stop", { ...stop, transcript_path: path })).toEqual(
          silence,
        );
      }
      expect(f.seen).toEqual([]);
    } finally {
      await f.close();
    }
  },
  timeout,
);

test(
  "Y4 unexpected stdin failure is closed in PreToolUse and silent in informational hooks",
  async () => {
    const f = await hookFixture();
    const path = join(f.root, "preload.mjs");
    try {
      await writeFile(
        path,
        'Object.defineProperty(process, "stdin", { get() { throw new Error("Synthetic stdin failure"); } });',
      );
      expect(
        await f.run("pre-tool", guard(f.root), {}, ["--import", path]),
      ).toEqual({ status: 2, stdout: "", stderr: r3("INVALID_INPUT") });
      expect(
        await f.run("session-start", session, {}, ["--import", path]),
      ).toEqual(silence);
      expect(
        await f.run("stop", { ...stop, last_assistant_message: "Finish" }, {}, [
          "--import",
          path,
        ]),
      ).toEqual(silence);
      expect(f.seen).toEqual([]);
    } finally {
      await f.close();
    }
  },
  timeout,
);
