"use strict";

const { expect, test } = require("bun:test");
const contracts = require("./index.js");

test("exports the complete contract surface", () => {
  for (const name of ["canonicalize", "computeContentHash", "semanticIdentity", "validateContract", "verifyContractBaseline"]) {
    expect(typeof contracts[name]).toBe("function");
  }
});
