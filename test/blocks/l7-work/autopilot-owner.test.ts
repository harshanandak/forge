import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";
import {
  laneOwnerChannelAsk,
  laneOwnerChannelOp,
  ownerApproval,
  requestBoundTo,
  type ApprovalRequired,
} from "../../../src/assembly/approval.ts";

setDefaultTimeout(30_000);
type Action = {
  lane: string;
  step: string;
  n: number;
  kind: string;
  why: string;
  expect: string;
  ask?: string;
  argv?: string[];
  approval?: {
    request: string;
    quote: string;
    source: Record<string, string>;
  };
};
type Source = { harness: string; thread: string; message: string };
type Reply = {
  recorded: true;
  mapped: boolean;
  answers: { lane: string; label: string; choice: string; hold: boolean }[];
  approvals: {
    lane: string;
    op: string;
    input: Record<string, unknown>;
    approval: { request: string; quote: string; source: Source };
  }[];
};
type Handler<Output> = (call: {
  input: Record<string, unknown>;
  services: unknown;
  config?: unknown;
  signal: AbortSignal;
  deadline: number;
}) => Output | Promise<Output>;
type Operations = {
  "lane.next": Handler<Action | { actions: Action[] }>;
  "lane.stop": Handler<{ stopped: string }>;
  "lane.record": Handler<Reply | { recorded: true }>;
};
type Row = {
  key: string;
  revision: number;
  updatedAt: string;
  value: Record<string, unknown>;
};

const entry = resolve(
  import.meta.dirname,
  "../../../src/blocks/work/entry.cts",
);
const globals = globalThis as Record<string, unknown>;
const previousFail = globals.fail;
let operations: Operations;
beforeAll(() => {
  globals.fail = (code: string, message: string) => {
    throw new Error(`${code}: ${message}`);
  };
  delete require.cache[entry];
  operations = require(entry) as Operations;
});
afterAll(() => {
  if (previousFail === undefined) delete globals.fail;
  else globals.fail = previousFail;
});

const OWNER: Source = {
  harness: "claude-code",
  thread: "claude-code:owner-1",
  message: "m-1",
};
const MINUTE = 60_000;

function fixture() {
  const config = {
    lanes: { autopilot: { enabled: true, budgets: { calls: 1 } } },
  };
  const time = { now: Date.parse("2026-01-01T00:00:00.000Z") };
  const records = new Map<string, Row>();
  const put = (
    key: string,
    value: Record<string, unknown>,
    options: { expectRevision: number },
  ) => {
    if ((records.get(key)?.revision ?? 0) !== options.expectRevision)
      throw new Error("REVISION_CONFLICT");
    const row = {
      key,
      value,
      revision: options.expectRevision + 1,
      updatedAt: new Date(time.now).toISOString(),
    };
    records.set(key, row);
    return row;
  };
  const ids = ["work-1", "work-2"];
  for (const id of ids)
    put(
      `issue:${id}`,
      {
        id,
        title: id === "work-1" ? "stale build hint" : "door approval",
        status: "open",
        labels: [],
        dependsOn: [],
        createdAt: new Date(time.now).toISOString(),
      },
      { expectRevision: 0 },
    );
  const state = {
    count: (prefix: string) =>
      [...records.keys()].filter((key) => key.startsWith(prefix)).length,
    maxNumber: () => 0,
    now: () => time.now,
    get: (key: string) => records.get(key),
    list: (prefix: string) =>
      [...records.values()].filter((row) => row.key.startsWith(prefix)),
    put,
    lease: () => undefined,
    acquire: () => undefined,
  };
  const registry = ids.map((id) => ({
    issue: id,
    issueId: id,
    worktree: `/lane/${id}`,
    branch: `feat/${id}`,
    brief: `/project/.worktrees/briefs/${id}.md`,
  }));
  const session = {
    env: { CLAUDE_CODE_SESSION_ID: "owner-1" } as Record<string, string>,
  };
  const services = {
    state,
    files: {
      root: "/project",
      read: (path: string) =>
        path === "forge-lanes.json" ? JSON.stringify(registry) : undefined,
    },
    environment: {
      platform: "linux",
      select: (names: string[]) =>
        Object.fromEntries(
          Object.entries(session.env).filter(([name]) => names.includes(name)),
        ),
      load: () => Promise.resolve({ freeMemoryMb: 8000, cpuBusyPercent: 10 }),
    },
    process: {
      resolve: (path: string) => ({ kind: "resolved", path }),
      run: () => Promise.reject(new Error("a pause must not reach GitHub")),
    },
  };
  const bound = (input: Record<string, unknown>) => ({
    input,
    services,
    config,
    signal: new AbortController().signal,
    deadline: Number.MAX_SAFE_INTEGER,
  });
  return {
    config,
    time,
    put,
    session,
    records,
    // A lane that has used its one call pauses with a budget ask.
    spend: (id: string) =>
      put(
        `comment:${id}:1`,
        { id, body: "call 1 builder", call: 1 },
        { expectRevision: 0 },
      ),
    next: async (id: string) =>
      (await operations["lane.next"](bound({ id }))) as Action,
    all: async () =>
      (
        (await operations["lane.next"](bound({ all: true }))) as {
          actions: Action[];
        }
      ).actions,
    // The owner's approval for this input is the runtime's job; the handler only stores it.
    setOwner: async (channel: { harness: string; thread: string } = OWNER) =>
      await operations["lane.record"](
        bound({
          ownerChannel: { harness: channel.harness, thread: channel.thread },
        }),
      ),
    stop: (id: string) => operations["lane.stop"](bound({ id })),
    record: async (input: Record<string, unknown>) =>
      await operations["lane.record"](bound(input)),
    reply: async (reply: string, source: Source = OWNER) =>
      (await operations["lane.record"](bound({ reply, source }))) as Reply,
  };
}
const sent = (actions: Action[]) =>
  actions.filter((action) => action.kind === "ask-owner");

