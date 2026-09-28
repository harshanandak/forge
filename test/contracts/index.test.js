"use strict";

const { expect, test } = require("bun:test");
const contracts = require("../../lib/contracts");

test("exports the complete contract surface", () => {
  for (const name of ["canonicalize", "computeContentHash", "semanticIdentity", "validateContract", "validateContractStructure", "verifyContractBaseline"]) {
    expect(typeof contracts[name]).toBe("function");
  }
});
