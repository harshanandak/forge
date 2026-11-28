import { expect } from "bun:test";
import { HTTP_STATUS, type HubErrorCode } from "../../src/contract/errors.ts";
import {
  ASK_DELIVERY_PENDING,
  HUB_RULES,
  HUB_RULES_NO_SLACK,
  LIMITS,
  MCP_TOOL_NAMES,
  SEND_POST_FAILED,
  type InboxItemView,
} from "../../src/contract/mcp.ts";
import {
  askResult,
  done,
  eras,
  fail,
  helloResult,
  inboxResult,
  json,
  ok,
  person,
  remoteTest,
  request,
  rpc,
  rpcRequest,
  safeOutput,
  token,
  waitResult,
  type RemoteCase,
} from "./fixtures.ts";

const timeout = 30_000;
const check = remoteTest(timeout);
const sessionId = "ses_a";
const projectId = "prj_demo";
const conversationId = "cnv_a";
const text = "Hi";
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
  reply: { sessionId, conversationId, text },
  report: {
    sessionId,
    projectId,
    requestAskId: "ask_a",
    state: "working",
    text,
  },
  send: { sessionId, projectId, toPersonId: person.personId, text },
};
const authCalls = ["findToken", "person"];
const call = (handle: RemoteCase["handle"], name: keyof typeof inputs) =>
  rpc(handle, name, inputs[name]);

for (const era of eras) {
  check("M1-M2 envelopes and seven tools " + era, async ({ core, handle }) => {
    for (const name of MCP_TOOL_NAMES) {
      const { status, tool } = await rpc(handle, name, inputs[name], era);
      const { structuredContent, content, isError } = tool;
      expect(status).toBe(200);
      expect(structuredContent).toMatchObject({
        ok: true,
        op: "hub." + name,
        status: "OK",
        warnings: [],
      });
      expect(isError).toBe(false);
      expect(content[0]?.type).toBe("text");
      expect(json(content[0]?.text ?? "")).toEqual(structuredContent);
      expect(core.calls.at(-1)?.slice(0, 3)).toEqual([
        name,
        { person, tokenId: "tok_a" },
        inputs[name],
      ]);
    }
  });
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
  ...[30000, 999].map(
    (timeoutMs) => ["wait", { sessionId, timeoutMs }, "/timeoutMs"] as const,
  ),
  ["reply", { ...inputs.reply, projectId }, ""],
  ["reply", { sessionId, text }, ""],
  ["send", { ...inputs.send, text: "x".repeat(3001) }, "/text"],
  ["ask", { ...inputs.ask, requestedAction: "ship" }, "/requestedAction"],
] as const;
for (const [index, [name, input, pointer]] of invalid.entries()) {
  check(
    `M3-M4 invalid input ${index + 1}: ${name} ${pointer}`,
    async ({ handle, names }) => {
      const { tool } = await rpc(handle, name, input);
      expect(tool).toMatchObject({
        isError: true,
        structuredContent: {
          status: "FAIL",
          error: { code: "INPUT_INVALID", pointer },
          warnings: [],
        },
      });
      expect(names()).toEqual(authCalls);
    },
  );
}

check(
  "M5-M6 authority, permit, reply-only and permitted reply",
  async ({ core, handle }) => {
    for (const [name, code] of [
      ["ask", "AUTHORITY_ASK_REFUSED"],
      ["ask", "REPLY_ONLY"],
      ["report", "PERMIT_REQUIRED"],
    ] as const) {
      core[name] = () => Promise.resolve(fail(code));
      const input =
        code === "AUTHORITY_ASK_REFUSED"
          ? { ...inputs.ask, question: "Approve the merge of PR 12?" }
          : inputs[name];
      const { status, tool } = await rpc(handle, name, input);
      expect(status).toBe(200);
      expect(tool).toMatchObject({
        isError: true,
        structuredContent: { error: { code, retry: "never" } },
      });
    }
    expect((await call(handle, "reply")).tool.isError).toBe(false);
    expect(core.calls.at(-1)?.[2]).toEqual(inputs.reply);
  },
);

check("M7 each core error maps unchanged", async ({ core, handle }) => {
  for (const code of Object.keys(HTTP_STATUS) as HubErrorCode[]) {
    const refusal = fail(code, { pointer: "/text", repair: "Check first" });
    core.send = () => Promise.resolve(refusal);
    const { status, tool } = await call(handle, "send");
    expect(status).toBe(200);
    expect(tool).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        status: "FAIL",
        error: refusal.ok ? {} : refusal.error,
      },
    });
  }
});