test("two lanes pausing within 30 minutes give one message with two numbered asks and their defaults", async () => {
  const f = fixture();
  await f.setOwner();
  f.spend("work-1");
  f.spend("work-2");
  f.put(
    "autopilot-event:work-1:1",
    {
      id: "work-1",
      type: "done",
      at: new Date(f.time.now - MINUTE).toISOString(),
      detail: { pr: 12 },
    },
    { expectRevision: 0 },
  );
  const actions = await f.all();
  const messages = sent(actions);
  expect(messages).toHaveLength(1);
  const text = messages[0]!.ask!;
  expect(text).toContain("Lanes need you (2)");
  expect(text).toMatch(/1\. work-1 "stale build hint": .*budget/);
  expect(text).toMatch(/2\. work-2 "door approval": .*budget/);
  expect(text.match(/Default C/g)).toHaveLength(2);
  expect(text).toContain("A) carry on");
  expect(text).toContain(
    "Merged and closed since my last message: work-1 (#12)",
  );
  // The other lane rides in the same message, it is not a second one.
  expect(actions.map((action) => action.kind).sort()).toEqual([
    "ask-owner",
    "wait",
  ]);
  // A third ask five minutes later is held for the window.
  f.time.now += 5 * MINUTE;
  for (const action of await f.all()) expect(action.kind).toBe("wait");
});

test('the reply "1A 2B" unpauses both lanes with the chosen options', async () => {
  const f = fixture();
  await f.setOwner();
  f.spend("work-1");
  f.spend("work-2");
  await f.all();
  const result = await f.reply("#1 1A 2B");
  expect(result.mapped).toBe(true);
  expect(result.answers.map(({ lane, label }) => [lane, label])).toEqual([
    ["work-1", "A"],
    ["work-2", "B"],
  ]);
  const [one, two] = [await f.next("work-1"), await f.next("work-2")];
  for (const action of [one, two]) {
    expect(action.kind).toBe("harness");
    expect(action.step).toBe("owner");
    expect(action.why).toContain('"#1 1A 2B"');
  }
  expect(one.why).toContain("chose A");
  expect(two.why).toContain("chose B");
  // Doing the choice closes it; the lane then runs on its own facts again.
  await f.record({
    id: "work-1",
    action: one.n,
    result: '{"done":true}',
  });
  expect(await f.next("work-1")).toMatchObject({ kind: "wait" });
});

test("a free-text reply that maps to two labels for one item keeps both paused and queues one clarifying question", async () => {
  const f = fixture();
  await f.setOwner();
  f.spend("work-1");
  f.spend("work-2");
  await f.all();
  for (const text of ["1A or 1B", "1A 2", "1A 1B 2C", "do 1A", "1D 2A"]) {
    const result = await f.reply(`#1 ${text}`);
    expect(result.mapped).toBe(false);
    expect(result.answers).toEqual([]);
  }
  const actions = await f.all();
  expect(actions.map((action) => action.kind).sort()).toEqual([
    "ask-owner",
    "wait",
  ]);
  expect(sent(actions)[0]!.ask).toContain("could not tell which option");
  expect(actions.every((action) => action.kind !== "harness")).toBe(true);
  // A reply that maps afterwards still works: nothing was applied before.
  expect((await f.reply("#2 1C 2C")).mapped).toBe(true);
});

