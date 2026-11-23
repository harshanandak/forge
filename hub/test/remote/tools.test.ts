import { expect, test } from "bun:test";
import {
  HTTP_STATUS,
  SECRET_PATTERNS,
  type HubErrorCode,
} from "../../src/contract/errors.ts";
import {
  ASK_DELIVERY_PENDING,
  HUB_RULES,
  HUB_RULES_NO_SLACK,
  LIMITS,
  MCP_TOOL_NAMES,
  SEND_POST_FAILED,
  type InboxItemView,
} from "../../src/contract/mcp.ts";
import { createRemoteHandler } from "../../src/remote/index.ts";
import {
  callTool,
  deps,
  eras,
  fail,
  helloResult,
  inboxResult,
  ok,
  person,
  request,
  rpcRequest,
  token,
  toolResult,
  waitResult,
} from "./fixtures.ts";

const timeout = 30_000;
const sessionId = "ses_a";
const projectId = "prj_demo";
const conversationId = "cnv_a";
const inputs = {
  hello: { host: "claude" },
  inbox: { sessionId },
  wait: { sessionId, timeoutMs: 1000 },
  ask: {
    sessionId,
    projectId,
    kind: "choice",
    requestedAction: "choice",
    question: "Ready?",
  },
  reply: { sessionId, conversationId, text: "Hi" },
  report: {
    sessionId,
    projectId,
    requestAskId: "ask_a",
    state: "working",
    text: "Hi",
  },
  send: { sessionId, projectId, toPersonId: person.personId, text: "Hi" },
} as const;

for (const era of eras) {
  test(
    `M1-M2 envelopes and all seven tools reach the core in ${era}`,
    async () => {
      const fixture = deps();
      const handler = createRemoteHandler(fixture);
      try {
        for (const name of MCP_TOOL_NAMES) {
          const { status, message } = await callTool(
            handler,
            name,
            inputs[name],
            era,
          );
          expect(status).toBe(200);
          const result = toolResult(message);
          expect(result.structuredContent).toMatchObject({
            ok: true,
            op: "hub." + name,
            status: "OK",
            warnings: [],
          });
          expect(result.isError).toBe(false);
          expect(result.content[0]?.type).toBe("text");
          expect(JSON.parse(result.content[0]?.text ?? "")).toEqual(
            result.structuredContent,
          );
          expect(fixture.core.calls.at(-1)?.slice(0, 3)).toEqual([
            name,
            { person, tokenId: "tok_a" },
            inputs[name],
          ]);
        }
      } finally {
        await handler.close();
      }
    },
    timeout,
  );
}

const invalid = [
  ["ask", { ...inputs.ask, sender: person }, "/sender"],
  ["send", { ...inputs.send, fromPersonId: person.personId }, "/fromPersonId"],
  ["report", { ...inputs.report, answeredBy: person }, "/answeredBy"],
  ...MCP_TOOL_NAMES.map(
    (name) => [name, {}, name === "hello" ? "/host" : "/sessionId"] as const,
  ),
  ["hello", { host: 1 }, "/host"],
  ["inbox", { sessionId, limit: 51 }, "/limit"],
  ["wait", { sessionId, timeoutMs: 30000 }, "/timeoutMs"],
  ["wait", { sessionId, timeoutMs: 999 }, "/timeoutMs"],
  ["reply", { ...inputs.reply, projectId }, ""],
  ["reply", { sessionId, text: "Hi" }, ""],
  ["send", { ...inputs.send, text: "x".repeat(3001) }, "/text"],
  ["ask", { ...inputs.ask, requestedAction: "ship" }, "/requestedAction"],
] as const;

for (const [index, [name, input, pointer]] of invalid.entries()) {
  test(
    `M3-M4 schema refusal ${index + 1} for ${name} names ${pointer || "the root"}`,
    async () => {
      const fixture = deps();
      const handler = createRemoteHandler(fixture);
      try {
        const { message } = await callTool(handler, name, input);
        expect(toolResult(message)).toMatchObject({
          isError: true,
          structuredContent: {
            status: "FAIL",
            error: { code: "INPUT_INVALID", pointer },
            warnings: [],
          },
        });
        expect(fixture.core.calls.map(([call]) => call)).toEqual([
          "findToken",
          "person",
        ]);
      } finally {
        await handler.close();
      }
    },
    timeout,
  );
}

