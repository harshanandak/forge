"use strict";

const { expect, test } = require("bun:test");
const { CONTRACTS } = require("../src/definitions.js");

test("defines all packet, receipt, feedback, error, and monitor contracts", () => {
  expect(Object.keys(CONTRACTS)).toHaveLength(11);
  expect(Object.values(CONTRACTS).every((definition) => definition.identity.length > 0)).toBe(true);
});
