import { expect, test } from "bun:test";
import { runCli } from "../../src/surface/cli.ts";
import { candidate, fakeCatalog } from "./fixtures/catalog.ts";
import { isLoginSession } from "../../src/contract/login-session.ts";
import type { McpCandidate } from "../../src/contract/mcp.ts";
const T = ["fct", `${"0".repeat(16)}.${"A".repeat(43)}`].join("_");
const G = ["ghp", "A".repeat(36)].join("_");
const L = "--pre-release";
const e = (): McpCandidate => candidate("sample.echo", { args: [] });
async function refuse(
  args: readonly string[],
  entry: McpCandidate,
  text = true,
) {
  const message =
    "Unexpected argument at this position. Use named flags or --input JSON.";
  for (const mode of text ? [[], ["--text"]] : [[]]) {
    const catalog = fakeCatalog([entry]);
    const reply = await runCli(catalog, [...mode, ...args]);
    if (reply.envelope.ok) throw new Error("Expected refusal");
    expect(reply.exitCode).toBe(6);
    expect(reply.envelope.error).toMatchObject({
      code: "INPUT_INVALID",
      retry: "never",
      message: `Invalid input for sample.echo:\n${message}`,
      observed: {
        problems: [
          {
            pointer: "/arguments/0",
            keyword: "false",
            message,
            expected:
              "declared flags or --input JSON; no positional argument at this position",
            received: "[redacted]",
          },
        ],
      },
    });
    expect(catalog.calls).toHaveLength(0);
  }
}
async function ok(a: readonly string[], n: McpCandidate, w: unknown) {
  const c = fakeCatalog([n]);
  const r = await runCli(c, a);
  if (!r.envelope.ok) throw new Error("Expected success");
  expect(r.exitCode).toBe(0);
  expect(r.envelope.result).toEqual(w);
  expect(c.calls).toHaveLength(1);
  expect(c.calls[0]).toMatchObject({ input: w });
}
const RED = [
  T,
  "fct_example",
  "FCT_example",
  "prefix_fct_example",
  G,
  ["github_pat", "example"].join("_"),
  ["sk", "example"].join("-"),
  ["sk", "ant", "example"].join("-"),
  ["sk", "proj", "example"].join("-"),
  ["xoxb", "example"].join("-"),
  "AKIAexample",
  "AIzaexample",
];
const PLAIN = [
  "hello",
  "credentials",
  "task-force",
  "true",
  "false",
  "sk-",
  "ghp_",
];
test("CLI redacts credential-shaped arguments", async () => {
  for (const t of RED) await refuse(["sample.echo", t], e());
}, 30_000);
test("CLI hides ordinary unexpected words", async () => {
  for (const t of PLAIN) await refuse(["sample.echo", t], e());
}, 30_000);
test("CLI redacts after a bare boolean switch", async () => {
  await refuse(["sample.echo", L, T], e());
}, 30_000);
test("CLI hides a literal bare switch in diagnostics", async () => {
  await refuse(["sample.echo", "--", L], e());
}, 30_000);
test("CLI preserves bare and explicit booleans", async () => {
  for (const [q, b] of [
    [[], true],
    [["true"], true],
    [["false"], false],
  ] as const)
    await ok(
      ["sample.echo", "--value", "hello", L, ...q],
      candidate("sample.echo"),
      { value: "hello", preRelease: b },
    );
}, 30_000);
test("CLI preserves declared positional credentials", async () => {
  await ok(["sample.echo", T], candidate("sample.echo"), { value: T });
}, 30_000);
test("CLI preserves named string credentials", async () => {
  await ok(["sample.echo", "--value", T], e(), { value: T });
}, 30_000);
test("CLI redacts without a unique suggestion", async () => {
  const n: McpCandidate = {
    ...e(),
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  };
  await refuse(["sample.echo", T], n);
}, 30_000);
test("CLI redacts the reserved-input repair", async () => {
  const s = {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  };
  const n: McpCandidate = { ...e(), inputSchema: s };
  await refuse(["sample.echo", T], n, false);
}, 30_000);
test("Login session validation retains its policy", () => {
  expect(isLoginSession("session-1")).toBe(true);
  expect(isLoginSession("ghp_example")).toBe(true);
  expect(isLoginSession("sk-example")).toBe(true);
  expect(isLoginSession("fct_example")).toBe(false);
  expect(isLoginSession("FCT_example")).toBe(false);
  expect(isLoginSession("prefix_fct_example")).toBe(false);
  expect(isLoginSession("bad session")).toBe(false);
  expect(isLoginSession("")).toBe(false);
  expect(isLoginSession(undefined)).toBe(false);
}, 30_000);

const sentinel = "ghp_synthetic_fixture";

for (const [name, args, message] of [
  [
    "unknown flag",
    [`--token ${sentinel}`],
    "Unknown argument. Use --help to see accepted arguments.",
  ],
  ["malformed --input", ["--input", sentinel], "Expected valid JSON."],
  [
    "malformed typed value",
    ["message", "--count", sentinel],
    "Expected valid JSON.",
  ],
] as const) {
  test(`CLI rejects ${name} without quoting input`, async () => {
    for (const mode of [[], ["--text"]]) {
      const catalog = fakeCatalog();
      const reply = await runCli(catalog, ["sample.echo", ...mode, ...args]);
      expect(reply.exitCode).toBe(6);
      expect(reply.envelope.ok).toBe(false);
      expect(reply.stdout.includes(sentinel)).toBe(false);
      expect(reply.envelope).toMatchObject({
        error: { code: "INPUT_INVALID", message },
      });
      expect(catalog.calls).toEqual([]);
    }
  }, 30_000);
}

test("CLI passes leading flags literally after the separator", async () => {
  const catalog = fakeCatalog();
  const value = `--token ${sentinel}`;
  for (const literal of [value, "--help"]) {
    const reply = await runCli(catalog, ["sample.echo", "--", literal]);
    expect(reply.exitCode).toBe(0);
    expect(catalog.calls.at(-1)?.input).toEqual({ value: literal });
  }
}, 30_000);

test("CLI rejects excess positionals without exposing any input", async () => {
  for (const mode of [[], ["--text"]]) {
    const catalog = fakeCatalog();
    const reply = await runCli(catalog, [
      "sample",
      "echo",
      ...mode,
      "AcceptedPrivateFixture",
      "/var/lib/PrivateFixture/report.log",
    ]);
    expect(reply.exitCode).toBe(6);
    expect(reply.envelope).toMatchObject({
      ok: false,
      error: { code: "INPUT_INVALID" },
    });
    for (const output of [reply.stdout, JSON.stringify(reply.envelope)])
      expect(output.includes("PrivateFixture")).toBe(false);
    expect(catalog.calls).toEqual([]);
  }
}, 30_000);
