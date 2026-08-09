"use strict";

const { computeContentHash } = require("./canonical.js");
const { CONTRACTS } = require("./definitions.js");

const ENVELOPE_FIELDS = Object.freeze([
  "schema_id", "schema_version", "object_id", "created_at", "producer",
  "capabilities_used", "provenance", "content_hash", "payload", "extensions",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function error(errors, path, code) {
  errors.push({ path, code });
}

function validateEnvelope(value, options = {}) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: [{ path: "$", code: "INVALID_ENVELOPE" }] };
  }
  for (const field of ENVELOPE_FIELDS) {
    if (!Object.hasOwn(value, field)) error(errors, `$.${field}`, "MISSING_REQUIRED");
  }
  if (errors.length > 0) return { ok: false, errors };
  if (!CONTRACTS[value.schema_id]) error(errors, "$.schema_id", "UNSUPPORTED_SCHEMA");
  if (value.schema_version !== 1) error(errors, "$.schema_version", "UNSUPPORTED_VERSION");
  if (typeof value.schema_id !== "string" || value.schema_id.length === 0) error(errors, "$.schema_id", "INVALID_TYPE");
  if (!UUID.test(value.object_id)) error(errors, "$.object_id", "INVALID_UUID");
  if (typeof value.created_at !== "string" || !RFC3339_UTC.test(value.created_at) || Number.isNaN(Date.parse(value.created_at))) error(errors, "$.created_at", "INVALID_TIMESTAMP");
  if (!value.producer || typeof value.producer !== "object" || Array.isArray(value.producer)) error(errors, "$.producer", "INVALID_TYPE");
  else for (const field of ["product_id", "product_version", "instance_id"]) if (typeof value.producer[field] !== "string" || value.producer[field].length === 0) error(errors, `$.producer.${field}`, "MISSING_REQUIRED");
  if (!Array.isArray(value.capabilities_used)) error(errors, "$.capabilities_used", "INVALID_TYPE");
  else {
    const keys = value.capabilities_used.map((item) => `${item?.capability_id ?? ""}:${item?.manifest_digest ?? ""}`);
    if (keys.some((key) => !key.includes(":" ) || key.startsWith(":"))) error(errors, "$.capabilities_used", "INVALID_CAPABILITY_BINDING");
    if (keys.join("\0") !== [...keys].sort().join("\0")) error(errors, "$.capabilities_used", "NOT_SORTED");
  }
  if (!value.provenance || typeof value.provenance !== "object" || Array.isArray(value.provenance)) error(errors, "$.provenance", "INVALID_TYPE");
  else for (const field of ["source_kind", "actor_class", "actor_id"]) if (typeof value.provenance[field] !== "string" || value.provenance[field].length === 0) error(errors, `$.provenance.${field}`, "MISSING_REQUIRED");
  if (!SHA256.test(value.content_hash)) error(errors, "$.content_hash", "INVALID_CONTENT_HASH");
  if (!value.payload || typeof value.payload !== "object" || Array.isArray(value.payload)) error(errors, "$.payload", "INVALID_TYPE");
  if (!value.extensions || typeof value.extensions !== "object" || Array.isArray(value.extensions)) error(errors, "$.extensions", "INVALID_TYPE");
  if (options.verifyHash !== false && SHA256.test(value.content_hash)) {
    try {
      if (computeContentHash(value) !== value.content_hash) error(errors, "$.content_hash", "CONTENT_HASH_MISMATCH");
    } catch {
      error(errors, "$", "NON_CANONICAL_VALUE");
    }
  }
  return { ok: errors.length === 0, errors };
}

function validateExtensions(extensions, errors) {
  if (!extensions || typeof extensions !== "object" || Array.isArray(extensions)) return;
  for (const [extensionId, extension] of Object.entries(extensions)) {
    const path = `$.extensions[${JSON.stringify(extensionId)}]`;
    if (!extension || typeof extension !== "object" || Array.isArray(extension)) {
      error(errors, path, "INVALID_EXTENSION");
      continue;
    }
    if (extension.impact === "consequential") error(errors, path, "UNKNOWN_CONSEQUENTIAL_EXTENSION");
    else if (extension.impact !== "advisory" || !Number.isInteger(extension.schema_version) || extension.schema_version < 1 || !Object.hasOwn(extension, "value")) error(errors, path, "INVALID_EXTENSION");
  }
}

