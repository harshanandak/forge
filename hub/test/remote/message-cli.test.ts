import { expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { LIMITS, type InboxItemView } from "../../src/contract/mcp.ts";
import { adminTest } from "./admin-fixtures.ts";
import { config, fail, json, key, ok, person, token } from "./fixtures.ts";

const timeout = 30_000;
const check = adminTest(timeout);
const projectId = "prj_demo";
const sessionId = "ses_a";
const toPersonId = "per_other";
const inbox = ["inbox", "--person", person.personId, "--project", projectId];
const send = (...tail: string[]) => [
  "send",
  ...inbox.slice(1),
  "--session",
  sessionId,
  "--to",
  toPersonId,
  ...tail,
];
const item = {
  itemId: "itm_a",
  audience: "dm",
  kind: "cli_message",
  from: { kind: "cli", name: "CLI" },
  trust: "cli",
  text: "Hi",
  receivedAt: "2026-01-01T00:00:00Z",
  redelivered: false,
} satisfies InboxItemView;

function envelope(text: string) {
  expect(text.trim().split("\n")).toHaveLength(1);
  return json<{
    result?: { created: boolean; items: unknown };
    error?: { pointer?: string };
  }>(text);
}

check("L1-L2 and L10 CLI inbox creates and reuses a session", async (f) => {
  const actual = f.core.cliInbox;
  f.core.cliInbox = (who, input) => {
    const result = actual(who, input);
    return result.ok
      ? ok({ ...result.value, items: [item, { ...item, itemId: "itm_b" }] })
      : result;
  };
  const first = await f.run(inbox);
  expect(first.status).toBe(0);
  expect(envelope(first.stdout)).toMatchObject({
    ok: true,
    op: "hub.cli-inbox",
    result: {
      created: true,
      sessionId,
      items: [{ itemId: "itm_a" }, { itemId: "itm_b" }],
    },
  });
  const second = await f.run([
    ...inbox,
    "--session",
    sessionId,
    "--ack",
    "itm_a,itm_b",
    "--limit",
    "2",
  ]);
  expect(second.status).toBe(0);
  expect(envelope(second.stdout).result?.created).toBe(false);
  expect(f.core.calls).toEqual([
    ["person", person.personId],
    ["cliInbox", person, { projectId }],
    ["person", person.personId],
    [
      "cliInbox",
      person,
      { projectId, sessionId, limit: 2, ackItemIds: ["itm_a", "itm_b"] },
    ],
  ]);
});

check("L3-L4 and L10 CLI send accepts one text source", async (f) => {
  const path = f.path("message.txt");
  await writeFile(path, "file text");
  for (const [args, text, target] of [
    [send("--stdin"), "hello"],
    [send("--file", path, "--target-session", "ses_b"), "file text", "ses_b"],
  ] as const) {
    const result = await f.run(args);
    expect(result.status).toBe(0);
    expect(envelope(result.stdout)).toMatchObject({
      ok: true,
      op: "hub.cli-send",
      result: { itemId: "itm_a" },
    });
    const input = {
      projectId,
      sessionId,
      toPersonId,
      text,
      ...(target ? { targetSessionId: target } : {}),
    };
    expect(f.core.calls.at(-1)).toEqual(["cliSend", person, input]);
  }
  expect(f.state.reads).toBe(1);
  expect(f.core.calls.map(([name]) => name)).toEqual([
    "person",
    "cliSend",
    "person",
    "cliSend",
  ]);
});

check(
  "L5 positional, missing or duplicate source gives fixed usage",
  async (f) => {
    let usage: string | undefined;
    for (const fields of [
      ["hello there"],
      ["--text", "hello"],
      [],
      ["--stdin", "--file", "m"],
    ]) {
      const result = await f.run(send(...fields));
      expect(result.status).toBe(2);
      const output = result.stdout + result.stderr;
      usage ??= output;
      expect(output).toBe(usage);
      expect(output.trim().split("\n")).toHaveLength(1);
    }
    expect(f.state.reads).toBe(0);
    expect(f.core.calls).toEqual([]);
  },
);

check("L6 core refusal never echoes input", async (f) => {
  f.state.stdin = token;
  f.core.cliSend = () => Promise.resolve(fail("SECRET_IN_TEXT"));
  const result = await f.run(send("--stdin"));
  expect(result.status).toBe(1);
  expect(envelope(result.stdout)).toMatchObject({
    ok: false,
    error: { code: "SECRET_IN_TEXT" },
  });
});

check(
  "L7 disabled CLI never reads input or core",
  async (f) => {
    for (const command of [inbox, send("--stdin")]) {
      const result = await f.run(command);
      expect(result.status).toBe(1);
      expect(envelope(result.stdout)).toMatchObject({
        ok: false,
        op: "hub.cli-" + command[0],
        status: "FAIL",
        error: { code: "BLOCK_DISABLED", retry: "never" },
        warnings: [],
      });
    }
    expect(f.state.reads).toBe(0);
    expect(f.core.calls).toEqual([]);
  },
  config({ cli: { enabled: false } }),
);

check("L8 and L12 bad ids, bounds and text do not reach core", async (f) => {
  const path = f.path("huge.txt");
  await writeFile(path, "x".repeat(LIMITS.bodyBytes + 1));
  f.state.stdin = "";
  const acks = Array.from(
    { length: LIMITS.ackMax + 1 },
    (_, i) => "itm_" + i,
  ).join(",");
  for (const command of [
    ["inbox", "--person", "Per x", "--project", projectId],
    ["inbox", "--person", person.personId, "--project", "bad"],
    [...inbox, "--session", "x"],
    send("--file", path),
    send("--stdin"),
    [...inbox, "--limit", "51"],
    [...inbox, "--ack", acks],
  ]) {
    const result = await f.run(command);
    expect(result.status).toBe(1);
    const parsed = envelope(result.stdout);
    expect(parsed).toMatchObject({
      ok: false,
      error: { code: "INPUT_INVALID" },
    });
    expect(typeof parsed.error?.pointer).toBe("string");
  }
  expect((await f.run([...inbox, "--limit", "abc"])).status).toBe(2);
  expect(f.core.calls).toEqual([]);
});

check(
  "L9 unknown person stops before message lookup",
  async (f) => {
    const result = await f.run(inbox);
    expect(result.status).toBe(1);
    expect(envelope(result.stdout)).toMatchObject({
      error: { code: "PERSON_UNKNOWN" },
    });
    expect(f.core.calls).toEqual([["person", person.personId]]);
  },
  config({ people: [] }),
);

check(
  "L11 redacts all occurrences without changing items or acks",
  async (f) => {
    const original = token + " " + token;
    const pem = [
      "-----" + "BEGIN PRIVATE KEY-----",
      "synthetic-key-material",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const items = [
      { ...item, text: original },
      { ...item, itemId: "itm_b", from: { ...item.from, name: key } },
      { ...item, itemId: "itm_c", text: pem },
    ];
    const seen: unknown[] = [];
    f.core.cliInbox = (_person, input) => {
      seen.push(input);
      return ok({ sessionId, created: true, items, more: false });
    };
    const result = await f.run(inbox);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(envelope(result.stdout).result?.items).toMatchObject([
      { text: "[redacted] [redacted]" },
      { from: { name: "[redacted]" } },
      { text: "[redacted]" },
    ]);
    expect(items[0]?.text).toBe(original);
    expect(items[1]?.from.name).toBe(key);
    expect(items[2]?.text).toBe(pem);
    expect(seen).toEqual([{ projectId }]);
  },
);