test(
  "M5-M6 authority, permit and reply-only outcomes pass through unchanged",
  async () => {
    const fixture = deps();
    const handler = createRemoteHandler(fixture);
    try {
      fixture.core.ask = () => Promise.resolve(fail("AUTHORITY_ASK_REFUSED"));
      const ask = await callTool(handler, "ask", {
        ...inputs.ask,
        question: "Approve the merge of PR 12?",
      });
      expect(ask.status).toBe(200);
      expect(toolResult(ask.message)).toMatchObject({
        isError: true,
        structuredContent: {
          error: fail("AUTHORITY_ASK_REFUSED").ok
            ? {}
            : { code: "AUTHORITY_ASK_REFUSED", retry: "never" },
        },
      });
      fixture.core.ask = () => Promise.resolve(fail("REPLY_ONLY"));
      fixture.core.report = () => Promise.resolve(fail("PERMIT_REQUIRED"));
      for (const [tool, code] of [
        ["ask", "REPLY_ONLY"],
        ["report", "PERMIT_REQUIRED"],
      ] as const) {
        const { message } = await callTool(handler, tool, inputs[tool]);
        expect(toolResult(message).structuredContent.error?.code).toBe(code);
      }
      expect(
        toolResult((await callTool(handler, "reply", inputs.reply)).message)
          .isError,
      ).toBe(false);
      expect(fixture.core.calls.at(-1)?.[2]).toEqual(inputs.reply);
    } finally {
      await handler.close();
    }
  },
  timeout,
);

test(
  "M7 every core error survives MCP envelope mapping",
  async () => {
    const fixture = deps();
    const handler = createRemoteHandler(fixture);
    try {
      for (const code of Object.keys(HTTP_STATUS) as HubErrorCode[]) {
        const refusal = fail(code, { pointer: "/text", repair: "Check first" });
        fixture.core.send = () => Promise.resolve(refusal);
        const { status, message } = await callTool(
          handler,
          "send",
          inputs.send,
        );
        expect(status).toBe(200);
        expect(toolResult(message)).toMatchObject({
          isError: true,
          structuredContent: {
            ok: false,
            status: "FAIL",
            error: refusal.ok ? {} : refusal.error,
          },
        });
      }
    } finally {
      await handler.close();
    }
  },
  timeout,
);

test(
  "M8 unknown tool is a JSON-RPC invalid-parameters error",
  async () => {
    const fixture = deps();
    const handler = createRemoteHandler(fixture);
    try {
      for (const name of ["merge", "Hello"]) {
        expect((await callTool(handler, name, {})).message).toMatchObject({
          error: { code: -32602, message: "Unknown tool" },
        });
      }
      expect(fixture.core.calls.map(([name]) => name)).toEqual([
        "findToken",
        "person",
        "findToken",
        "person",
      ]);
    } finally {
      await handler.close();
    }
  },
  timeout,
);

for (const needsAbort of [false, true]) {
  test(
    `M${needsAbort ? 10 : 9} wait returns the core result with ${needsAbort ? "guard abort" : "core timeout"}`,
    async () => {
      const fixture = deps();
      let guardAborted = false;
      fixture.core.wait = async (_caller, _input, signal) => {
        if (needsAbort) {
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          guardAborted = signal.aborted;
        } else {
          await Bun.sleep(1000);
        }
        return ok(waitResult);
      };
      const handler = createRemoteHandler(fixture);
      try {
        const started = performance.now();
        const { message } = await callTool(handler, "wait", inputs.wait);
        const ms = performance.now() - started;
        expect(toolResult(message).structuredContent.result).toEqual(
          waitResult,
        );
        expect(guardAborted).toBe(needsAbort);
        expect(ms).toBeLessThan(needsAbort ? 3500 : 2500);
        if (needsAbort) expect(ms).toBeGreaterThanOrEqual(1000);
      } finally {
        await handler.close();
      }
    },
    timeout,
  );
}

