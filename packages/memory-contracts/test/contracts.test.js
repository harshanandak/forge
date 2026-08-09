"use strict";

const { describe, expect, test } = require("bun:test");
const { existsSync, readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const {
  canonicalize,
  classifySemanticAttempt,
  computeContentHash,
  generateJsonSchema,
  parseContract,
  semanticIdentity,
  supportedSchemaVersions,
  validateContract,
  verifyContractBaseline,
  validateEnvelope,
} = require("../index.js");

function workPacket(overrides = {}) {
  const packet = {
    schema_id: "forge.memory.work-packet.v1",
    schema_version: 1,
    object_id: "4c9d9e6a-4f14-47e7-aac8-9ec7731aa523",
    created_at: "2026-08-09T12:00:00.000Z",
    producer: {
      product_id: "forge-memory",
      product_version: "0.1.0-beta.6",
      instance_id: "run-1",
    },
    capabilities_used: [],
    provenance: {
      source_kind: "kernel",
      actor_class: "agent",
      actor_id: "agent-1",
      repository_id: "github.com/harshanandak/forge",
      exact_head: "a".repeat(40),
    },
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
    ...overrides,
  };
  packet.content_hash = computeContentHash(packet);
  return packet;
}

function contextPacket(overrides = {}) {
  const packet = {
    schema_id: "forge.memory.context-packet.v1",
    schema_version: 1,
    object_id: "f1f99076-d454-495e-acb4-77286b5b206d",
    created_at: "2026-08-09T12:00:00.000Z",
    producer: { product_id: "forge-memory", product_version: "0.1.0-beta.6", instance_id: "run-1" },
    capabilities_used: [],
    provenance: { source_kind: "kernel", actor_class: "agent", actor_id: "agent-1" },
    payload: {
      work_packet_hash: "a".repeat(64),
      context_selection_revision: 3,
      privacy_scope_hash: "b".repeat(64),
      retention_class: "local_sensitive",
      disclosure_class: "remote_redacted",
      redaction_policy_revision: "redaction-2",
      summaries: [{ kind: "issue", text: "bounded redacted summary" }],
    },
    extensions: {},
    ...overrides,
  };
  packet.content_hash = computeContentHash(packet);
  return packet;
}

describe("contract envelope validation", () => {
  test("rejects every missing required envelope field", () => {
    const complete = {
      schema_id: "forge.memory.work-packet.v1",
      schema_version: 1,
      object_id: "4c9d9e6a-4f14-47e7-aac8-9ec7731aa523",
      created_at: "2026-08-09T12:00:00.000Z",
      producer: {
        product_id: "forge-memory",
        product_version: "0.1.0-beta.6",
        instance_id: "run-1",
      },
      capabilities_used: [],
      provenance: {
        source_kind: "kernel",
        actor_class: "agent",
        actor_id: "agent-1",
      },
      content_hash: "0".repeat(64),
      payload: {},
      extensions: {},
    };

    for (const field of Object.keys(complete)) {
      const malformed = { ...complete };
      delete malformed[field];
      const result = validateEnvelope(malformed, { verifyHash: false });
      expect(result.ok).toBe(false);
      expect(result.errors.some((error) => error.path === `$.${field}`)).toBe(true);
    }
  });
});

describe("RFC 8785 canonical content hashing", () => {
  test("sorts object keys recursively and uses JSON number serialization", () => {
    expect(canonicalize({ z: 1, a: { y: -0, x: "€" } })).toBe(
      '{"a":{"x":"€","y":0},"z":1}',
    );
  });

  test("rejects values that JSON Canonicalization Scheme cannot encode", () => {
    expect(() => canonicalize({ invalid: Number.NaN })).toThrow();
    expect(() => canonicalize({ invalid: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => canonicalize({ invalid: undefined })).toThrow();
  });

  test("excludes only content_hash from its own digest", () => {
    const value = {
      schema_id: "forge.memory.work-packet.v1",
      extensions: { "example.test": { impact: "advisory", schema_version: 1, value: true } },
      payload: { objective: "test" },
      content_hash: "a".repeat(64),
    };
    const first = computeContentHash(value);
    value.content_hash = "b".repeat(64);
    expect(computeContentHash(value)).toBe(first);
    value.extensions["example.test"].value = false;
    expect(computeContentHash(value)).not.toBe(first);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("semantic retry and conflict detection", () => {
  test("derives a stable identity from contract-defined fields", () => {
    const packet = workPacket();
    const retried = { ...packet, created_at: "2026-08-09T12:01:00.000Z" };
    expect(semanticIdentity(retried)).toBe(semanticIdentity(packet));
  });

  test("deduplicates exact retry but rejects changed content at one identity", () => {
    const accepted = workPacket();
    expect(classifySemanticAttempt(accepted, { ...accepted })).toEqual({
      status: "retry-identical",
      identity: semanticIdentity(accepted),
      content_hash: accepted.content_hash,
    });

    const changed = workPacket({
      payload: { ...accepted.payload, objective: "different intent" },
    });
    expect(semanticIdentity(changed)).toBe(semanticIdentity(accepted));
    expect(classifySemanticAttempt(accepted, changed).status).toBe("identity-conflict");

    const staleDigest = { ...changed, content_hash: accepted.content_hash };
    expect(classifySemanticAttempt(accepted, staleDigest).status).toBe("identity-conflict");
  });

  test("treats a different semantic identity as new", () => {
    const accepted = workPacket();
    const next = workPacket({
      payload: { ...accepted.payload, packet_revision: 2 },
    });
    expect(classifySemanticAttempt(accepted, next).status).toBe("new-identity");
  });
});

describe("extension compatibility", () => {
  test("preserves unknown advisory extensions through canonical round-trip", () => {
    const packet = workPacket({
      extensions: {
        "vendor.example/annotation": {
          impact: "advisory",
          schema_version: 1,
          value: { note: "preserve me", rank: 2 },
        },
      },
    });
    packet.content_hash = computeContentHash(packet);
    const parsed = parseContract(canonicalize(packet), {
      expected: {
        issueRevision: packet.payload.expected_issue_revision,
        workflowConfigRevision: packet.payload.workflow_config_revision,
        capabilityManifestDigest: packet.payload.capability_manifest_digest,
        exactHead: packet.payload.target_head,
      },
    });
    expect(parsed.extensions).toEqual(packet.extensions);
    expect(parsed.content_hash).toBe(packet.content_hash);
  });

  test("fails closed on an unknown consequential extension", () => {
    const packet = workPacket({
      extensions: {
        "vendor.example/authority": {
          impact: "consequential",
          schema_version: 1,
          value: { permit: true },
        },
      },
    });
    packet.content_hash = computeContentHash(packet);
    const result = validateContract(packet);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual({
      path: '$.extensions["vendor.example/authority"]',
      code: "UNKNOWN_CONSEQUENTIAL_EXTENSION",
    });
  });
});

describe("consequential authority, capability, and privacy evidence", () => {
  test("rejects stale issue and workflow authority", () => {
    const result = validateContract(workPacket(), {
      expected: { issueRevision: 8, workflowConfigRevision: "config-2" },
    });
    expect(result.errors.map((item) => item.code)).toEqual(
      expect.arrayContaining(["STALE_ISSUE_REVISION", "STALE_WORKFLOW_CONFIG"]),
    );
  });

  test("rejects the wrong capability digest and exact head", () => {
    const result = validateContract(workPacket(), {
      expected: { capabilityManifestDigest: "d".repeat(64), exactHead: "b".repeat(40) },
    });
    expect(result.errors.map((item) => item.code)).toEqual(
      expect.arrayContaining(["WRONG_CAPABILITY_DIGEST", "STALE_EXACT_HEAD"]),
    );
  });

  test("rejects widened or stale privacy evidence", () => {
    const result = validateContract(contextPacket(), {
      expected: {
        workPacketHash: "c".repeat(64),
        privacyScopeHash: "d".repeat(64),
        redactionPolicyRevision: "redaction-3",
        allowedDisclosureClasses: ["local_sensitive"],
      },
    });
    expect(result.errors.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "STALE_WORK_PACKET",
        "STALE_PRIVACY_SCOPE",
        "STALE_REDACTION_POLICY",
        "DISCLOSURE_NOT_ALLOWED",
      ]),
    );
  });
});

describe("versioned schemas, fixtures, and compatibility baseline", () => {
  const packageRoot = join(__dirname, "..");
  const requiredFixtureIds = [
    "valid-minimal",
    "valid-full",
    "canonical-hash",
    "retry-identical",
    "identity-conflict",
    "unknown-advisory-roundtrip",
    "unknown-consequential-reject",
    "stale-authority-reject",
    "wrong-capability-digest",
    "privacy-redaction",
    "malformed-missing-required",
  ];

  test("materializes one v1 JSON schema for every public contract", () => {
    const schemaFiles = readdirSync(join(packageRoot, "schemas", "v1"))
      .filter((file) => file.endsWith(".schema.json"));
    expect(schemaFiles).toHaveLength(11);
    for (const schemaId of Object.keys(require("../index.js").CONTRACTS)) {
      const file = `${schemaId.replace("forge.memory.", "").replace(".v1", "")}.schema.json`;
      const schema = JSON.parse(readFileSync(join(packageRoot, "schemas", "v1", file), "utf8"));
      expect(schema.$id).toBe(schemaId);
      expect(schema.properties.schema_id.const).toBe(schemaId);
      expect(schema).toEqual(generateJsonSchema(schemaId));
    }
  });

  test("exposes every required executable fixture id", () => {
    for (const fixtureId of requiredFixtureIds) {
      expect(existsSync(join(packageRoot, "fixtures", "v1", `${fixtureId}.json`))).toBe(true);
    }
  });

  test("accepts exact v1 readers and rejects unadvertised versions", () => {
    for (const schemaId of Object.keys(require("../index.js").CONTRACTS)) {
      expect(supportedSchemaVersions(schemaId)).toEqual([1]);
    }
    expect(supportedSchemaVersions("forge.memory.unknown.v1")).toEqual([]);
  });

  test("verifies every recorded schema and fixture digest", () => {
    expect(verifyContractBaseline()).toEqual({ ok: true, mismatches: [] });
  });
});
