"use strict";

const { expect, test } = require("bun:test");
const { semanticIdentity } = require("../src/identity.js");

test("semantic identity rejects incomplete identity material", () => {
  expect(() => semanticIdentity({ schema_id: "forge.memory.work-packet.v1", payload: {} })).toThrow();
});
