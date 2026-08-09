"use strict";

const { expect, test } = require("bun:test");
const { canonicalize } = require("../src/canonical.js");

test("canonical JSON recursively sorts object keys", () => {
  expect(canonicalize({ z: 1, a: { y: 2, x: 1 } })).toBe('{"a":{"x":1,"y":2},"z":1}');
});
