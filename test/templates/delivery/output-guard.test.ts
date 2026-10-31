import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

setDefaultTimeout(30_000);
const path = resolve(
  import.meta.dirname,
  "../../../templates/delivery/harness/output-scanner.mjs",
);
type Finding = { start: number; end: number; name: string; family: string };
type Result = { findings: Finding[]; redacted: string };
async function scanner() {
  expect(existsSync(path)).toBe(true);
  if (!existsSync(path)) return undefined;
  return (
    (await import(pathToFileURL(path).href)) as {
      scan: (text: string, key?: string, deadline?: number) => Result;
    }
  ).scan;
}
function hidden(result: Result, secret: string) {
  const report = JSON.stringify(result);
  expect(
    Array.from({ length: secret.length - 7 }, (_, i) =>
      report.includes(secret.slice(i, i + 8)),
    ).some(Boolean),
  ).toBe(false);
}

test("scanner redacts overlapping provider and generic findings once with value-free metadata", async () => {
  const scan = await scanner();
  if (!scan) return;
  const secret = ["ghp", "Ab7Cd9".repeat(6)].join("_");
  const result = scan(`API_TOKEN=${secret}`);
  expect(
    result.findings.length === 1 && result.redacted === "API_TOKEN=[REDACTED]",
  ).toBe(true);
  expect(result.findings[0]?.name === "API_TOKEN").toBe(true);
  hidden(result, secret);
});

test("scanner requires provider-specific lengths and character sets", async () => {
  const scan = await scanner();
  if (!scan) return;
  const cases = [
    ["ghp", "A".repeat(35)].join("_"),
    ["ghp", "A".repeat(37)].join("_"),
    ["github", "pat", "A".repeat(81)].join("_"),
    ["AK", "IA", "a".repeat(16)].join(""),
    ["AK", "IA", "A".repeat(17)].join(""),
    ["AI", "za", "A".repeat(34)].join(""),
    ["AI", "za", "A".repeat(36)].join(""),
    ["xoxb", "short", "A".repeat(24)].join("-"),
    ["sk", "ant", "A".repeat(19)].join("-"),
    ["sk", "A".repeat(10)].join("-"),
  ];
  for (const text of cases) expect(scan(text).findings.length === 0).toBe(true);
});

test("scanner names only the assignment adjacent to the matched value", async () => {
  const scan = await scanner();
  if (!scan) return;
  const secret = ["ghp", "Cd8Ef2".repeat(6)].join("_");
  for (const [text, name] of [
    [`API_TOKEN=ordinary\n${secret}`, "unknown key (github)"],
    [`API_TOKEN=ordinary; note=${secret}`, "note"],
    [`${"A".repeat(130)}TOKEN=${secret}`, "unknown key (github)"],
  ]) {
    const result = scan(text!);
    expect(result.findings[0]?.name === name).toBe(true);
    hidden(result, secret);
  }
});

test("scanner distinguishes pure hex32 from base64 with at least24 characters", async () => {
  const scan = await scanner();
  if (!scan) return;
  for (const size of [24, 31, 32]) {
    expect(
      scan(`API_TOKEN=${"a".repeat(size)}`).findings.length > 0 ===
        (size === 32),
    ).toBe(true);
  }
  for (const size of [23, 24]) {
    expect(
      scan(`API_TOKEN=${"Q".repeat(size)}`).findings.length > 0 ===
        (size === 24),
    ).toBe(true);
  }
});

test("scanner metadata never names an identifier containing the matched value", async () => {
  const scan = await scanner();
  if (!scan) return;
  const secret = "a4b9".repeat(8);
  const result = scan(`SECRET_${secret}=${secret}`);
  const metadata = JSON.stringify(result.findings);
  expect(
    Array.from({ length: secret.length - 7 }, (_, i) =>
      metadata.includes(secret.slice(i, i + 8)),
    ).some(Boolean),
  ).toBe(false);
});

test("scanner accepts mixed-case credential keys and ignores unrelated long values", async () => {
  const scan = await scanner();
  if (!scan) return;
  const secret = "a9c4".repeat(9);
  const result = scan(secret, "servicePassword");
  expect(
    result.findings.length === 1 &&
      result.redacted === "[REDACTED]" &&
      result.findings[0]?.name === "servicePassword",
  ).toBe(true);
  hidden(result, secret);
  expect(
    scan(`commit=${secret}\nsha=${secret}\nintegrity=${secret}`).findings
      .length === 0,
  ).toBe(true);
});

for (const key of ["primaryKey", "apiKey"])
  for (const uppercase of [false, true])
    test(`scanner ignores ${uppercase ? "uppercase" : "lowercase"} UUIDs under ${key} while retaining generic detection`, async () => {
      const scan = await scanner();
      if (!scan) return;
      const uuid = ["014df517", "39d1", "4453", "b7b3", "9930c563627c"].join(
        "-",
      );
      const value = uppercase ? uuid.toUpperCase() : uuid;
      expect(
        scan(`${key}=${value}`).findings.length === 0 &&
          scan(value, key).findings.length === 0,
      ).toBe(true);
      const secret = "a9c4".repeat(9);
      for (const result of [
        scan(`primaryKey=${secret}`),
        scan(secret, "primaryKey"),
      ]) {
        expect(result.findings.length === 1).toBe(true);
        hidden(result, secret);
      }
    });

test("scanner handles near-limit noncredential text without pathological backtracking", async () => {
  const scan = await scanner();
  if (!scan) return;
  const started = performance.now();
  const result = scan("z".repeat(1_048_000));
  expect(
    result.findings.length === 0 && performance.now() - started < 1000,
  ).toBe(true);
});

test("scanner rejects an expired budget and an excessive finding count", async () => {
  const scan = await scanner();
  if (!scan) return;
  let expired = false,
    excessive = false;
  try {
    scan("safe", undefined, -1);
  } catch {
    expired = true;
  }
  const secret = ["ghp", "Ab7Cd9".repeat(6)].join("_");
  try {
    scan((secret + "\n").repeat(4097), undefined, performance.now() + 10_000);
  } catch {
    excessive = true;
  }
  expect(expired && excessive).toBe(true);
});
