"use strict";

const { describe, expect, test } = require("bun:test");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const {
  CONTRACTS,
  computeContentHash,
  generateJsonSchema,
  validateContract,
  validateEnvelope,
} = require("../index.js");

function validWorkPacket() {
  const value = {
    schema_id: "forge.memory.work-packet.v1",
    schema_version: 1,
    object_id: "4c9d9e6a-4f14-47e7-aac8-9ec7731aa523",
    created_at: "2026-08-09T12:00:00.000Z",
    producer: { product_id: "forge-memory", product_version: "0.1.0-beta.6", instance_id: "run-1" },
    capabilities_used: [{ capability_id: "flow.execute", manifest_digest: "c".repeat(64) }],
    provenance: { source_kind: "kernel", actor_class: "agent", actor_id: "agent-1" },
    payload: {
      issue_id: "5037a7da-d49b-4015-a3fa-aac34425078e",
      expected_issue_revision: 7,
      packet_id: "packet-1",
      packet_revision: 1,
      repository_id: "github.com/harshanandak/forge",
      target_head: "a".repeat(40),
      objective: "test contracts",
      authority: { kind: "kernel", issue_revision: 7 },
      allowed_mutations: ["files"],
      workflow_config_revision: "config-1",
      capability_manifest_digest: "c".repeat(64),
    },
    extensions: {},
  };
  value.content_hash = computeContentHash(value);
  return value;
}

describe("fail-closed live evidence", () => {
  test("does not accept a consequential WorkPacket without live expectations", () => {
    const result = validateContract(validWorkPacket());
    expect(result.ok).toBe(false);
    expect(result.errors.map((item) => item.code)).toContain("MISSING_LIVE_EVIDENCE");
  });
});

describe("concrete runtime and schema shapes", () => {
  test("rejects non-integer issue revisions and incomplete capability bindings", () => {
    const packet = validWorkPacket();
    packet.payload.expected_issue_revision = "7";
    packet.capabilities_used = [{ capability_id: "flow.execute" }];
    packet.content_hash = computeContentHash(packet);
    const result = validateContract(packet, {
      expected: {
        issueRevision: 7,
        workflowConfigRevision: "config-1",
        capabilityManifestDigest: "c".repeat(64),
        exactHead: "a".repeat(40),
      },
    });
    expect(result.errors.map((item) => item.code)).toEqual(
      expect.arrayContaining(["INVALID_TYPE", "INVALID_CAPABILITY_BINDING"]),
    );
  });

  test("gives every required payload field a concrete generated shape", () => {
    for (const [schemaId, definition] of Object.entries(CONTRACTS)) {
      const properties = generateJsonSchema(schemaId).properties.payload.properties;
      for (const field of definition.required) expect(properties[field].type).toBeDefined();
    }
    const capabilityItems = generateJsonSchema("forge.memory.work-packet.v1").properties.capabilities_used.items;
    expect(capabilityItems.required).toEqual(["capability_id", "manifest_digest"]);
  });

  test("runtime-rejects invalid values for every required contract field", () => {
    const corpus = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "v1", "contract-inputs.v1.json"), "utf8"));
    for (const input of corpus.inputs) {
      for (const field of CONTRACTS[input.schema_id].required) {
        const malformed = structuredClone(input);
        malformed.payload[field] = null;
        malformed.content_hash = computeContentHash(malformed);
        const result = validateContract(malformed, { expected: {} });
        expect(result.errors).toContainEqual({ path: `$.payload.${field}`, code: "INVALID_TYPE" });
      }
    }
  });
});

describe("portable executable fixture corpus", () => {
  const fixtureRoot = join(__dirname, "..", "fixtures", "v1");

  test("contains hash-valid inputs for all eleven contracts", () => {
    const corpus = JSON.parse(readFileSync(join(fixtureRoot, "contract-inputs.v1.json"), "utf8"));
    expect(corpus.inputs).toHaveLength(11);
    expect(new Set(corpus.inputs.map((input) => input.schema_id))).toEqual(new Set(Object.keys(CONTRACTS)));
    for (const input of corpus.inputs) expect(validateEnvelope(input).ok).toBe(true);
  });

  test("contains an executable missing-field input per envelope field", () => {
    const corpus = JSON.parse(readFileSync(join(fixtureRoot, "malformed-envelope-inputs.v1.json"), "utf8"));
    const valid = JSON.parse(readFileSync(join(fixtureRoot, corpus.base_input.ref), "utf8"))
      .inputs.find((input) => input.schema_id === corpus.base_input.schema_id);
    expect(corpus.cases).toHaveLength(10);
    for (const item of corpus.cases) {
      const input = structuredClone(valid);
      delete input[item.missing_field];
      const result = validateEnvelope(input, { verifyHash: false });
      expect(result.ok).toBe(false);
      expect(result.errors.some((error) => error.path === `$.${item.missing_field}`)).toBe(true);
    }
  });

  test("ships the compatibility matrix to packed consumers", () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
    expect(manifest.files).toContain("compatibility-matrix.v1.json");
  });
});
