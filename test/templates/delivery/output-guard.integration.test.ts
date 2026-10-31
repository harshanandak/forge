import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

setDefaultTimeout(30_000);
const script = resolve(
  import.meta.dirname,
  "../../../templates/delivery/harness/output-guard.mjs",
);
const node = Bun.which("node")!;
const root = mkdtempSync(join(tmpdir(), "forge-output-guard-"));
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP)$/i.test(name),
  ),
);
afterAll(() => rmSync(root, { recursive: true, force: true }));
let sequence = 0;
function invoke(harness: string, input: unknown, raw = false) {
  const path = join(root, `${sequence++}.json`);
  writeFileSync(path, raw ? String(input) : JSON.stringify(input));
  const fd = openSync(path, "r");
  try {
    return spawnSync(node, [script, harness], {
      cwd: root,
      env,
      stdio: [fd, "pipe", "pipe"],
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
  } finally {
    closeSync(fd);
    rmSync(path);
  }
}
const payload = (
  tool_response: unknown,
  tool_name = "Bash",
  hook_event_name = "PostToolUse",
) => ({ hook_event_name, tool_name, tool_response });
// Independent protocol oracle: compare the entire output, including stderr.
const warning =
  "A tool result may contain a credential. Do not repeat it; tell the user to rotate it.";
function expected(harness: string, failure = false) {
  return (
    JSON.stringify(
      harness === "codex"
        ? { systemMessage: warning }
        : {
            hookSpecificOutput: {
              hookEventName: failure ? "PostToolUseFailure" : "PostToolUse",
              additionalContext: warning,
            },
          },
    ) + "\n"
  );
}
const alphabet = "Ab7cD2eF9gH4jK6mN8pQ3rS5tU1vW0xYz";
const material = (length: number) =>
  alphabet.repeat(Math.ceil(length / alphabet.length)).slice(0, length);
const providers = [
  ["sk", "ant", material(100)].join("-"),
  ["sk", material(48)].join("-"),
  ["ghp", material(36)].join("_"),
  ["github", "pat", material(82)].join("_"),
  ["xoxb", "1234567890", "2345678901", material(24)].join("-"),
  ["AK", "IA", "ABCD2345EFGH6789"].join(""),
  ["AI", "za", material(35)].join(""),
];
const uri = (password: string) => `postgres://user:${password}@host/db`;
const positives: unknown[] = [];
for (const secret of providers) {
  for (const field of ["stdout", "stderr"])
    positives.push({
      stdout: "ordinary",
      stderr: "",
      interrupted: false,
      isImage: false,
      [field]: secret,
    });
}
positives.push({
  stdout: providers.join("\n"),
  stderr: providers[0],
  interrupted: true,
});
for (const secret of [
  "a4b9".repeat(10),
  Buffer.from(material(30)).toString("base64"),
  ["sk", material(9)].join("-"),
])
  for (const content of [
    `API_KEY=${secret}`,
    JSON.stringify({ TEST_TOKEN: secret }),
    `dbPassword: '${secret}'`,
  ])
    positives.push({ stdout: content, stderr: "" });
for (const password of [
  material(19),
  `${material(8)}%40${material(9)}%3A`,
  "credentials",
  "suppressed",
  "longcredentialsPhrase2026",
  "REDACTED",
  "[REDACTED]",
  "ordinaryREDACTED2026",
  "credential",
  "contain",
  "prefixcredentialSuffix",
])
  for (const response of [
    { stdout: uri(password), stderr: "" },
    { content: uri(password) },
  ])
    positives.push(response);
for (const key of ["primaryKey", "apiKey"])
  positives.push(
    { stdout: `${key}=${material(40)}`, stderr: "" },
    { nested: { [key]: material(40) } },
  );
positives.push(
  providers[2],
  { content: [{ type: "text", text: providers[2] }] },
  { stdout: providers[2], stderr: "", metadata: { count: 2 } },
  { stdout: providers[2], stderr: "", unexpected: "ordinary" },
  { nested: { SERVICE_SECRET: material(40) } },
);
for (const name of ["FOO", "x".repeat(100) + "_TOKEN", "bad-name-TOKEN"])
  positives.push({ stdout: `${name}=${providers[2]}`, stderr: "" });
const secret = "a4b9".repeat(8),
  other = "c7d2".repeat(8);
for (const content of [
  `SECRET_${secret}=${secret}`,
  `API_KEY=${secret}\nSECRET_${secret}=${other}`,
  `SECRET_${secret.slice(0, 8)}=${secret}`,
  `API_KEY=${secret}\nSECRET_${secret.slice(0, 8)}=${other}`,
])
  positives.push({ stdout: content, stderr: secret });
positives.push({
  stdout: `API_KEY=${providers[0]}\n`.repeat(1000),
  stderr: "",
});
positives.push(
  { stdout: `API_KEY=${providers[0]}`, stderr: "", interrupted: false },
  { stdout: `DATABASE_URL=${uri(providers[2]!)}`, stderr: "" },
  { stdout: `API_KEY=REPLACE_WITH_YOUR_OWN_API_KEY`, stderr: "" },
  { nested: { servicePassword: "a9c4".repeat(9) } },
);
for (const content of [
  `API_TOKEN=ordinary\n${["ghp", "Cd8Ef2".repeat(6)].join("_")}`,
  `API_TOKEN=ordinary; note=${["ghp", "Cd8Ef2".repeat(6)].join("_")}`,
  `${"A".repeat(130)}TOKEN=${["ghp", "Cd8Ef2".repeat(6)].join("_")}`,
])
  positives.push({ stdout: content, stderr: "" });

for (const harness of ["claude", "codex"])
  test(`${harness} property: every positive fixture emits only the fixed warning`, () => {
    for (const response of positives) {
      const result = invoke(harness, payload(response));
      const output = result.stdout + result.stderr;
      expect(result.status).toBe(0);
      expect(["", expected(harness)].includes(output)).toBe(true);
      // Valid, bounded positive fixtures must actually warn; empty is not success.
      expect(output === expected(harness)).toBe(true);
    }
  });

test("tool results are never altered or blocked for either protocol or tool shape", () => {
  for (const harness of ["claude", "codex"])
    for (const response of positives) {
      const original = JSON.stringify(response);
      const result = invoke(harness, payload(response, "mcp__example__read"));
      expect(result.status).toBe(0);
      expect(result.stdout + result.stderr === expected(harness)).toBe(true);
      expect(JSON.stringify(response)).toBe(original);
    }
});

test("Claude failure paths retain the fixed warning even for warning-word passwords", () => {
  for (const password of [
    providers[0]!,
    "credentials",
    "longcredentialsPhrase2026",
    "credential",
    "REDACTED",
  ])
    for (const input of [
      { hook_event_name: "PostToolUseFailure", error: uri(password) },
      {
        hook_event_name: "PostToolUseFailure",
        tool_response: { content: uri(password) },
        error: "ordinary",
      },
    ]) {
      const result = invoke("claude", input);
      expect(result.status).toBe(0);
      expect(result.stdout + result.stderr === expected("claude", true)).toBe(
        true,
      );
    }
});

test("round-1 and round-2 negative cases remain silent", () => {
  const uuid = ["014df517", "39d1", "4453", "b7b3", "9930c563627c"].join("-");
  const negatives: unknown[] = [
    {
      stdout: [
        "commit " + "a4b9".repeat(10),
        uuid,
        JSON.stringify({
          integrity: `sha512-${Buffer.from(material(64)).toString("base64")}`,
          sha: "abcdef1234567890".repeat(4),
        }),
        "bun test v1.4.4\n123 pass\n0 fail\nChecked 235 files\nOn branch feature\nnothing to commit, working tree clean",
        "API_KEY=<redacted>\nTOKEN=${TOKEN}\nSECRET=[REDACTED]\nhttps://user@example.test/path",
        "sk-short ghp_short AKIAshort AIzashort xoxb-short",
      ].join("\n"),
      stderr: "",
    },
    { stdout: `API_KEY: documentation\nsha=${"a4b9".repeat(10)}`, stderr: "" },
    {
      stdout: `note=${Buffer.from(material(30)).toString("base64")}`,
      stderr: "",
    },
  ];
  for (const key of ["primaryKey", "apiKey"])
    for (const value of [uuid, uuid.toUpperCase()])
      negatives.push(
        { stdout: `${key}=${value}`, stderr: "" },
        { nested: { [key]: value } },
      );
  for (const harness of ["claude", "codex"])
    for (const response of negatives) {
      const result = invoke(harness, payload(response));
      expect(result.status).toBe(0);
      expect(result.stdout + result.stderr).toBe("");
    }
});

test("depth, malformed, oversized and unsupported input fail open silently", () => {
  let deep: unknown = providers[0];
  for (let i = 0; i < 70; i++) deep = { child: deep };
  for (const harness of ["claude", "codex"])
    for (const input of [
      `{${providers[0]}`,
      JSON.stringify(payload("z".repeat(1_048_577))),
      "null",
      "[]",
      "{}",
      JSON.stringify(payload("safe", "Bash", "PreToolUse")),
      JSON.stringify(payload(deep)),
    ]) {
      const result = invoke(harness, input, true);
      expect(result.status).toBe(0);
      expect(result.stdout + result.stderr).toBe("");
    }
});

test("an open stdin pipe is bounded without waiting for EOF", async () => {
  const started = performance.now();
  const child = spawn(node, [script, "codex"], {
    cwd: root,
    env,
    windowsHide: true,
  });
  let output = "",
    error = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    error += chunk.toString();
  });
  child.stdin.on("error", () => {});
  child.stdin.write("{");
  const status = await new Promise<number | null>((done, reject) => {
    child.on("error", reject);
    child.on("exit", done);
  });
  expect(status).toBe(0);
  expect(output + error).toBe("");
  expect(performance.now() - started < 3000).toBe(true);
}, 5000);