check("M8 exact unknown tool error", async ({ handle, names }) => {
  for (const name of ["merge", "Hello"]) {
    const { message } = await rpc(handle, name, {});
    expect(message).toMatchObject({
      error: { code: -32602, message: "Unknown tool" },
    });
  }
  expect(names()).toEqual([...authCalls, ...authCalls]);
});

const untilAbort = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
for (const needsAbort of [false, true]) {
  check(
    `M${needsAbort ? 10 : 9} guard and core wait deadlines`,
    async ({ core, handle }) => {
      let guardAborted = false;
      core.wait = async (_caller, _input, signal) => {
        if (needsAbort) {
          await untilAbort(signal);
          guardAborted = signal.aborted;
        } else await Bun.sleep(1000);
        return ok(waitResult);
      };
      const started = performance.now();
      const { structuredContent } = (await call(handle, "wait")).tool;
      const ms = performance.now() - started;
      expect(structuredContent.result).toEqual(waitResult);
      expect(guardAborted).toBe(needsAbort);
      expect(ms).toBeLessThan(needsAbort ? 3500 : 2500);
      if (needsAbort) expect(ms).toBeGreaterThanOrEqual(1000);
    },
  );
}

check(
  "M11 aborting a loopback fetch cancels the core wait",
  async ({ handler, core }) => {
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<number>();
    core.wait = async (_caller, _input, signal) => {
      entered.resolve();
      await untilAbort(signal);
      aborted.resolve(performance.now());
      return ok(waitResult);
    };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => handler.handle(request),
    });
    const cancel = new AbortController();
    try {
      const request = rpcRequest("tools/call", {
        name: "wait",
        arguments: inputs.wait,
      });
      const pending = fetch(new URL("/mcp", server.url), {
        method: request.method,
        body: await request.text(),
        headers: request.headers,
        signal: cancel.signal,
      }).catch(() => undefined);
      expect(
        await Promise.race([
          entered.promise.then(() => true),
          pending.then(() => false),
          Bun.sleep(2000).then(() => false),
        ]),
      ).toBe(true);
      await Bun.sleep(300);
      const start = performance.now();
      cancel.abort();
      expect(
        (await Promise.race([
          aborted.promise,
          Bun.sleep(500).then(() => Infinity),
        ])) - start,
      ).toBeLessThan(500);
      await pending;
    } finally {
      cancel.abort();
      await server.stop(true);
    }
  },
);

check(
  "M12 revoked while waiting is a tool result at HTTP 200",
  async ({ core, handle }) => {
    core.wait = () => Promise.resolve(fail("UNAUTHENTICATED"));
    const { status, tool } = await call(handle, "wait");
    expect(status).toBe(200);
    expect(tool).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "UNAUTHENTICATED" } },
    });
  },
);

check(
  "M13 core throws and rejects with a fixed envelope and one safe log each",
  async ({ core, handle, log }) => {
    core.inbox = () => {
      throw new Error(token);
    };
    core.reply = () => Promise.reject(new Error(token));
    for (const name of ["inbox", "reply"] as const) {
      const { tool } = await call(handle, name);
      expect(tool).toMatchObject({
        isError: true,
        structuredContent: {
          status: "FAIL",
          error: { code: "INTERNAL", retry: "reconcile_first" },
        },
      });
      safeOutput(JSON.stringify(tool));
    }
    expect(log.fields).toHaveLength(2);
    for (const [level, , fields] of log.fields) {
      expect(level).toBe("error");
      expect(typeof fields?.errorId).toBe("string");
      expect(fields?.code).toBe("INTERNAL");
      expect(Object.keys(fields ?? {}).sort()).toEqual(["code", "errorId"]);
    }
  },
);

check(
  "M14 and M16 request cap and unsupported methods",
  async ({ handle, names }) => {
    const oversized = { body: "x".repeat(LIMITS.bodyBytes + 1) };
    for (const [init, status] of [
      [oversized, 413],
      [{ method: "GET", body: null }, 405],
      [{ method: "DELETE", body: null }, 405],
    ] as const) {
      const result = await handle(request("/mcp", null, token, init));
      expect(result.status).toBe(status);
      expect(await result.json()).toMatchObject({
        error: { code: "INPUT_INVALID" },
      });
    }
    expect(names()).toEqual([...authCalls, ...authCalls, ...authCalls]);
  },
);

