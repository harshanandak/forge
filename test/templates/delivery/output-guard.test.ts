import { expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

setDefaultTimeout(30_000);
const path = resolve(
  import.meta.dirname,
  "../../../templates/delivery/harness/output-scanner.mjs",
);
async function scanner() {
  return (
    (await import(pathToFileURL(path).href)) as {
      scan: (text: string, key?: string, deadline?: number) => boolean;
    }
  ).scan;
}

test("scanner returns only a boolean for overlapping provider and generic matches", async () => {
  const scan = await scanner();
  const secret = ["ghp", "Ab7Cd9".repeat(6)].join("_");
  expect(scan(`API_TOKEN=${secret}`)).toBe(true);
  expect(scan("ordinary")).toBe(false);
});

test("scanner requires provider-specific lengths and character sets", async () => {
  const scan = await scanner();
  for (const text of [
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
  ])
    expect(scan(text)).toBe(false);
});

test("scanner distinguishes hex32 from base64 with at least 24 characters", async () => {
  const scan = await scanner();
  for (const size of [24, 31, 32])
    expect(scan(`API_TOKEN=${"a".repeat(size)}`)).toBe(size === 32);
  for (const size of [23, 24])
    expect(scan(`API_TOKEN=${"Q".repeat(size)}`)).toBe(size === 24);
});

test("scanner accepts mixed-case credential keys and ignores unrelated long values", async () => {
  const scan = await scanner();
  const secret = "a9c4".repeat(9);
  expect(scan(secret, "servicePassword")).toBe(true);
  expect(scan(`commit=${secret}\nsha=${secret}\nintegrity=${secret}`)).toBe(
    false,
  );
});

test("scanner excludes UUIDs under credential keys while retaining generic detection", async () => {
  const scan = await scanner();
  const uuid = ["014df517", "39d1", "4453", "b7b3", "9930c563627c"].join("-");
  for (const key of ["primaryKey", "apiKey"])
    for (const value of [uuid, uuid.toUpperCase()]) {
      expect(scan(`${key}=${value}`)).toBe(false);
      expect(scan(value, key)).toBe(false);
    }
  expect(scan(`primaryKey=${"a9c4".repeat(9)}`)).toBe(true);
  expect(scan("a9c4".repeat(9), "primaryKey")).toBe(true);
});

test("scanner handles near-limit noncredential text within the existing budget", async () => {
  const scan = await scanner();
  const started = performance.now();
  expect(scan("z".repeat(1_048_000))).toBe(false);
  expect(performance.now() - started < 1000).toBe(true);
});

test("scanner checks the deadline and stops at the first match", async () => {
  const scan = await scanner();
  expect(() => scan("safe", undefined, -1)).toThrow();
  const secret = ["ghp", "Ab7Cd9".repeat(6)].join("_");
  expect(scan((secret + "\n").repeat(10_000))).toBe(true);
});
