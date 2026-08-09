"use strict";

const { describe, expect, test } = require("bun:test");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const {
  CONTRACTS,
  canonicalize,
  computeContentHash,
  generateJsonSchema,
  validateContract,
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

  test("rejects mixed-case secrets and user paths in bounded fields", () => {
    const secret = fixture("forge.memory.feedback-report.v1");
    secret.payload.redacted_reproduction_steps = ["Token=supersecretvalue"];
    rehash(secret);
    expect(validateContractStructure(secret).errors.map((item) => item.code)).toContain("PRIVACY_SECRET_PATTERN");

    const path = fixture("forge.memory.structured-error.v1");
    path.payload.safe_details = { detail: "see C:\\users\\alice\\secret.txt" };
    rehash(path);
    expect(validateContractStructure(path).errors.map((item) => item.code)).toContain("PRIVACY_ABSOLUTE_PATH");
  });

  test("privacy-checks context references and feedback return channels", () => {
    const context = fixture("forge.memory.context-packet.v1");
    context.payload.references = [{ detail: "Password: supersecretvalue" }];
    rehash(context);
    expect(validateContractStructure(context).errors.map((item) => item.code)).toContain("PRIVACY_SECRET_PATTERN");

    const feedback = fixture("forge.memory.feedback-report.v1");
    feedback.payload.return_channel = { path: "/Home/alice/private.txt" };
    rehash(feedback);
    expect(validateContractStructure(feedback).errors.map((item) => item.code)).toContain("PRIVACY_ABSOLUTE_PATH");
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

  test("bounds and privacy-checks StructuredError safe details and inline run evidence", () => {
    const structured = fixture("forge.memory.structured-error.v1");
    structured.payload.safe_details = { detail: "token=ghp_123456789012345678901234567890" };
    rehash(structured);
    expect(validateContractStructure(structured).errors.map((item) => item.code)).toContain("PRIVACY_SECRET_PATTERN");

    const receipt = fixture("forge.memory.run-receipt.v1");
    receipt.payload.validation = { output: "C:\\Users\\alice\\private.log" };
    rehash(receipt);
    expect(validateContractStructure(receipt).errors.map((item) => item.code)).toContain("PRIVACY_ABSOLUTE_PATH");

    const structuredShape = generateJsonSchema("forge.memory.structured-error.v1").properties.payload.properties.safe_details;
    const runShape = generateJsonSchema("forge.memory.run-receipt.v1").properties.payload.properties.validation;
    expect(structuredShape["x-forge-max-serialized-bytes"]).toBeNumber();
    expect(runShape["x-forge-secret-pattern"]).toBeString();
    expect(() => JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "v1", "structured-error-privacy-reject.json"), "utf8"))).not.toThrow();
  });

  test("rejects Stripe live and test secret keys in StructuredError details", () => {
    for (const [secret, fixtureName] of [
      ["sk_live_1234567890ABCDEF", "structured-error-stripe-live-reject.json"],
      ["sk_test_ABCDEF1234567890", "structured-error-stripe-test-reject.json"],
    ]) {
      const structured = fixture("forge.memory.structured-error.v1");
      structured.payload.safe_details = { detail: secret };
      rehash(structured);
      expect(validateContractStructure(structured).errors.map((item) => item.code)).toContain("PRIVACY_SECRET_PATTERN");
      const negativeFixture = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "v1", fixtureName), "utf8"));
      expect(negativeFixture.mutation.value).toEqual({ detail: secret });
      expect(negativeFixture.expected).toEqual({ ok: false, code: "PRIVACY_SECRET_PATTERN" });
    }
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

describe("validation descriptor preflight", () => {
  test("rejects inherited object keys as unsupported schema IDs without throwing", () => {
    const packet = fixture("forge.memory.work-packet.v1");
    packet.schema_id = "constructor";
    rehash(packet);
    let result;
    expect(() => { result = validateContractStructure(packet); }).not.toThrow();
    expect(result.errors).toContainEqual({ path: "$.schema_id", code: "UNSUPPORTED_SCHEMA" });
  });

  test("never invokes hostile top-level or nested getters", () => {
    let invoked = 0;
    const topLevel = {};
    Object.defineProperty(topLevel, "schema_id", { enumerable: true, get() { invoked += 1; throw new Error("executed"); } });
    let topResult;
    expect(() => { topResult = validateContractStructure(topLevel); }).not.toThrow();
    expect(invoked).toBe(0);
    expect(topResult).toEqual({ ok: false, errors: [{ path: "$", code: "NON_CANONICAL_VALUE" }] });

    const nested = fixture("forge.memory.work-packet.v1");
    Object.defineProperty(nested.payload, "issue_id", { enumerable: true, get() { invoked += 1; throw new Error("executed"); } });
    let nestedResult;
    expect(() => { nestedResult = validateContractStructure(nested); }).not.toThrow();
    expect(invoked).toBe(0);
    expect(nestedResult).toEqual({ ok: false, errors: [{ path: "$", code: "NON_CANONICAL_VALUE" }] });
  });

  test("returns the same stable failure for nested proxies", () => {
    const packet = fixture("forge.memory.work-packet.v1");
    packet.payload = new Proxy(packet.payload, { get() { throw new Error("proxy trap executed"); } });
    expect(() => validateContractStructure(packet)).not.toThrow();
    expect(validateContractStructure(packet)).toEqual({ ok: false, errors: [{ path: "$", code: "NON_CANONICAL_VALUE" }] });
  });
});

describe("schema annotation truthfulness", () => {
  test("declares Forge runtime conformance rather than generic JSON Schema enforcement", () => {
    const matrix = JSON.parse(readFileSync(join(__dirname, "..", "compatibility-matrix.v1.json"), "utf8"));
    const annotations = matrix.readers["0.1.0-beta.6"].schema_annotations;
    expect(annotations.generic_json_schema_enforces_x_forge).toBe(false);
    expect(annotations.conformance_helper).toBe("validateContractStructure");
    expect(typeof validateContractStructure).toBe("function");
  });
});

describe("extension schema and runtime parity", () => {
  test("generated schemas encode the same advisory-only extension contract", () => {
    const extensions = generateJsonSchema("forge.memory.work-packet.v1").properties.extensions;
    expect(extensions.additionalProperties.properties.impact.const).toBe("advisory");
    expect(extensions.additionalProperties.required).toEqual(["impact", "schema_version", "value"]);
    expect(extensions.propertyNames.maxLength).toBeNumber();

    const packet = fixture("forge.memory.work-packet.v1");
    packet.extensions["vendor.example/advisory"] = { impact: "advisory", schema_version: 1, value: true, extra: true };
    rehash(packet);
    expect(validateContractStructure(packet).errors.map((item) => item.code)).toContain("INVALID_EXTENSION");
  });
});

describe("live evidence timestamps", () => {
  test.each([
    ["forge.memory.lease-receipt.v1", { issueRevision: 7, actorId: "agent-1", leaseEpoch: 2, observedAt: "not-a-time" }, "STALE_LEASE"],
    ["forge.memory.capability-manifest.v1", { providerId: "provider-1", configRevision: "config-1", observedAt: "not-a-time" }, "STALE_CAPABILITY_MANIFEST"],
  ])("fails closed for malformed observed time on %s", (schemaId, expected, code) => {
    const value = fixture(schemaId);
    expect(validateContract(value, { expected }).errors.map((item) => item.code)).toContain(code);
  });
});