test("a gated ask's reply produces an approval with the stored request id, and a non-owner reply does not", async () => {
  const f = fixture();
  await f.setOwner();
  await f.stop("work-1");
  // The ask is not sent until the request id it will be bound to is recorded.
  const fetch = await f.next("work-1");
  expect(fetch.kind).toBe("forge");
  expect(fetch.argv).toEqual(["forge", "lane", "resume", "work-1"]);
  await f.record({
    id: "work-1",
    request: "req-123",
    scope: { id: "work-1" },
  });
  const ask = await f.next("work-1");
  expect(ask.kind).toBe("ask-owner");
  expect(ask.ask).toContain("A) resume it");
  await expect(
    f.reply("#1 1A", {
      harness: "codex",
      thread: "codex:other",
      message: "m-9",
    }),
  ).rejects.toThrow(/not from the owner channel/);
  expect(await f.next("work-1")).toMatchObject({ kind: "wait" });
  const result = await f.reply("#1 1A");
  expect(result.approvals).toEqual([
    {
      lane: "work-1",
      op: "lane.resume",
      input: { id: "work-1" },
      approval: { request: "req-123", quote: "#1 1A", source: OWNER },
    },
  ]);
  const step = await f.next("work-1");
  expect(step.kind).toBe("harness");
  expect(step.approval).toEqual({
    request: "req-123",
    quote: "#1 1A",
    source: OWNER,
  });
  // The defaults reply never approves: B keeps it stopped.
  const kept = fixture();
  await kept.setOwner();
  await kept.stop("work-1");
  await kept.next("work-1");
  await kept.record({
    id: "work-1",
    request: "req-456",
    scope: { id: "work-1" },
  });
  await kept.next("work-1");
  const none = await kept.reply("#1 ok");
  expect(none.approvals).toEqual([]);
  expect(none.answers[0]).toMatchObject({ label: "B", hold: true });
});

test("with no reply both lanes stay paused past any number of windows", async () => {
  const f = fixture();
  await f.setOwner();
  f.spend("work-1");
  f.spend("work-2");
  for (let window = 0; window < 6; window += 1) {
    const actions = await f.all();
    expect(actions.map((action) => action.kind).sort()).toEqual([
      "ask-owner",
      "wait",
    ]);
    // Inside the window nothing more is sent.
    f.time.now += 10 * MINUTE;
    for (const action of await f.all()) expect(action.kind).toBe("wait");
    f.time.now += 20 * MINUTE;
  }
  for (const id of ["work-1", "work-2"])
    expect(f.records.get(`autopilot-ask:${id}`)?.value.status).toBe("sent");
});

test("an urgent kill-switch item is sent at once, not held for the window", async () => {
  const f = fixture();
  await f.setOwner();
  f.spend("work-1");
  expect((await f.next("work-1")).kind).toBe("ask-owner");
  f.time.now += 5 * MINUTE;
  f.spend("work-2");
  expect((await f.next("work-2")).kind).toBe("wait");
  f.config.lanes.autopilot.enabled = false;
  const urgent = await f.next("work-2");
  expect(urgent.kind).toBe("ask-owner");
  expect(urgent.ask).toContain("switched off");
});

test("an ask reached from another session is handed to the owner channel", async () => {
  const f = fixture();
  await f.setOwner();
  f.spend("work-1");
  expect((await f.next("work-1")).kind).toBe("ask-owner");
  f.session.env = { CLAUDE_CODE_SESSION_ID: "child-9" };
  const action = await f.next("work-1");
  expect(action.kind).toBe("hand-to-owner");
  expect(action.ask).toBeUndefined();
  expect(action.why).toContain("not the owner channel");
});

test("a session that calls lane next first does not become the owner channel and cannot approve", async () => {
  const f = fixture();
  f.spend("work-1");
  f.session.env = { CLAUDE_CODE_SESSION_ID: "builder-7" };
  const first = await f.next("work-1");
  expect(first.kind).toBe("pause");
  expect(first.why).toContain("owner channel is not set");
  expect(first.ask).toContain("ownerChannel");
  expect(f.records.get("autopilot-ask:work-1")?.value.status).toBe("queued");
  expect(
    (
      f.records.get("autopilot:global")?.value as
        { owner?: unknown } | undefined
    )?.owner,
  ).toBeUndefined();
  // Asking again, even for a gated stop, still sends nothing and approves nothing.
  await f.stop("work-1");
  expect((await f.next("work-1")).kind).toBe("pause");
  await expect(
    f.reply("1A", {
      harness: "claude-code",
      thread: "claude-code:builder-7",
      message: "m-2",
    }),
  ).rejects.toThrow(/No owner message is waiting/);
  // Once the owner names their channel, the builder is handed off and its reply is refused.
  await f.setOwner();
  expect((await f.next("work-1")).kind).toBe("hand-to-owner");
  await expect(
    f.reply("1A", {
      harness: "claude-code",
      thread: "claude-code:builder-7",
      message: "m-3",
    }),
  ).rejects.toThrow(/No owner message is waiting/);
});

