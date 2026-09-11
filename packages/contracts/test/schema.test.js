"use strict";

const { expect, test } = require("bun:test");
const { generateJsonSchema } = require("../src/schema.js");

test("generated schemas reject undeclared payload fields", () => {
  const schema = generateJsonSchema("forge.memory.work-packet.v1");
  expect(schema.properties.payload.additionalProperties).toBe(false);
});
