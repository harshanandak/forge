import { expect, test } from "bun:test";
import { runCli } from "../../src/surface/cli.ts";
import { candidate, fakeCatalog } from "./fixtures/catalog.ts";
import { isLoginSession } from "../../src/contract/login-session.ts";
import { renderExample } from "../../src/contract/example.ts";
import type { McpCandidate } from "../../src/contract/mcp.ts";
const T = ["fct", `${"0".repeat(16)}.${"A".repeat(43)}`].join("_");
const G = ["ghp", "A".repeat(36)].join("_");
const L = "--pre-release";
const e = (): McpCandidate => candidate("sample.echo", { args: [] });
async function refuse(
  t: string,
  s: string,
  v: readonly string[],
  n: McpCandidate,
  m?: string,
  q?: boolean,
) {
  const w = m ?? `pass --value ${JSON.stringify(s)}`;
  const p = `Unexpected argument ${JSON.stringify(s)}; ${w}`;
  const o = `Invalid input for sample.echo:\n${p}`;
  for (const x of q ? ([[]] as const) : ([[], ["--text"]] as const)) {
    const c = fakeCatalog([n]);
    const r = await runCli(c, [...x, ...v]);
    if (r.envelope.ok) throw new Error("Expected refusal");
    expect(r.exitCode).toBe(6);
    expect(r.envelope.error.code).toBe("INPUT_INVALID");
    expect(r.envelope.error.retry).toBe("never");
    expect(c.calls).toHaveLength(0);
    expect(r.envelope.error.message).toBe(o);
    expect(r.envelope.error).toMatchObject({
      observed: {
        problems: [
          {
            pointer: "/arguments/0",
            keyword: "false",
            message: p,
            expected:
              "declared flags or --input JSON; no positional argument at this position",
            received: JSON.stringify(s),
          },
        ],
      },
    });
    if (s === "[redacted]") {
      expect(r.stdout).not.toContain(t);
      expect(JSON.stringify(r.envelope)).not.toContain(t);
    }
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
  for (const t of RED) await refuse(t, "[redacted]", ["sample.echo", t], e());
}, 30_000);
test("CLI retains ordinary unexpected words", async () => {
  for (const t of PLAIN) await refuse(t, t, ["sample.echo", t], e());
}, 30_000);
test("CLI redacts after a bare boolean switch", async () => {
  await refuse(T, "[redacted]", ["sample.echo", L, T], e());
}, 30_000);
test("CLI preserves a literal bare switch in diagnostics", async () => {
  await refuse(L, L, ["sample.echo", "--", L], e());
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
  await refuse(T, "[redacted]", ["sample.echo", T], n, "use --input JSON");
}, 30_000);
test("CLI redacts the reserved-input repair", async () => {
  const s = {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  };
  const n: McpCandidate = { ...e(), inputSchema: s };
  const d = {
    title: "",
    summary: "",
    examples: [{ input: { text: "[redacted]" } }],
  };
  const f = renderExample("sample.echo", d, s);
  const p = `Unexpected argument "[redacted]"; --text is reserved; use ${f}`;
  await refuse(
    T,
    "[redacted]",
    ["sample.echo", T],
    n,
    `--text is reserved; use ${f}`,
    true,
  );
  expect(p).toContain("[redacted]");
  expect(p).toContain("--input");
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
