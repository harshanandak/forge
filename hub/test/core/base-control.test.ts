import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ChatWriteFailure } from "../../src/contract/chat.ts";
import { FakeChatPort } from "../fakes/fake-chat.ts";
import { FakeHostBridge } from "../fakes/fake-host.ts";
import { p1 } from "./fixture.ts";
import { button, digit, host } from "./fakes.ts";
import { fakeHostCore } from "./base-fakes.ts";

const timeout = 30_000;

test(
  "CT1 skeleton fakes delegate and record effects independently of the core",
  async () => {
    const chat = new FakeChatPort();
    const events: unknown[] = [];
    const hooks: unknown[] = [];
    const record = (event: unknown) => Promise.resolve(void events.push(event));
    await chat.start({
      onAction: (event) => {
        events.push(event);
        return Promise.resolve({ ephemeralText: "Selected" });
      },
      onMessage: record,
      onMessageChange: record,
    });
    const action = button("ask_control", "button");
    const input = digit("hello");
    expect(await chat.emitAction(action)).toEqual({
      ephemeralText: "Selected",
    });
    await chat.emitMessage(input);
    expect(events).toEqual([action, input]);
    expect(chat.calls.map((call) => call.name)).toEqual([
      "start",
      "emitAction",
      "emitMessage",
    ]);
    const target = { kind: "channel", channelId: "C00000001" } as const;
    const failure = async () => {
      const result = await chat
        .postText(target, "fixture")
        .catch((error: unknown) => error);
      if (!(result instanceof ChatWriteFailure))
        throw new Error("Expected ChatWriteFailure");
      return result;
    };
    for (const retryAfterMs of [undefined, 500]) {
      chat.nextWrite = {
        kind: "refused",
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      };
      const error = await failure();
      expect(error.effect).toBe("refused");
      expect(error.retryAfterMs).toBe(retryAfterMs);
      expect(chat.writes).toEqual([]);
    }
    chat.nextWrite = { kind: "unknown" };
    expect((await failure()).effect).toBe("unknown");
    expect(chat.writes).toHaveLength(1);
    const gate = Promise.withResolvers<void>();
    chat.nextWrite = { kind: "delay", until: gate.promise };
    let resolved = false;
    const pending = chat.postText(target, "delayed").then((ref) => {
      resolved = true;
      return ref;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(chat.writes).toHaveLength(2);
    gate.resolve();
    const ref = await pending;
    const summary = {
      projectId: p1,
      projectName: "Fixture One",
      revision: 1,
      lines: [],
      updatedAt: 0,
    };
    expect(await chat.editSummary(ref, summary)).toBe("missing");
    chat.provisionSummary(ref.channelId, "fixture", ref);
    expect(await chat.editSummary(ref, summary)).toBe("edited");
    const bridge = new FakeHostBridge(
      fakeHostCore({
        hookSession: (caller, input) => {
          hooks.push([caller, input]);
          return {
            ok: true,
            value: {
              sessionId: "ses_control",
              mode: "normal",
              unread: 0,
              unreadFromOthers: 0,
              itemIds: [],
            },
          };
        },
        hookMode: (caller, input) => {
          hooks.push([caller, input]);
          return { ok: true, value: { mode: "normal" } };
        },
      }),
      host,
    );
    expect(bridge.start("host-session", "resume", "thread").sessionId).toBe(
      "ses_control",
    );
    expect(bridge.mode("host-session").mode).toBe("normal");
    const session = { host: "claude", hostSessionId: "host-session" };
    expect(hooks).toEqual([
      [host, { ...session, source: "resume", threadId: "thread" }],
      [host, session],
    ]);
  },
  timeout,
);

test(
  "CT3 the store seam matches its lane 2a1 Git blob",
  () => {
    const text = readFileSync(
      new URL("../../src/core/store.ts", import.meta.url),
      "utf8",
    ).replaceAll("\r\n", "\n");
    const blob = createHash("sha1")
      .update("blob " + Buffer.byteLength(text) + "\0")
      .update(text);
    expect(blob.digest("hex")).toBe("962f2a0233d4d681624f5f5ffb4bfe6d7e8d99ae");
  },
  timeout,
);
