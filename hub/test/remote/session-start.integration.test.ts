import { expect, test } from "bun:test";
import { join } from "node:path";
import { key } from "./fixtures.ts";
import {
  failure,
  hookFixture,
  hung,
  session,
  silence,
} from "./hook-fixtures.ts";

const timeout = 30_000;
const output = (stdout: string) => ({ ...silence, stdout: stdout + "\n" });
const unavailable = (code: string) => output("Forge hub unavailable: " + code);
const result = {
  sessionId: "ses_a",
  mode: "normal",
  unread: 3,
  unreadFromOthers: 2,
  itemIds: [],
};
const line = (mode: string) =>
  output(
    "Forge hub session ses_a (" +
      mode +
      "). 3 unread, 2 not from you. Call forge-hub hello with sessionId ses_a, then inbox.",
  );

test(
  "S1-S2 and X2 launcher registers once per start and prints only validated fields",
  async () => {
    const f = await hookFixture();
    try {
      for (const source of ["startup", "resume", "clear", "compact"]) {
        const current = source === "resume" ? "reply_only" : "normal";
        f.respond = () =>
          Response.json({
            ok: true,
            status: "OK",
            result: {
              ...result,
              mode: current,
              items: [{ text: "untrusted text" }],
            },
          });
        expect(await f.run("session-start", { ...session, source })).toEqual(
          line(current),
        );
        expect(f.seen.at(-1)).toEqual({
          path: "/hook/session",
          method: "POST",
          bearer: "Bearer " + key,
          type: "application/json",
          body: { host: "claude", hostSessionId: "s1", source },
        });
      }
      expect(f.seen).toHaveLength(4);
    } finally {
      await f.close();
    }
  },
  timeout,
);

test(
  "S3 only the supported T3 environment variable within bounds becomes threadId",
  async () => {
    const f = await hookFixture();
    try {
      for (const value of ["thr_1", undefined, "", "a".repeat(257)]) {
        expect(
          await f.run("session-start", session, {
            T3_THREAD_ID: "thr_legacy",
            ...(value === undefined ? {} : { T3CODE_THREAD_ID: value }),
          }),
        ).toEqual(line("normal"));
        expect(f.seen.at(-1)?.body).toEqual({
          host: "claude",
          hostSessionId: "s1",
          source: "startup",
          ...(value === "thr_1" ? { threadId: value } : {}),
        });
      }
      expect(f.seen).toHaveLength(4);
    } finally {
      await f.close();
    }
  },
  timeout,
);

test(
  "S4 expected hub and configuration failures produce one fixed safe diagnostic",
  async () => {
    const f = await hookFixture();
    try {
      for (const [code, respond] of [
        ["HUB_TIMEOUT", hung],
        ["UNAUTHENTICATED", () => failure(401, "UNAUTHENTICATED")],
        ["BLOCK_DISABLED", () => failure(503, "BLOCK_DISABLED")],
        ["INPUT_INVALID", () => failure(400, "INPUT_INVALID")],
        ["INVALID_RESPONSE", () => Response.json({ ok: true })],
      ] as const) {
        f.respond = (_path, signal) => respond(signal);
        const started = performance.now();
        expect(await f.run("session-start", session)).toEqual(
          unavailable(code),
        );
        expect(performance.now() - started).toBeLessThan(3500);
      }
      expect(
        await f.run("session-start", session, {
          FORGE_HUB_HOST_KEY_FILE: join(f.root, "missing"),
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
    } finally {
      await f.close();
    }
  },
  timeout,
);

test(
  "S5 and Y1 invalid session input and reply fields do not print untrusted values",
  async () => {
    const f = await hookFixture();
    try {
      for (const input of [
        "null",
        "[]",
        '"x"',
        {},
        { session_id: "s1" },
        { ...session, session_id: 1 },
      ]) {
        expect(await f.run("session-start", input)).toEqual(
          unavailable("INVALID_INPUT"),
        );
      }
      expect(f.seen).toEqual([]);
      for (const invalid of [
        null,
        { ...result, sessionId: "not an id" },
        { ...result, mode: "unknown" },
        { ...result, unread: -1 },
        { ...result, unreadFromOthers: "2" },
      ]) {
        f.respond = () =>
          Response.json({ ok: true, status: "OK", result: invalid });
        expect(await f.run("session-start", session)).toEqual(
          unavailable("INVALID_RESPONSE"),
        );
      }
      expect(f.seen).toHaveLength(5);
    } finally {
      await f.close();
    }
  },
  timeout,
);
