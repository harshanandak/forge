"use strict";

const { expect, test } = require("bun:test");
const { verifyContractBaseline } = require("../../../lib/contracts/src/baseline.js");

test("baseline artifacts match their SHA-256 digests", () => {
  expect(verifyContractBaseline()).toEqual({ ok: true, mismatches: [] });
});