check(
  "M15 pending deliveries alone get the frozen warning",
  async ({ core, handle }) => {
    for (const pendingTo of [
      [{ personId: person.personId, name: person.displayName }],
      [],
    ]) {
      const value = { ...askResult, pendingTo };
      core.ask = () => done(value);
      const { structuredContent } = (await call(handle, "ask")).tool;
      expect(structuredContent.result).toEqual(value);
      expect(structuredContent.warnings).toEqual(
        pendingTo.length ? [ASK_DELIVERY_PENDING] : [],
      );
    }
  },
);

const projects = [{ projectId, name: "Demo", purpose: "Explain demo" }];
for (const rules of [HUB_RULES, HUB_RULES_NO_SLACK]) {
  check(
    "M17-M18 hello rules and project purpose " + rules.length,
    async ({ core, handle }) => {
      const value = { ...helloResult, rules, projects };
      core.hello = () => ok(value);
      const { structuredContent } = (await call(handle, "hello")).tool;
      expect(structuredContent).toMatchObject({ ok: true, op: "hub.hello" });
      expect(structuredContent.result).toEqual(value);
    },
  );
}

check(
  "M18 channel context and DM pass through inbox and wait",
  async ({ core, handle }) => {
    const at = "2026-01-01T00:00:00Z";
    const from = { name: "Owner", kind: "person" } as const;
    const base = {
      itemId: "itm_a",
      projectId,
      projectName: "Demo",
      projectPurpose: "Explain demo",
      kind: "chat_message",
      from,
      trust: "owner",
      text,
      receivedAt: at,
      redelivered: false,
    } as const;
    const entries = [1, 2, 3].map((n) => ({
      from: from.name,
      senderKind: from.kind,
      notYourOwner: false,
      at,
      mentionedBot: false,
      text: String(n),
    }));
    const items: InboxItemView[] = [
      {
        ...base,
        audience: "channel",
        threadContext: { entries, omitted: 2, notice: "Earlier context" },
      },
      { ...base, itemId: "itm_b", audience: "dm" },
    ];
    const inbox = { ...inboxResult, items };
    const wait = { ...waitResult, items, status: "ready" } as const;
    core.inbox = () => ok(inbox);
    core.wait = () => done(wait);
    for (const [name, expected] of [
      ["inbox", inbox],
      ["wait", wait],
    ] as const) {
      const { structuredContent } = (await call(handle, name)).tool;
      expect(structuredContent).toMatchObject({ ok: true, op: "hub." + name });
      expect(structuredContent.result).toEqual(expected);
    }
  },
);

check(
  "M19 visible send result, warning, conversation errors and pointer",
  async ({ core, handle }) => {
    const seen: unknown[] = [];
    for (const threadPost of ["posted", "failed", undefined] as const) {
      const value = { itemId: "itm_a", ...(threadPost ? { threadPost } : {}) };
      core.send = (_caller, input) => {
        seen.push(input);
        return done(value);
      };
      const input = {
        ...inputs.send,
        ...(threadPost ? { conversationId } : {}),
      };
      const { structuredContent } = (await rpc(handle, "send", input)).tool;
      expect(structuredContent.result).toEqual(value);
      expect(structuredContent.warnings).toEqual(
        threadPost === "failed" ? [SEND_POST_FAILED] : [],
      );
      expect(seen.at(-1)).toEqual(input);
    }
    for (const code of [
      "CONVERSATION_PAUSED",
      "CONVERSATION_NOT_YOURS",
      "CONVERSATION_UNKNOWN",
    ] as const) {
      core.send = () => Promise.resolve(fail(code));
      const { tool } = await rpc(handle, "send", {
        ...inputs.send,
        conversationId,
      });
      expect(tool.structuredContent.error?.code).toBe(code);
    }
    core.send = () => Promise.reject(new Error("Invalid id reached core"));
    const { tool } = await rpc(handle, "send", {
      ...inputs.send,
      conversationId: "bad",
    });
    expect(tool.structuredContent.error).toMatchObject({
      code: "INPUT_INVALID",
      pointer: "/conversationId",
    });
  },
);
