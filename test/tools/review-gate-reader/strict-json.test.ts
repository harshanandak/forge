import { expect, setDefaultTimeout, spyOn, test } from "bun:test";
import {
  fail,
  ok,
  reasons,
} from "../../../tools/ci/review-gate-reader/result.ts";
import {
  bool,
  open,
  parseStrictJson,
  uint,
} from "../../../tools/ci/review-gate-reader/strict-json.ts";

setDefaultTimeout(1000);

const exact = { a: uint };
const openId = open({ id: uint });
const numberField = { n: uint };
const importRoot = "../../../tools/ci/review-gate-reader";

test.each([
  ["S1 duplicate key", '{"a":1,"a":2}', exact, "$.a"],
  ["S2 escaped duplicate", '{"a":1,"\\u0061":2}', exact, "$.a"],
  ["S3 nested duplicate", '{"x":{"a":1,"a":2}}', { x: exact }, "$.x.a"],
  ["S4 prototype key", '{"__proto__":{"x":1}}', {}, "$.__proto__"],
  ["S5 unknown key", '{"a":1,"b":2}', exact, "$.b"],
  ["S10 wrong top-level kind", "[]", exact, "$"],
] as const)("%s", (_name, text, schema, where) => {
  expect(parseStrictJson(text, schema)).toEqual(fail("json_invalid", where));
  expect(Object.hasOwn(Object.prototype, "x")).toBe(false);
});

test.each([
  ['{"id":1,"extra":{"a":1,"a":2}}', "$.extra.a"],
  ['{"id":1,"__proto__":1}', "$.__proto__"],
])("S13 invalid keys in open object %j", (text, where) => {
  expect(parseStrictJson(text, openId)).toEqual(fail("json_invalid", where));
});

test.each([
  [
    "S4 constructor at root",
    '{"id":1,"constructor":{"prototype":{"x":1}}}',
    "$.constructor",
  ],
  ["S4 prototype at root", '{"id":1,"prototype":1}', "$.prototype"],
  [
    "S13 constructor in dropped extra",
    '{"id":1,"extra":{"constructor":{"prototype":{"x":1}}}}',
    "$.extra.constructor",
  ],
  [
    "S13 prototype in dropped extra",
    '{"id":1,"extra":{"prototype":1}}',
    "$.extra.prototype",
  ],
])("%s", (_name, text, where) => {
  expect(parseStrictJson(text, openId)).toEqual(fail("json_invalid", where));
});

test.each([
  ["S6 string Boolean", '{"ok":"true"}', { ok: bool }, "$.ok"],
  ["S9 missing key", "{}", exact, "$.a"],
  ["S10 wrong nested kind", '{"a":[]}', exact, "$.a"],
] as const)("%s", (_name, text, schema, where) => {
  const result = parseStrictJson(text, schema);
  expect(result).toEqual(fail("api_field_invalid", where));
});

test.each(["1.0", "1e2", "-1", "9007199254740993", '"1"'])(
  "S7 rejects number token %s",
  (token) => {
    const result = parseStrictJson(`{"n":${token}}`, numberField);
    expect(result).toEqual(fail("api_field_invalid", "$.n"));
  },
);

test.each(["", '{"a":1} x', '{"a":1,}', "{a:1}", '// c\n{"a":1}', "NaN"])(
  "S8 malformed document %j",
  (text) =>
    expect(parseStrictJson(text, exact)).toEqual(fail("json_invalid", "$")),
);

test.each(['{"a":1}', '{"a":1}\n'])("S11 exact object %j", (text) => {
  expect(parseStrictJson(text, exact)).toEqual(ok({ a: 1 }));
});

test("S12 open object drops extra fields", () => {
  expect(parseStrictJson('{"id":1,"extra":{"z":2}}', openId)).toEqual(
    ok({ id: 1 }),
  );
});

test("E1 imports do not fetch or read a clock", async () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response());
  const clockSpy = spyOn(Date, "now").mockReturnValue(0);
  try {
    for (const name of ["result", "strict-json", "transport", "pages"]) {
      await import(`${importRoot}/${name}.ts?import-hygiene`);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(clockSpy).toHaveBeenCalledTimes(0);
  } finally {
    fetchSpy.mockRestore();
    clockSpy.mockRestore();
  }
});

test("E2 closed reason set", () => {
  expect<string[]>([...reasons].sort()).toEqual([
    "api_field_invalid",
    "api_rate_limited",
    "bot_format_malformed",
    "bot_format_unsupported",
    "bot_head_invalid",
    "bot_identity_mismatch",
    "bot_state_conflict",
    "bot_state_invalid",
    "bot_version_unsupported",
    "http_status",
    "json_invalid",
    "network_error",
    "other_bot_unsupported",
    "pages_incomplete",
  ]);
});