function compare(errors, actual, expected, path, code) {
  if (expected !== undefined && actual !== expected) error(errors, path, code);
}

function validateConsequentialEvidence(value, expected, errors) {
  if (!expected || !value?.payload) return;
  const payload = value.payload;
  if (value.schema_id === "forge.memory.work-packet.v1") {
    compare(errors, payload.expected_issue_revision, expected.issueRevision, "$.payload.expected_issue_revision", "STALE_ISSUE_REVISION");
    compare(errors, payload.workflow_config_revision, expected.workflowConfigRevision, "$.payload.workflow_config_revision", "STALE_WORKFLOW_CONFIG");
    compare(errors, payload.capability_manifest_digest, expected.capabilityManifestDigest, "$.payload.capability_manifest_digest", "WRONG_CAPABILITY_DIGEST");
    compare(errors, payload.target_head, expected.exactHead, "$.payload.target_head", "STALE_EXACT_HEAD");
  } else if (value.schema_id === "forge.memory.context-packet.v1") {
    compare(errors, payload.work_packet_hash, expected.workPacketHash, "$.payload.work_packet_hash", "STALE_WORK_PACKET");
    compare(errors, payload.privacy_scope_hash, expected.privacyScopeHash, "$.payload.privacy_scope_hash", "STALE_PRIVACY_SCOPE");
    compare(errors, payload.redaction_policy_revision, expected.redactionPolicyRevision, "$.payload.redaction_policy_revision", "STALE_REDACTION_POLICY");
    if (expected.allowedDisclosureClasses && !expected.allowedDisclosureClasses.includes(payload.disclosure_class)) {
      error(errors, "$.payload.disclosure_class", "DISCLOSURE_NOT_ALLOWED");
    }
  } else if (value.schema_id === "forge.memory.run-receipt.v1") {
    compare(errors, payload.packet_hash, expected.packetHash, "$.payload.packet_hash", "STALE_WORK_PACKET");
    compare(errors, payload.workflow_config_revision, expected.workflowConfigRevision, "$.payload.workflow_config_revision", "STALE_WORKFLOW_CONFIG");
    compare(errors, payload.manifest_digest, expected.capabilityManifestDigest, "$.payload.manifest_digest", "WRONG_CAPABILITY_DIGEST");
    compare(errors, payload.exact_head, expected.exactHead, "$.payload.exact_head", "STALE_EXACT_HEAD");
    compare(errors, payload.lease_epoch, expected.leaseEpoch, "$.payload.lease_epoch", "STALE_LEASE_EPOCH");
  }
}

function validateContract(value, options = {}) {
  const envelope = validateEnvelope(value, options);
  const errors = [...envelope.errors];
  const definition = CONTRACTS[value?.schema_id];
  if (definition && value?.payload && typeof value.payload === "object" && !Array.isArray(value.payload)) {
    for (const field of definition.required) {
      if (!Object.hasOwn(value.payload, field)) error(errors, `$.payload.${field}`, "MISSING_REQUIRED");
    }
    const allowed = new Set([...definition.required, ...definition.optional]);
    for (const field of Object.keys(value.payload)) {
      if (!allowed.has(field)) error(errors, `$.payload.${field}`, "UNKNOWN_PAYLOAD_FIELD");
    }
  }
  validateExtensions(value?.extensions, errors);
  validateConsequentialEvidence(value, options.expected, errors);
  return { ok: errors.length === 0, errors };
}

class ContractValidationError extends Error {
  constructor(errors) {
    super("Contract validation failed");
    this.name = "ContractValidationError";
    this.errors = errors;
  }
}

function parseContract(json, options = {}) {
  const value = JSON.parse(json);
  const result = validateContract(value, options);
  if (!result.ok) throw new ContractValidationError(result.errors);
  return value;
}

module.exports = { ContractValidationError, ENVELOPE_FIELDS, parseContract, validateContract, validateEnvelope };
