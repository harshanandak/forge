import { expect } from "bun:test";
import { key, registered } from "./fixtures.ts";
import {
  answer,
  failure,
  hookTest,
  hung,
  session,
  silence,
} from "./hook-fixtures.ts";

const timeout = 30_000;
const check = hookTest(timeout);
const output = (stdout: string) => ({ ...silence, stdout: stdout + "\n" });
const unavailable = (code: string) => output("Forge hub unavailable: " + code);
const line = (mode: string) =>
  output(
    `Forge hub session ses_a (${mode}). 3 unread, 2 not from you. Call forge-hub hello with sessionId ses_a, then inbox.`,
  );
const base = { host: "claude", hostSessionId: "s1" };

check(
  "S1-S2 and X2 launch registers once per source and prints only validated fields",
  async (f) => {
    for (const source of ["startup", "resume", "clear", "compact"]) {
      const mode = source === "resume" ? "reply_only" : "normal";
      f.respond = () =>
        answer({ ...registered, mode, items: [{ text: "untrusted text" }] });
      expect(await f.run("session-start", { ...session, source })).toEqual(
        line(mode),
      );
      expect(f.seen.at(-1)).toEqual({
        path: "/hook/session",
        method: "POST",
        bearer: "Bearer " + key,
        type: "application/json",
        body: { ...base, source },
      });
    }
    expect(f.seen).toHaveLength(4);
  },
);

check("S3 only valid T3CODE_THREAD_ID becomes threadId", async (f) => {
  for (const value of ["thr_1", undefined, "", "a".repeat(257)]) {
    const env = {
      T3_THREAD_ID: "thr_legacy",
      ...(value === undefined ? {} : { T3CODE_THREAD_ID: value }),
    };
    expect(await f.run("session-start", session, env)).toEqual(line("normal"));
    expect(f.seen.at(-1)?.body).toEqual({
      ...base,
      source: "startup",
      ...(value === "thr_1" ? { threadId: value } : {}),
    });
  }
  expect(f.seen).toHaveLength(4);
});

check("S4 lookup failures print one safe fixed code", async (f) => {
  for (const [code, respond] of [
    ["HUB_TIMEOUT", hung],
    ["UNAUTHENTICATED", () => failure(401, "UNAUTHENTICATED")],
    ["BLOCK_DISABLED", () => failure(503, "BLOCK_DISABLED")],
    ["INPUT_INVALID", () => failure(400, "INPUT_INVALID")],
    ["INVALID_RESPONSE", () => Response.json({ ok: true })],
  ] as const) {
    f.respond = (_path, signal) => respond(signal);
    const started = performance.now();
    expect(await f.run("session-start", session)).toEqual(unavailable(code));
    expect(performance.now() - started).toBeLessThan(3500);
  }
  expect(
    await f.run("session-start", session, {
      FORGE_HUB_HOST_KEY_FILE: f.path("missing"),
    }),
  ).toEqual(unavailable("HOST_KEY_UNAVAILABLE"));
  expect(
    await f.run("session-start", session, {
      FORGE_HUB_URL: "http://example.invalid",
    }),
  ).toEqual(unavailable("HUB_URL_INVALID"));
  expect(f.seen).toHaveLength(5);
  await f.stopServer();
  expect(await f.run("session-start", session)).toEqual(
    unavailable("HUB_UNREACHABLE"),
  );
});

check("S5 and Y1 reject malformed input and unsafe reply fields", async (f) => {
  for (const value of [
    "null",
    "[]",
    '"x"',
    {},
    { session_id: "s1" },
    { ...session, session_id: 1 },
  ])
    expect(await f.run("session-start", value)).toEqual(
      unavailable("INVALID_INPUT"),
    );
  expect(f.seen).toEqual([]);
  for (const patch of [
    { sessionId: "not an id" },
    { mode: "unknown" },
    { unread: -1 },
    { unreadFromOthers: "2" },
    null,
  ]) {
    f.respond = () => answer(patch && { ...registered, ...patch });
    expect(await f.run("session-start", session)).toEqual(
      unavailable("INVALID_RESPONSE"),
    );
  }
  expect(f.seen).toHaveLength(5);
});