test("naming the owner channel needs the owner's relayed approval at the runtime", () => {
  const candidate = { blockId: "forge/work", declaredOp: "lane.record" };
  const input = { ownerChannel: { harness: "claude-code", thread: "t-1" } };
  expect(laneOwnerChannelOp(candidate, input)).toBe(true);
  expect(laneOwnerChannelOp(candidate, { id: "work-1", request: "r" })).toBe(
    false,
  );
  expect(
    laneOwnerChannelOp(
      { blockId: "forge/work", declaredOp: "lane.next" },
      input,
    ),
  ).toBe(false);
  expect(laneOwnerChannelAsk(input)).toContain("owner channel");
});

test("a reply to an older message is refused when the message was sent again", async () => {
  const f = fixture();
  await f.setOwner();
  f.spend("work-1");
  f.spend("work-2");
  const [first] = sent(await f.all());
  expect(first!.ask).toContain("Message #1");
  f.time.now += 31 * MINUTE;
  const [second] = sent(await f.all());
  expect(second!.ask).toContain("Message #2");
  await expect(f.reply("#1 1A 2B")).rejects.toThrow(
    /message #1 but the latest is #2/,
  );
  await expect(f.reply("1A 2B")).rejects.toThrow(/Name the message/);
  for (const id of ["work-1", "work-2"])
    expect(f.records.get(`autopilot-ask:${id}`)?.value.status).toBe("sent");
  // A changed channel never reuses an old number.
  await f.setOwner({ harness: "claude-code", thread: "claude-code:owner-2" });
  f.session.env = { CLAUDE_CODE_SESSION_ID: "owner-2" };
  const [third] = sent(await f.all());
  expect(third!.ask).toContain("Message #3");
});

for (const halt of ["stop", "off"] as const)
  test(`a stored answer never outranks the kill switch (${halt})`, async () => {
    const f = fixture();
    await f.setOwner();
    f.spend("work-1");
    f.spend("work-2");
    await f.all();
    await f.reply("#1 1A 2C");
    expect((await f.next("work-1")).kind).toBe("harness");
    if (halt === "stop") await f.stop("work-1");
    else f.config.lanes.autopilot.enabled = false;
    const action = await f.next("work-1");
    expect(action.kind).not.toBe("harness");
    expect(action.approval).toBeUndefined();
  });

test("a request id for another scope is refused and a recorded one is not replaced", async () => {
  const f = fixture();
  await f.setOwner();
  await f.stop("work-1");
  expect((await f.next("work-1")).kind).toBe("forge");
  await expect(
    f.record({ id: "work-1", request: "req-all", scope: { all: true } }),
  ).rejects.toThrow(/waits on/);
  await f.record({ id: "work-1", request: "req-1", scope: { id: "work-1" } });
  await expect(
    f.record({ id: "work-1", request: "req-2", scope: { id: "work-1" } }),
  ).rejects.toThrow(/not replaced/);
  expect((await f.next("work-1")).kind).toBe("ask-owner");
  await expect(
    f.record({ id: "work-1", request: "req-3", scope: { id: "work-1" } }),
  ).rejects.toThrow(/not replaced/);
});

test("the runtime accepts a request only if it is pending and bound to exactly that step", () => {
  const store = new Map<string, { value: unknown; revision: number }>();
  const state = {
    get: (key: string) => store.get(key),
    put: (key: string, value: unknown) => {
      const row = { value, revision: (store.get(key)?.revision ?? 0) + 1 };
      store.set(key, row);
      return row;
    },
  } as never;
  let request = "";
  try {
    ownerApproval({
      state,
      op: "lane.resume",
      input: { id: "work-1" },
      deviceRoot: "/device",
      projectRoot: "/project",
      ask: "Resume lane work-1.",
      relay: { harness: "claude-code", id: "owner-1", pid: 1 },
    });
  } catch (error) {
    request = (error as ApprovalRequired).request!.id;
  }
  const bound = (op: string, input: unknown, id = request) =>
    requestBoundTo({
      state,
      request: id,
      op,
      input,
      deviceRoot: "/device",
      projectRoot: "/project",
    });
  expect(bound("lane.resume", { id: "work-1" })).toBe(true);
  expect(bound("lane.resume", { all: true })).toBe(false);
  expect(bound("lane.resume", { id: "work-2" })).toBe(false);
  expect(bound("memory.forget", { id: "work-1" })).toBe(false);
  expect(bound("lane.resume", { id: "work-1" }, "unknown")).toBe(false);
});