test(
  "M11 client cancellation aborts the core wait",
  async () => {
    const fixture = deps();
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<number>();
    fixture.core.wait = async (_caller, _input, signal) => {
      entered.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      aborted.resolve(performance.now());
      return ok(waitResult);
    };
    const handler = createRemoteHandler(fixture);
    const cancel = new AbortController();
    try {
      const pending = handler
        .handle(
          rpcRequest(
            "tools/call",
            { name: "wait", arguments: inputs.wait },
            undefined,
            cancel.signal,
          ),
        )
        .catch(() => undefined);
      await entered.promise;
      await Bun.sleep(300);
      const time = performance.now();
      cancel.abort();
      const result = await Promise.race([
        aborted.promise,
        Bun.sleep(500).then(() => Infinity),
      ]);
      expect(result - time).toBeLessThan(500);
      await pending;
    } finally {
      cancel.abort();
      await handler.close();
    }
  },
  timeout,
);

test(
  "M12 post-wake revocation is an HTTP 200 tool failure",
  async () => {
    const fixture = deps();
    fixture.core.wait = () => Promise.resolve(fail("UNAUTHENTICATED"));
    const handler = createRemoteHandler(fixture);
    try {
      const { status, message } = await callTool(handler, "wait", inputs.wait);
      expect(status).toBe(200);
      expect(toolResult(message)).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "UNAUTHENTICATED" } },
      });
    } finally {
      await handler.close();
    }
  },
  timeout,
);

test(
  "M13 thrown and rejected core calls produce one safe error log each",
  async () => {
    const fixture = deps();
    fixture.core.inbox = () => {
      throw new Error(token);
    };
    fixture.core.reply = () => Promise.reject(new Error(token));
    const handler = createRemoteHandler(fixture);
    try {
      for (const name of ["inbox", "reply"] as const) {
        const result = toolResult(
          (await callTool(handler, name, inputs[name])).message,
        );
        expect(result).toMatchObject({
          isError: true,
          structuredContent: {
            status: "FAIL",
            error: { code: "INTERNAL", retry: "reconcile_first" },
          },
        });
        for (const pattern of SECRET_PATTERNS)
          expect(JSON.stringify(result)).not.toMatch(pattern);
      }
      expect(fixture.log.fields).toHaveLength(2);
      for (const [level, , fields] of fixture.log.fields) {
        expect(level).toBe("error");
        expect(typeof fields?.errorId).toBe("string");
        expect(fields?.code).toBe("INTERNAL");
        expect(Object.keys(fields ?? {}).sort()).toEqual(["code", "errorId"]);
        expect(JSON.stringify(fields)).not.toContain(token);
      }
    } finally {
      await handler.close();
    }
  },
  timeout,
);

test(
  "M14 and M16 oversized MCP request and unsupported methods use transport refusals",
  async () => {
    const fixture = deps();
    const handler = createRemoteHandler(fixture);
    try {
      const oversized = await handler.handle(
        request("/mcp", null, token, {
          body: "x".repeat(LIMITS.bodyBytes + 1),
        }),
      );
      expect(oversized.status).toBe(413);
      expect(await oversized.json()).toMatchObject({
        error: { code: "INPUT_INVALID" },
      });
      for (const method of ["GET", "DELETE"]) {
        const refusal = await handler.handle(
          request("/mcp", null, token, { method, body: null }),
        );
        expect(refusal.status).toBe(405);
        expect(await refusal.json()).toMatchObject({
          error: { code: "INPUT_INVALID" },
        });
      }
      expect(fixture.core.calls.map(([name]) => name)).toEqual(
        Array.from({ length: 3 }, () => ["findToken", "person"]).flat(),
      );
    } finally {
      await handler.close();
    }
  },
  timeout,
);

test(
  "M15 ask delivery warning tracks pending recipients",
  async () => {
    const fixture = deps();
    const handler = createRemoteHandler(fixture);
    try {
      for (const pendingTo of [
        [{ personId: person.personId, name: person.displayName }],
        [],
      ]) {
        const value = {
          askId: "ask_a",
          status: "open",
          pendingTo,
          deliveredTo: [],
          expiresAt: "2026-01-02T00:00:00Z",
        } as const;
        fixture.core.ask = () => Promise.resolve(ok(value));
        const result = toolResult(
          (await callTool(handler, "ask", inputs.ask)).message,
        ).structuredContent;
        expect(result.result).toEqual(value);
        expect(result.warnings).toEqual(
          pendingTo.length ? [ASK_DELIVERY_PENDING] : [],
        );
      }
    } finally {
      await handler.close();
    }
  },
  timeout,
);

