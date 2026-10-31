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
    const result = spawnSync(node, [script, harness], {
      cwd: root,
      env,
      stdio: [fd, "pipe", "pipe"],
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      /* Absent output is an assertion result. */
    }
    return {
      ...result,
      json,
      text: `${result.stdout}${result.stderr}${result.status}`,
    };
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
const alphabet = "Ab7cD2eF9gH4jK6mN8pQ3rS5tU1vW0xYz";
const material = (length: number) =>
  alphabet.repeat(Math.ceil(length / alphabet.length)).slice(0, length);
const examples: [string, () => string][] = [
  ["anthropic", () => ["sk", "ant", material(100)].join("-")],
  ["openai", () => ["sk", material(48)].join("-")],
  ["github", () => ["ghp", material(36)].join("_")],
  ["github-fine", () => ["github", "pat", material(82)].join("_")],
  ["slack", () => ["xoxb", "1234567890", "2345678901", material(24)].join("-")],
  ["aws", () => ["AK", "IA", "ABCD2345EFGH6789"].join("")],
  ["google", () => ["AI", "za", material(35)].join("")],
];
function noFragments(text: string, secret: string) {
  expect(
    Array.from({ length: Math.max(0, secret.length - 7) }, (_, i) =>
      text.includes(secret.slice(i, i + 8)),
    ).some(Boolean),
  ).toBe(false);
}
function hook(output: Record<string, unknown>) {
  return (output.hookSpecificOutput ?? {}) as Record<string, unknown>;
}

test("both harnesses name the credential variable with recovery instructions", () => {
  const secret = examples[0]![1]();
  for (const harness of ["claude", "codex"]) {
    const result = invoke(
      harness,
      payload({ stdout: `API_KEY=${secret}`, stderr: "", interrupted: false }),
    );
    if (harness === "codex")
      expect(result.json.decision === "block").toBe(true);
    const warning =
      harness === "codex"
        ? result.json.reason
        : hook(result.json).additionalContext;
    expect(result.status === 0 && result.stderr === "").toBe(true);
    expect(
      typeof warning === "string" &&
        /API_KEY/.test(warning) &&
        /rotate/i.test(warning) &&
        /rerun/i.test(warning),
    ).toBe(true);
    noFragments(result.text, secret);
  }
});

for (const [family, make] of examples)
  for (const harness of ["claude", "codex"]) {
    test(`${harness} detects ${family} in stdout and stderr without fragments`, () => {
      const secret = make();
      for (const field of ["stdout", "stderr"]) {
        const response = {
          stdout: "ordinary",
          stderr: "",
          interrupted: false,
          isImage: false,
          [field]: secret,
        };
        const result = invoke(harness, payload(response));
        expect(result.status === 0 && result.stderr === "").toBe(true);
        if (harness === "codex")
          expect(result.json.decision === "block").toBe(true);
        else {
          const output = hook(result.json);
          const updated = output.updatedToolOutput as
            Record<string, unknown> | undefined;
          expect(output.hookEventName === "PostToolUse").toBe(true);
          expect(updated?.[field] === "[REDACTED]").toBe(true);
          expect(
            updated?.interrupted === false && updated?.isImage === false,
          ).toBe(true);
          expect(
            typeof output.additionalContext === "string" &&
              /rotate/i.test(output.additionalContext),
          ).toBe(true);
        }
        const warning =
          harness === "codex"
            ? result.json.reason
            : hook(result.json).additionalContext;
        expect(
          typeof warning === "string" &&
            warning.includes(
              `unknown key (${family === "github-fine" ? "github" : family})`,
            ),
        ).toBe(true);
        noFragments(result.text, secret);
      }
    });
  }

test("multiple credentials redact every occurrence and preserve the response shape", () => {
  const secrets = examples.map(([, make]) => make());
  const result = invoke(
    "claude",
    payload({
      stdout: secrets.join("\n"),
      stderr: secrets[0],
      interrupted: true,
    }),
  );
  const updated = hook(result.json).updatedToolOutput as
    Record<string, unknown> | undefined;
  expect(
    updated?.stdout === secrets.map(() => "[REDACTED]").join("\n") &&
      updated?.stderr === "[REDACTED]" &&
      updated?.interrupted === true,
  ).toBe(true);
  for (const secret of secrets) noFragments(result.text, secret);
});

test("credential-labelled hex, base64 and short prefixed values require the same assignment", () => {
  const secrets = [
    "a4b9".repeat(10),
    Buffer.from(material(30)).toString("base64"),
    ["sk", material(9)].join("-"),
  ];
  for (const secret of secrets)
    for (const content of [
      `API_KEY=${secret}`,
      JSON.stringify({ TEST_TOKEN: secret }),
      `dbPassword: '${secret}'`,
    ]) {
      const result = invoke("codex", payload({ stdout: content, stderr: "" }));
      expect(result.json.decision === "block").toBe(true);
      noFragments(result.text, secret);
    }
  for (const content of [
    `API_KEY: documentation\nsha=${secrets[0]}`,
    `note=${secrets[1]}`,
  ]) {
    const result = invoke("codex", payload({ stdout: content, stderr: "" }));
    expect(
      result.stdout === "" && result.stderr === "" && result.status === 0,
    ).toBe(true);
  }
});

test("URI passwords including percent escapes redact the whole userinfo credential", () => {
  for (const password of [material(19), `${material(8)}%40${material(9)}%3A`]) {
    const result = invoke(
      "claude",
      payload({
        stdout: `postgresql://dbuser:${password}@db.example:5432/app`,
        stderr: "",
      }),
    );
    expect(
      (
        hook(result.json).updatedToolOutput as
          Record<string, unknown> | undefined
      )?.stdout === "postgresql://dbuser:[REDACTED]@db.example:5432/app",
    ).toBe(true);
    expect(
      String(hook(result.json).additionalContext).includes(
        "unknown key (uri-password)",
      ),
    ).toBe(true);
    noFragments(result.text, password);
  }
});

for (const harness of ["claude", "codex"])
  for (const [word, parts] of [
    ["warning", ["cre", "dentials"]],
    ["recovery", ["sup", "pressed"]],
  ] as const)
    test(`${harness} omits URI password fragments matching ${word} text`, () => {
      const secret = parts.join("");
      for (const response of [
        { stdout: `postgres://user:${secret}@host/db`, stderr: "" },
        { content: `postgres://user:${secret}@host/db` },
      ]) {
        const result = invoke(harness, payload(response));
        expect(result.status === 0 && result.stderr === "").toBe(true);
        expect(
          harness === "codex"
            ? result.json.decision === "block"
            : typeof hook(result.json).additionalContext === "string",
        ).toBe(true);
        noFragments(result.text, secret);
      }
    });

test("Claude replacement collisions clear the warning and preserve existing replacement output", () => {
  const secret = ["RE", "DACTED"].join("");
  const result = invoke(
    "claude",
    payload({ stdout: `postgres://user:${secret}@host/db`, stderr: "" }),
  );
  expect(
    result.status === 0 &&
      result.stderr === "" &&
      hook(result.json).additionalContext === "" &&
      (
        hook(result.json).updatedToolOutput as
          Record<string, unknown> | undefined
      )?.stdout
        ?.toString()
        .includes(secret) === true,
  ).toBe(true);
});

for (const harness of ["claude", "codex"])
  test(`${harness} accepts UUID credential keys and still blocks generic primaryKey values`, () => {
    const uuid = ["014df517", "39d1", "4453", "b7b3", "9930c563627c"].join("-");
    for (const value of [uuid, uuid.toUpperCase()])
      for (const key of ["primaryKey", "apiKey"])
        for (const response of [
          { stdout: `${key}=${value}`, stderr: "" },
          { nested: { [key]: value } },
        ]) {
          const result = invoke(harness, payload(response));
          expect(
            result.status === 0 && result.stdout === "" && result.stderr === "",
          ).toBe(true);
        }
    const secret = material(40);
    for (const response of [
      { stdout: `primaryKey=${secret}`, stderr: "" },
      { nested: { primaryKey: secret } },
    ]) {
      const result = invoke(harness, payload(response));
      expect(
        harness === "codex"
          ? result.json.decision === "block"
          : typeof hook(result.json).additionalContext === "string",
      ).toBe(true);
      noFragments(result.text, secret);
    }
  });

test("unknown Claude shapes detect nested values but emit only a warning", () => {
  const secret = examples[2]![1]();
  for (const response of [
    secret,
    { content: [{ type: "text", text: secret }] },
    { stdout: secret, stderr: "", metadata: { count: 2 } },
    { stdout: secret, stderr: "", unexpected: "ordinary" },
  ]) {
    const result = invoke("claude", payload(response));
    expect(hook(result.json).updatedToolOutput === undefined).toBe(true);
    expect(
      /not redacted/i.test(String(hook(result.json).additionalContext)),
    ).toBe(true);
    noFragments(result.text, secret);
  }
});

test("structured response credential keys retain adjacent identifier context", () => {
  const secret = material(40);
  const result = invoke(
    "codex",
    payload({ nested: { SERVICE_SECRET: secret } }, "other"),
  );
  expect(
    result.json.decision === "block" &&
      String(result.json.reason).includes("SERVICE_SECRET"),
  ).toBe(true);
  noFragments(result.text, secret);
});

test("provider and URI diagnostics accept ordinary short adjacent identifiers", () => {
  const secret = examples[2]![1]();
  for (const [name, content] of [
    ["FOO", `FOO=${secret}`],
    ["DATABASE_URL", `DATABASE_URL=postgres://user:${secret}@host/db`],
  ] as const) {
    const result = invoke("codex", payload({ stdout: content, stderr: "" }));
    expect(
      result.json.decision === "block" &&
        String(result.json.reason).includes(name),
    ).toBe(true);
    noFragments(result.text, secret);
  }
});

test("Claude failure output gets a value-free warning without replacement", () => {
  const secret = examples[0]![1]();
  const result = invoke("claude", {
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    error: `failed: ${secret}`,
  });
  expect(result.status === 0 && result.stderr === "").toBe(true);
  expect(
    hook(result.json).hookEventName === "PostToolUseFailure" &&
      hook(result.json).updatedToolOutput === undefined &&
      /rotate/i.test(String(hook(result.json).additionalContext)),
  ).toBe(true);
  noFragments(result.text, secret);
});

test("depth limit fails open without propagating an exception or credential", () => {
  const secret = examples[1]![1]();
  let response: unknown = secret;
  for (let i = 0; i < 70; i++) response = { child: response };
  const result = invoke("claude", payload(response));
  expect(
    result.status === 0 &&
      result.stderr === "" &&
      /not scanned/i.test(String(result.json.systemMessage)),
  ).toBe(true);
  noFragments(result.text, secret);
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
  expect(
    status === 0 &&
      error === "" &&
      /not scanned.*timeout/i.test(output) &&
      performance.now() - started < 3000,
  ).toBe(true);
}, 5000);

test("unsafe identifier labels use only the provider family", () => {
  const secret = examples[2]![1]();
  for (const name of ["x".repeat(100) + "_TOKEN", "bad-name-TOKEN"]) {
    const result = invoke(
      "codex",
      payload({ stdout: `${name}=${secret}`, stderr: "" }),
    );
    expect(String(result.json.reason).includes("unknown key (github)")).toBe(
      true,
    );
    expect(String(result.json.reason).includes(name)).toBe(false);
    noFragments(result.text, secret);
  }
});

test("credential material inside labels and other fields never reaches hook output", () => {
  const secret = "a4b9".repeat(8),
    other = "c7d2".repeat(8);
  for (const harness of ["claude", "codex"])
    for (const content of [
      `SECRET_${secret}=${secret}`,
      `API_KEY=${secret}\nSECRET_${secret}=${other}`,
      `SECRET_${secret.slice(0, 8)}=${secret}`,
      `API_KEY=${secret}\nSECRET_${secret.slice(0, 8)}=${other}`,
    ]) {
      const result = invoke(
        harness,
        payload({ stdout: content, stderr: secret }),
      );
      expect(
        harness === "codex"
          ? result.json.decision === "block"
          : hook(result.json).updatedToolOutput !== undefined,
      ).toBe(true);
      noFragments(result.text, secret);
      noFragments(result.text, other);
    }
});

test("safe corpus leaves hashes, UUIDs, integrity data and ordinary repository output alone", () => {
  const corpus = [
    "commit " + "a4b9".repeat(10),
    "014df517-39d1-4453-b7b3-9930c563627c",
    JSON.stringify({
      integrity: `sha512-${Buffer.from(material(64)).toString("base64")}`,
      sha: "abcdef1234567890".repeat(4),
    }),
    "bun test v1.4.4\n123 pass\n0 fail\nChecked 235 files\nOn branch feature\nnothing to commit, working tree clean",
    "API_KEY=<redacted>\nTOKEN=${TOKEN}\nSECRET=[REDACTED]\nhttps://user@example.test/path",
    "sk-short ghp_short AKIAshort AIzashort xoxb-short",
  ].join("\n");
  for (const harness of ["claude", "codex"]) {
    const result = invoke(harness, payload({ stdout: corpus, stderr: "" }));
    expect(
      result.status === 0 && result.stdout === "" && result.stderr === "",
    ).toBe(true);
  }
});

test("malformed, oversized and unsupported input fail open with a value-free note", () => {
  const secret = examples[0]![1]();
  for (const input of [
    `{${secret}`,
    `{"tool_response":"${"z".repeat(1_048_577)}${secret}"}`,
    "null",
    "[]",
    "{}",
    JSON.stringify(payload("safe", "Bash", "PreToolUse")),
  ]) {
    const result = invoke("codex", input, true);
    expect(result.status === 0).toBe(true);
    expect(result.stderr === "").toBe(true);
    expect(
      /not scanned|unsupported/i.test(String(result.json.systemMessage)),
    ).toBe(true);
    noFragments(result.text, secret);
  }
});
