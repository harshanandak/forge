"use strict";

const { expect, test } = require("bun:test");
const { validateEnvelope } = require("../src/validate.js");

test("non-object envelopes fail closed", () => {
  expect(validateEnvelope(null)).toEqual({ ok: false, errors: [{ path: "$", code: "INVALID_ENVELOPE" }] });
});