test(
  "M17-M18 preserve rules, project purpose, audience and channel context",
  async () => {
    const fixture = deps();
    const handler = createRemoteHandler(fixture);
    try {
      for (const rules of [HUB_RULES, HUB_RULES_NO_SLACK]) {
        const value = {
          ...helloResult,
          rules,
          projects: [{ projectId, name: "Demo", purpose: "Explain demo" }],
        };
        fixture.core.hello = () => ok(value);
        const envelope = toolResult(
          (await callTool(handler, "hello", inputs.hello)).message,
        ).structuredContent;
        expect(envelope).toMatchObject({ ok: true, op: "hub.hello" });
        expect(envelope.result).toEqual(value);
      }
      const item = {
        itemId: "itm_a",
        projectId,
        projectName: "Demo",
        projectPurpose: "Explain demo",
        kind: "chat_message",
        from: { name: "Owner", kind: "person" },
        trust: "owner",
        text: "Hi",
        receivedAt: "2026-01-01T00:00:00Z",
        redelivered: false,
      } as const;
      const items: InboxItemView[] = [
        {
          ...item,
          audience: "channel",
          threadContext: {
            entries: [1, 2, 3].map((n) => ({
              from: "Owner",
              senderKind: "person",
              notYourOwner: false,
              at: item.receivedAt,
              mentionedBot: false,
              text: String(n),
            })),
            omitted: 2,
            notice: "Earlier context",
          },
        },
        { ...item, itemId: "itm_b", audience: "dm" },
      ];
      const inbox = { ...inboxResult, items };
      const wait = { ...waitResult, items, status: "ready" } as const;
      fixture.core.inbox = () => ok(inbox);
      fixture.core.wait = () => Promise.resolve(ok(wait));
      for (const [name, expected] of [
        ["inbox", inbox],
        ["wait", wait],
      ] as const) {
        const envelope = toolResult(
          (await callTool(handler, name, inputs[name])).message,
        ).structuredContent;
        expect(envelope).toMatchObject({ ok: true, op: "hub." + name });
        expect(envelope.result).toEqual(expected);
      }
    } finally {
      await handler.close();
    }
  },
  timeout,
);

test(
  "M19 send passes conversation id, visible post outcome and refusals",
  async () => {
    const fixture = deps();
    const handler = createRemoteHandler(fixture);
    const seen: unknown[] = [];
    try {
      for (const threadPost of ["posted", "failed", undefined] as const) {
        const value = {
          itemId: "itm_a",
          ...(threadPost ? { threadPost } : {}),
        };
        fixture.core.send = (_caller, input) => {
          seen.push(input);
          return Promise.resolve(ok(value));
        };
        const input = {
          ...inputs.send,
          ...(threadPost ? { conversationId } : {}),
        };
        const envelope = toolResult(
          (await callTool(handler, "send", input)).message,
        ).structuredContent;
        expect(envelope.result).toEqual(value);
        expect(envelope.warnings).toEqual(
          threadPost === "failed" ? [SEND_POST_FAILED] : [],
        );
        expect(seen.at(-1)).toEqual(input);
      }
      for (const code of [
        "CONVERSATION_PAUSED",
        "CONVERSATION_NOT_YOURS",
        "CONVERSATION_UNKNOWN",
      ] as const) {
        fixture.core.send = () => Promise.resolve(fail(code));
        expect(
          toolResult(
            (
              await callTool(handler, "send", {
                ...inputs.send,
                conversationId,
              })
            ).message,
          ).structuredContent.error?.code,
        ).toBe(code);
      }
      fixture.core.send = () =>
        Promise.reject(new Error("Invalid id reached core"));
      const envelope = toolResult(
        (
          await callTool(handler, "send", {
            ...inputs.send,
            conversationId: "bad",
          })
        ).message,
      ).structuredContent;
      expect(envelope.error).toMatchObject({
        code: "INPUT_INVALID",
        pointer: "/conversationId",
      });
    } finally {
      await handler.close();
    }
  },
  timeout,
);
