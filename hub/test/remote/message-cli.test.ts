import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SECRET_PATTERNS } from "../../src/contract/errors.ts";
import { LIMITS, type InboxItemView } from "../../src/contract/mcp.ts";
import { adminFixture } from "./admin-fixtures.ts";
import { config, fail, key, ok, person, token } from "./fixtures.ts";

const timeout = 30_000;
const inbox = ["inbox", "--person", person.personId, "--project", "prj_demo"];
const send = [...inbox.slice(1), "--session", "ses_a", "--to", "per_other"];
const args = (...tail: string[]) => ["send", ...send, ...tail];
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
  return JSON.parse(text) as {
    result?: { created: boolean; items: unknown };
    error?: { pointer?: string };
  };
}

test(
  "L1-L2 and L10 inbox creates then reuses a visible session only through CLI methods",
  async () => {
    const f = await adminFixture();
    const actual = f.core.cliInbox.bind(f.core);
    f.core.cliInbox = (who, input) => {
      const result = actual(who, input);
      return result.ok
        ? ok({ ...result.value, items: [item, { ...item, itemId: "itm_b" }] })
        : result;
    };
    try {
      const first = await f.run(inbox);
      expect(first.status).toBe(0);
      expect(envelope(first.stdout)).toMatchObject({
        ok: true,
        op: "hub.cli-inbox",
        result: {
          created: true,
          sessionId: "ses_a",
          items: [{ itemId: "itm_a" }, { itemId: "itm_b" }],
        },
      });
      expect(f.core.calls.at(-1)).toEqual([
        "cliInbox",
        person,
        { projectId: "prj_demo" },
      ]);
      const second = await f.run([
        ...inbox,
        "--session",
        "ses_a",
        "--ack",
        "itm_a,itm_b",
        "--limit",
        "2",
      ]);
      expect(second.status).toBe(0);
      expect(envelope(second.stdout).result?.created).toBe(false);
      expect(f.core.calls.at(-1)).toEqual([
        "cliInbox",
        person,
        {
          projectId: "prj_demo",
          sessionId: "ses_a",
          limit: 2,
          ackItemIds: ["itm_a", "itm_b"],
        },
      ]);
      expect(f.core.calls.map(([name]) => name)).toEqual([
        "person",
        "cliInbox",
        "person",
        "cliInbox",
      ]);
    } finally {
      await f.close();
    }
  },
  timeout,
);

test(
  "L3-L4 and L10 send accepts one text source and no authority-changing call",
  async () => {
    const f = await adminFixture();
    try {
      const path = join(f.root, "message.txt");
      await writeFile(path, "file text");
      for (const [tail, text] of [
        [["--stdin"], "hello"],
        [["--file", path, "--target-session", "ses_b"], "file text"],
      ] as const) {
        const result = await f.run(args(...tail));
        expect(result.status).toBe(0);
        expect(envelope(result.stdout)).toMatchObject({
          ok: true,
          op: "hub.cli-send",
          result: { itemId: "itm_a" },
        });
        expect(f.core.calls.at(-1)).toEqual([
          "cliSend",
          person,
          {
            projectId: "prj_demo",
            sessionId: "ses_a",
            toPersonId: "per_other",
            text,
            ...(tail.length > 1 ? { targetSessionId: "ses_b" } : {}),
          },
        ]);
      }
      expect(f.reads).toBe(1);
      expect(f.core.calls.map(([name]) => name)).toEqual([
        "person",
        "cliSend",
        "person",
        "cliSend",
      ]);
    } finally {
      await f.close();
    }
  },
  timeout,
);

test(
  "L5 send declines positional, duplicate and missing text sources with fixed usage",
  async () => {
    const f = await adminFixture();
    try {
      let usage: string | undefined;
      for (const tail of [
        ["hello there"],
        ["--text", "hello"],
        [],
        ["--stdin", "--file", "m"],
      ]) {
        const result = await f.run(args(...tail));
        expect(result.status).toBe(2);
        const output = result.stdout + result.stderr;
        usage ??= output;
        expect(output).toBe(usage);
        expect(output.trim().split("\n")).toHaveLength(1);
      }
      expect(f.reads).toBe(0);
      expect(f.core.calls).toEqual([]);
    } finally {
      await f.close();
    }
  },
  timeout,
);

