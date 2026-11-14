import { expect, test } from "bun:test";
import { parseStateInput } from "../../cloud/src/state-input.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import { exitCode, failure } from "../../src/surface/result.ts";
import { commit, read, readVersion } from "./state-input.fixture.ts";

const bodyLimit = 512 * 1024;
const encode = (value: unknown): string => JSON.stringify(value);
const padded = (bytes: number): string => {
  const text = encode(read);
  return text + " ".repeat(bytes - new TextEncoder().encode(text).length);
};
const many = (count: number, entry: unknown): unknown[] =>
  Array.from({ length: count }, (_, i) => ({
    ...(entry as object),
    key: `key:${i}`,
  }));
const rows: readonly [string, unknown, boolean][] = [
  ["get", read, true],
  ["pinned get", { ...read, readVersion }, true],
  [
    "range",
    {
      ...read,
      query: {
        kind: "range",
        from: "a",
        to: "z",
        limit: 1000,
        descending: true,
      },
    },
    true,
  ],
  ["count", { ...read, query: { kind: "count", prefix: "" } }, true],
  ["max", { ...read, query: { kind: "max", prefix: "record:" } }, true],
  [
    "history",
    {
      ...read,
      query: { kind: "history", key: "record:1", limit: 1000, before: 2 },
    },
    true,
  ],
  ["commit", commit, true],
  [
    "fenced commit",
    { ...commit, fence: { subject: "record:1", generation: 1 } },
    true,
  ],
  [
    "entries at limit",
    { ...commit, entries: many(256, commit.entries[0]) },
    true,
  ],
  [
    "reads at limit",
    { ...commit, readSet: many(256, commit.readSet[0]) },
    true,
  ],
  ["exact bytes", padded(bodyLimit), true],
  ["exact values", { ...commit, input: Array(4975).fill(null) }, true],
  [
    "exact depth",
    {
      ...commit,
      input: JSON.parse("[".repeat(31) + "0" + "]".repeat(31)) as unknown,
    },
    true,
  ],
  ...["", "{", "null", "[]", "true", "4", '"text"'].map(
    (text): [string, unknown, boolean] => ["malformed/non-object", text, false],
  ),
  ...[undefined, 0, 2, "1"].map((version): [string, unknown, boolean] => [
    "version",
    { ...read, version },
    false,
  ]),
  ...["actor", "clock", "sql", "table", "path", "project"].map(
    (name): [string, unknown, boolean] => [
      "extra top-level",
      { ...read, [name]: "untrusted" },
      false,
    ],
  ),
  [
    "extra query",
    { ...read, query: { ...read.query, actor: "untrusted" } },
    false,
  ],
  [
    "extra version",
    { ...commit, readVersion: { ...readVersion, clock: 1 } },
    false,
  ],
  [
    "extra entry",
    { ...commit, entries: [{ ...commit.entries[0], sql: "untrusted" }] },
    false,
  ],
  [
    "extra read",
    { ...commit, readSet: [{ ...commit.readSet[0], table: "untrusted" }] },
    false,
  ],
  [
    "extra fence",
    {
      ...commit,
      fence: { subject: "record:1", generation: 1, actor: "untrusted" },
    },
    false,
  ],
  [
    "repeated top key",
    encode(read).replace('"version":1', '"version":1,"version":1'),
    false,
  ],
  [
    "escaped duplicate",
    encode(read).replace('"version":1', '"version":1,"\\u0076ersion":1'),
    false,
  ],
  [
    "duplicate data",
    encode({ ...commit, input: "REPLACE" }).replace(
      '"REPLACE"',
      '{"a":1,"a":2}',
    ),
    false,
  ],
  [
    "nested duplicate",
    encode({ ...commit, input: "REPLACE" }).replace(
      '"REPLACE"',
      '[{"a":1,"a":2}]',
    ),
    false,
  ],
  ["sibling keys", { ...commit, input: [{ a: 1 }, { a: 2 }] }, true],
  ["key-like string", { ...commit, input: '{"a":1,"a":2}' }, true],
  ["over bytes", padded(bodyLimit + 1), false],
  ["UTF-8 bytes", { ...commit, input: "é".repeat(bodyLimit / 2) }, false],
  ["over values", { ...commit, input: Array(5000).fill(null) }, false],
  [
    "over depth",
    {
      ...commit,
      input: JSON.parse("[".repeat(32) + "0" + "]".repeat(32)) as unknown,
    },
    false,
  ],
  ["over entries", { ...commit, entries: many(257, commit.entries[0]) }, false],
  ["over reads", { ...commit, readSet: many(257, commit.readSet[0]) }, false],
  [
    "missing expectation",
    { ...commit, entries: [{ key: "record:1", value: null }] },
    false,
  ],
  ["missing read set", { ...commit, readSet: undefined }, false],
  ["missing read version", { ...commit, readVersion: undefined }, false],
  [
    "missing dependency version",
    {
      ...commit,
      readSet: [{ namespace: read.namespace, key: "key", expectRevision: 0 }],
    },
    false,
  ],
  ["missing input", { ...commit, input: undefined }, false],
  ["empty entries", { ...commit, entries: [] }, false],
  ["unknown kind", { ...read, kind: "write" }, false],
  ["unknown query", { ...read, query: { kind: "list" } }, false],
  ...[0, -1, 1001, 1.5].flatMap((limit): [string, unknown, boolean][] => [
    ["range limit", { ...read, query: { kind: "range", limit } }, false],
    [
      "history limit",
      { ...read, query: { kind: "history", key: "key", limit } },
      false,
    ],
  ]),
  ...[0, -1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1].map(
    (before): [string, unknown, boolean] => [
      "cursor",
      { ...read, query: { kind: "history", key: "key", limit: 1, before } },
      false,
    ],
  ),
  ...["", "a".repeat(501), 1].map((key): [string, unknown, boolean] => [
    "key",
    { ...read, query: { kind: "get", key } },
    false,
  ]),
  ...["", "a".repeat(133), 1].map((namespace): [string, unknown, boolean] => [
    "namespace",
    { ...read, namespace },
    false,
  ]),
  ...["", "a".repeat(129), 1].map((requestId): [string, unknown, boolean] => [
    "request id",
    { ...commit, requestId },
    false,
  ]),
  ...[-1, 1.5, "0", Number.MAX_SAFE_INTEGER + 1].map(
    (expectRevision): [string, unknown, boolean] => [
      "revision",
      { ...commit, entries: [{ ...commit.entries[0], expectRevision }] },
      false,
    ],
  ),
];

for (const [name, input, accepted] of rows) {
  test(`state input: ${name}`, () => {
    const text = typeof input === "string" ? input : encode(input);
    const original = encode(input);
    for (const body of [text, new TextEncoder().encode(text)]) {
      const before = typeof body === "string" ? body : body.slice();
      let value: ReturnType<typeof parseStateInput> | undefined;
      let status = "OK",
        exit = 0;
      try {
        value = parseStateInput(body);
      } catch (error) {
        expect(error).toBeInstanceOf(ForgeFailure);
        const refusal = failure((error as ForgeFailure).error.code, "refused");
        expect(refusal.error.code).toBe("INPUT_INVALID");
        status = refusal.status;
        exit = exitCode(refusal);
      }
      expect(status).toBe(accepted ? "OK" : "FAIL");
      expect(exit).toBe(accepted ? 0 : 6);
      expect(value).toEqual(
        accepted ? (JSON.parse(text) as unknown) : undefined,
      );
      expect(body).toEqual(before);
      expect(encode(input)).toBe(original);
    }
  }, 1000);
}
