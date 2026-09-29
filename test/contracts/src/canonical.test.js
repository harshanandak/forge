"use strict";

const { expect, test } = require("bun:test");
const { canonicalize } = require("../../../lib/contracts/src/canonical.js");

test("canonical JSON recursively sorts object keys", () => {
  expect(canonicalize({ z: 1, a: { y: 2, x: 1 } })).toBe('{"a":{"x":1,"y":2},"z":1}');
});

test("canonical JSON orders keys by UTF-16 code unit, not locale", () => {
  expect(canonicalize({ a: 2, B: 1 })).toBe('{"B":1,"a":2}');
});

test("canonical JSON accepts paired surrogates and rejects unpaired surrogates", () => {
  expect(canonicalize("\uD83D\uDE00")).toBe('"😀"');
  for (const value of ["\uD800", "\uDFFF"]) {
    expect(() => canonicalize(value)).toThrow("Canonical JSON rejects unpaired UTF-16 surrogates");
  }
});