test(
  "L6 core refusal does not echo message input",
  async () => {
    const f = await adminFixture();
    f.stdin = token;
    f.core.cliSend = () => fail("SECRET_IN_TEXT");
    try {
      const result = await f.run(args("--stdin"));
      expect(result.status).toBe(1);
      expect(envelope(result.stdout)).toMatchObject({
        ok: false,
        error: { code: "SECRET_IN_TEXT" },
      });
      for (const pattern of SECRET_PATTERNS)
        expect(result.stdout + result.stderr).not.toMatch(pattern);
    } finally {
      await f.close();
    }
  },
  timeout,
);

test(
  "L7 disabled CLI prints one failure before input or core",
  async () => {
    const f = await adminFixture(config({ cli: { enabled: false } }));
    try {
      for (const command of [inbox, args("--stdin")]) {
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
      expect(f.reads).toBe(0);
      expect(f.core.calls).toEqual([]);
    } finally {
      await f.close();
    }
  },
  timeout,
);

test(
  "L8 and L12 malformed ids, empty/oversized text and inbox bounds stop before core",
  async () => {
    const f = await adminFixture();
    try {
      const path = join(f.root, "huge.txt");
      await writeFile(path, "x".repeat(LIMITS.bodyBytes + 1));
      f.stdin = "";
      for (const command of [
        ["inbox", "--person", "Per x", "--project", "prj_demo"],
        ["inbox", "--person", person.personId, "--project", "bad"],
        [...inbox, "--session", "x"],
        args("--file", path),
        args("--stdin"),
        [...inbox, "--limit", "51"],
        [
          ...inbox,
          "--ack",
          Array.from({ length: LIMITS.ackMax + 1 }, (_, n) => "itm_" + n).join(
            ",",
          ),
        ],
      ]) {
        const result = await f.run(command);
        expect(result.status).toBe(1);
        expect(envelope(result.stdout)).toMatchObject({
          ok: false,
          error: { code: "INPUT_INVALID" },
        });
        expect(typeof envelope(result.stdout).error?.pointer).toBe("string");
      }
      expect((await f.run([...inbox, "--limit", "abc"])).status).toBe(2);
      expect(f.core.calls).toEqual([]);
    } finally {
      await f.close();
    }
  },
  timeout,
);

test(
  "L9 unknown CLI person is refused before a message method",
  async () => {
    const f = await adminFixture(config({ people: [] }));
    try {
      const result = await f.run(inbox);
      expect(result.status).toBe(1);
      expect(envelope(result.stdout)).toMatchObject({
        error: { code: "PERSON_UNKNOWN" },
      });
      expect(f.core.calls).toEqual([["person", person.personId]]);
    } finally {
      await f.close();
    }
  },
  timeout,
);

test(
  "L11 output replaces every secret match and keeps stored text and acknowledgements intact",
  async () => {
    const f = await adminFixture();
    const items = [
      { ...item, text: token + " " + token },
      { ...item, itemId: "itm_b", from: { ...item.from, name: key } },
    ];
    const seen: unknown[] = [];
    f.core.cliInbox = (_person, input) => {
      seen.push(input);
      return ok({ sessionId: "ses_a", created: true, items, more: false });
    };
    try {
      const result = await f.run(inbox);
      expect(result.status).toBe(0);
      expect(envelope(result.stdout).result?.items).toMatchObject([
        { text: "[redacted] [redacted]" },
        { from: { name: "[redacted]" } },
      ]);
      expect(items[0]?.text).toBe(token + " " + token);
      expect(items[1]?.from.name).toBe(key);
      expect(seen).toEqual([{ projectId: "prj_demo" }]);
      for (const pattern of SECRET_PATTERNS)
        expect(result.stdout + result.stderr).not.toMatch(pattern);
    } finally {
      await f.close();
    }
  },
  timeout,
);
