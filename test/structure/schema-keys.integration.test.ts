import { expect, test } from "bun:test";
import { listRepoFiles, readRepoFiles } from "./lib/repo.ts";
import { parseJsonWithUniqueKeys } from "./lib/unique-json-keys.ts";

test("schema JSON never hides constraints behind duplicate object keys", () => {
  const paths = listRepoFiles().filter((path) =>
    /^schemas\/[^/]+\.json$/.test(path),
  );
  expect(paths.length).toBeGreaterThan(0);
  for (const file of readRepoFiles(paths)) {
    expect(() => parseJsonWithUniqueKeys(file.text), file.path).not.toThrow();
  }
}, 30_000);

test("the schema guard rejects duplicate keys at the root and nested in arrays", () => {
  for (const text of [
    '{"timeoutMs":{"minimum":1},"timeoutMs":{"maximum":100}}',
    '{"properties":{"timeoutMs":1,"timeoutMs":2}}',
    '{"allOf":[{"properties":{"timeoutMs":1,"timeoutMs":2}}]}',
    '{"a":{},"a":[]}',
  ]) {
    expect(() => parseJsonWithUniqueKeys(text)).toThrow("Duplicate JSON key");
  }
}, 30_000);

test("the schema guard compares decoded keys, including Unicode and escaped punctuation", () => {
  for (const text of [
    String.raw`{"timeoutMs":1,"\u0074imeoutMs":2}`,
    String.raw`{"a/b":1,"a\/b":2}`,
    String.raw`{"a\\b":1,"a\u005cb":2}`,
  ]) {
    expect(() => parseJsonWithUniqueKeys(text)).toThrow("Duplicate JSON key");
  }
}, 30_000);

test("the schema guard accepts the same key in separate objects and ignores string contents", () => {
  const text = String.raw`{
    "properties":{"timeoutMs":{"minimum":1}},
    "allOf":[{"properties":{"timeoutMs":{"maximum":100}}}],
    "description":"{\"timeoutMs\":1,\"timeoutMs\":2}",
    "empty":{},
    "values":[true,false,null,-1.5e2,"a\\\"b",[{}]]
  }`;
  expect(parseJsonWithUniqueKeys(text)).toEqual(JSON.parse(text));
}, 30_000);

test("the schema guard also rejects invalid JSON instead of scanning partial input", () => {
  for (const text of ['{"x":1,}', '{"x":1} trailing', '{"x":"unterminated}']) {
    expect(() => parseJsonWithUniqueKeys(text)).toThrow(SyntaxError);
  }
}, 30_000);
