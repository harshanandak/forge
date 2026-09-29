"use strict";

const { expect, test } = require("bun:test");
const { stableStringify } = require("../../../lib/flow/src/stable-stringify.js");

test("stableStringify orders object keys by UTF-16 code unit", () => {
  expect(stableStringify({ "ä": 1, z: [{ b: 2, a: 1 }] }))
    .toBe('{"z":[{"a":1,"b":2}],"ä":1}');
});
