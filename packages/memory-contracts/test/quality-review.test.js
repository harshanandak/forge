"use strict";

const { describe, expect, test } = require("bun:test");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const {
  CONTRACTS,
  canonicalize,
  computeContentHash,
  generateJsonSchema,
  validateContractStructure,
} = require("../index.js");

const fixtureInputs = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "v1", "contract-inputs.v1.json"), "utf8"),
).inputs;

function fixture(schemaId) {
  return structuredClone(fixtureInputs.find((input) => input.schema_id === schemaId));
}

function rehash(value) {
  value.content_hash = computeContentHash(value);
  return value;
}

describe("immutable contract definitions", () => {
  test("recursively freezes every exported definition", () => {
    const work = CONTRACTS["forge.memory.work-packet.v1"];
    expect(Object.isFrozen(CONTRACTS)).toBe(true);
    expect(Object.isFrozen(work)).toBe(true);
    expect(Object.isFrozen(work.required)).toBe(true);
    expect(Object.isFrozen(work.identity)).toBe(true);
    expect(() => work.required.push("attacker_field")).toThrow();
  });

  test("returns detached generated schemas that cannot mutate validation", () => {
    const generated = generateJsonSchema("forge.memory.work-packet.v1");
    generated.properties.payload.properties.expected_issue_revision.type = "string";
    expect(generateJsonSchema("forge.memory.work-packet.v1").properties.payload.properties.expected_issue_revision.type).toBe("integer");
    const malformed = fixture("forge.memory.work-packet.v1");
    malformed.payload.expected_issue_revision = "1";
    rehash(malformed);
    expect(validateContractStructure(malformed).errors.map((item) => item.code)).toContain("INVALID_TYPE");
  });
});

describe("hostile canonical inputs and limits", () => {
  test("rejects accessors, non-plain objects, and proxies without invoking them", () => {
    let invoked = false;
    const accessor = {};
    Object.defineProperty(accessor, "secret", { enumerable: true, get() { invoked = true; return "no"; } });
    expect(() => canonicalize(accessor)).toThrow();
    expect(invoked).toBe(false);
    expect(() => canonicalize(new Date())).toThrow();
    expect(() => canonicalize(new Proxy({ safe: true }, {}))).toThrow();
  });

  test("rejects cycles and deterministic depth, node, and byte limit breaches", () => {
    const cyclic = {};
    cyclic.self = cyclic;
    for (const [value, options, code] of [
      [cyclic, {}, "CANONICAL_CYCLE"],
      [{ a: { b: 1 } }, { maxDepth: 1 }, "CANONICAL_DEPTH_LIMIT"],
      [[1, 2], { maxNodes: 2 }, "CANONICAL_NODE_LIMIT"],
      [{ message: "too large" }, { maxBytes: 8 }, "CANONICAL_BYTE_LIMIT"],
    ]) {
      try {
        canonicalize(value, options);
        throw new Error("expected canonicalization failure");
      } catch (error) {
        expect(error.code).toBe(code);
      }
    }
  });
});

describe("privacy-safe bounded contract fields", () => {
  test("rejects obvious secret tokens and absolute user paths in feedback", () => {
    const secret = fixture("forge.memory.feedback-report.v1");
    secret.payload.redacted_reproduction_steps = ["token=ghp_123456789012345678901234567890"];
    rehash(secret);
    expect(validateContractStructure(secret).errors.map((item) => item.code)).toContain("PRIVACY_SECRET_PATTERN");

    const path = fixture("forge.memory.feedback-report.v1");
    path.payload.redacted_reproduction_steps = ["see C:\\Users\\alice\\secret.txt"];
    rehash(path);
    expect(validateContractStructure(path).errors.map((item) => item.code)).toContain("PRIVACY_ABSOLUTE_PATH");
  });

  test("rejects oversized, deep, property-heavy, and item-heavy bounded monitor payloads", () => {
    const cases = [
      ["BOUNDED_VALUE_TOO_LARGE", { text: "x".repeat(20_000) }],
      ["BOUNDED_VALUE_TOO_DEEP", { a: { b: { c: { d: { e: { f: { g: { h: { i: true } } } } } } } } }],
      ["BOUNDED_VALUE_TOO_MANY_PROPERTIES", Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`p${index}`, index]))],
      ["BOUNDED_VALUE_TOO_MANY_ITEMS", { values: Array.from({ length: 129 }, (_, index) => index) }],
    ];
    for (const [code, boundedPayload] of cases) {
      const event = fixture("forge.memory.monitor-event.v1");
      event.payload.bounded_payload = boundedPayload;
      rehash(event);
      expect(validateContractStructure(event).errors.map((item) => item.code)).toContain(code);
    }
  });

  test("applies the same privacy boundary to monitor cleanup receipts", () => {
    const receipt = fixture("forge.memory.monitor-receipt.v1");
    receipt.payload.process_cleanup = { detail: "password=supersecretvalue" };
    rehash(receipt);
    expect(validateContractStructure(receipt).errors.map((item) => item.code)).toContain("PRIVACY_SECRET_PATTERN");
  });

  test("mirrors privacy and bounds in generated schemas and negative fixtures", () => {
    const feedback = generateJsonSchema("forge.memory.feedback-report.v1").properties.payload.properties.redacted_reproduction_steps;
    expect(feedback.maxItems).toBeNumber();
    expect(feedback.items.not).toBeDefined();
    const monitor = generateJsonSchema("forge.memory.monitor-event.v1").properties.payload.properties.bounded_payload;
    expect(monitor["x-forge-max-depth"]).toBeNumber();
    const monitorReceipt = generateJsonSchema("forge.memory.monitor-receipt.v1").properties.payload.properties.process_cleanup;
    expect(monitorReceipt["x-forge-max-serialized-bytes"]).toBeNumber();
    for (const name of ["feedback-secret-reject.json", "monitor-bounds-reject.json", "monitor-receipt-privacy-reject.json"]) {
      expect(() => JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "v1", name), "utf8"))).not.toThrow();
    }
  });
});

describe("extension schema and runtime parity", () => {
  test("generated schemas encode the same advisory-only extension contract", () => {
    const extensions = generateJsonSchema("forge.memory.work-packet.v1").properties.extensions;
    expect(extensions.additionalProperties.properties.impact.const).toBe("advisory");
    expect(extensions.additionalProperties.required).toEqual(["impact", "schema_version", "value"]);

    const packet = fixture("forge.memory.work-packet.v1");
    packet.extensions["vendor.example/advisory"] = { impact: "advisory", schema_version: 1, value: true, extra: true };
    rehash(packet);
    expect(validateContractStructure(packet).errors.map((item) => item.code)).toContain("INVALID_EXTENSION");
  });
});
