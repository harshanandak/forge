"use strict";

const { canonicalize, computeContentHash, preflightCanonicalValue } = require("./canonical.js");
const {
  ABSOLUTE_USER_PATH_PATTERN,
  CONTRACTS,
  EXTENSION_ID_MAX_LENGTH,
  EXTENSION_ID_PATTERN,
  PAYLOAD_FIELDS,
  SECRET_PATTERN: SECRET_PATTERN_SOURCE,
} = require("./definitions.js");

function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

const ENVELOPE_FIELDS = Object.freeze([
  "schema_id", "schema_version", "object_id", "created_at", "producer",
  "capabilities_used", "provenance", "content_hash", "payload", "extensions",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const LIVE_EVIDENCE_FIELDS = Object.freeze({
  "forge.memory.work-packet.v1": ["issueRevision", "workflowConfigRevision", "capabilityManifestDigest", "exactHead"],
  "forge.memory.context-packet.v1": ["workPacketHash", "privacyScopeHash", "redactionPolicyRevision", "allowedDisclosureClasses"],
  "forge.memory.claim-request.v1": ["issueRevision", "actorId"],
  "forge.memory.lease-receipt.v1": ["issueRevision", "actorId", "leaseEpoch", "observedAt"],
  "forge.memory.capability-manifest.v1": ["providerId", "configRevision", "observedAt"],
  "forge.memory.run-receipt.v1": ["packetHash", "workflowConfigRevision", "capabilityManifestDigest", "exactHead"],
  "forge.memory.feedback-report.v1": ["consentEventId", "redactionPolicyRevision"],
  "forge.memory.structured-error.v1": ["parentObjectHash"],
  "forge.memory.monitor-event.v1": ["monitorId", "subjectRevision"],
  "forge.memory.delivery-receipt.v1": ["eventId", "target"],
  "forge.memory.monitor-receipt.v1": ["monitorId", "ownerRunId"],
});
const LIVE_EVIDENCE_COMPARISONS = Object.freeze({
  "forge.memory.work-packet.v1": [
    ["expected_issue_revision", "issueRevision", "STALE_ISSUE_REVISION"],
    ["workflow_config_revision", "workflowConfigRevision", "STALE_WORKFLOW_CONFIG"],
    ["capability_manifest_digest", "capabilityManifestDigest", "WRONG_CAPABILITY_DIGEST"],
    ["target_head", "exactHead", "STALE_EXACT_HEAD"],
  ],
  "forge.memory.context-packet.v1": [
    ["work_packet_hash", "workPacketHash", "STALE_WORK_PACKET"],
    ["privacy_scope_hash", "privacyScopeHash", "STALE_PRIVACY_SCOPE"],
    ["redaction_policy_revision", "redactionPolicyRevision", "STALE_REDACTION_POLICY"],
  ],
  "forge.memory.run-receipt.v1": [
    ["packet_hash", "packetHash", "STALE_WORK_PACKET"],
    ["workflow_config_revision", "workflowConfigRevision", "STALE_WORKFLOW_CONFIG"],
    ["manifest_digest", "capabilityManifestDigest", "WRONG_CAPABILITY_DIGEST"],
    ["exact_head", "exactHead", "STALE_EXACT_HEAD"],
    ["lease_epoch", "leaseEpoch", "STALE_LEASE_EPOCH"],
  ],
  "forge.memory.claim-request.v1": [
    ["expected_issue_revision", "issueRevision", "STALE_ISSUE_REVISION"],
    ["actor_id", "actorId", "STALE_ACTOR"],
  ],
  "forge.memory.lease-receipt.v1": [
    ["issue_revision", "issueRevision", "STALE_ISSUE_REVISION"],
    ["actor_id", "actorId", "STALE_ACTOR"],
    ["lease_epoch", "leaseEpoch", "STALE_LEASE_EPOCH"],
  ],
  "forge.memory.capability-manifest.v1": [
    ["provider_id", "providerId", "STALE_PROVIDER"],
    ["config_revision", "configRevision", "STALE_CAPABILITY_CONFIG"],
  ],
  "forge.memory.feedback-report.v1": [
    ["consent_event_id", "consentEventId", "STALE_CONSENT"],
    ["redaction_policy_revision", "redactionPolicyRevision", "STALE_REDACTION_POLICY"],
  ],
  "forge.memory.structured-error.v1": [["parent_object_hash", "parentObjectHash", "STALE_PARENT_OBJECT"]],
  "forge.memory.monitor-event.v1": [
    ["monitor_id", "monitorId", "STALE_MONITOR"],
    ["subject_revision", "subjectRevision", "STALE_SUBJECT"],
  ],
  "forge.memory.delivery-receipt.v1": [
    ["event_id", "eventId", "STALE_EVENT"],
    ["target", "target", "STALE_DELIVERY_TARGET"],
  ],
  "forge.memory.monitor-receipt.v1": [
    ["monitor_id", "monitorId", "STALE_MONITOR"],
    ["owner_run_id", "ownerRunId", "STALE_OWNER_RUN"],
  ],
});
const STALE_EXPIRY_CODES = Object.freeze({
  "forge.memory.lease-receipt.v1": "STALE_LEASE",
  "forge.memory.capability-manifest.v1": "STALE_CAPABILITY_MANIFEST",
});
const EXTENSION_ID = new RegExp(EXTENSION_ID_PATTERN);
const SECRET_PATTERN = new RegExp(SECRET_PATTERN_SOURCE, "i");
const ABSOLUTE_USER_PATH = new RegExp(ABSOLUTE_USER_PATH_PATTERN, "i");
const BOUNDED_LIMITS = Object.freeze({ maxDepth: 8, maxItems: 128, maxProperties: 64, maxBytes: 16_384 });

function error(errors, path, code) {
  errors.push({ path, code });
}

function validateStringFields(value, path, fields, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    error(errors, path, "INVALID_TYPE");
    return;
  }
  for (const field of fields) {
    if (typeof value[field] !== "string" || value[field].length === 0) error(errors, `${path}.${field}`, "MISSING_REQUIRED");
  }
}

function validateCapabilitiesUsed(capabilities, errors) {
  if (!Array.isArray(capabilities)) {
    error(errors, "$.capabilities_used", "INVALID_TYPE");
    return;
  }
  const keys = capabilities.map((item) => `${item?.capability_id ?? ""}:${item?.manifest_digest ?? ""}`);
  if (capabilities.some((item) => !item || typeof item !== "object" || Array.isArray(item) || typeof item.capability_id !== "string" || item.capability_id.length === 0 || !SHA256.test(item.manifest_digest))) {
    error(errors, "$.capabilities_used", "INVALID_CAPABILITY_BINDING");
  }
  if (keys.join("\0") !== [...keys].sort(compareCodeUnits).join("\0")) error(errors, "$.capabilities_used", "NOT_SORTED");
}

function validateContentHashFormat(value, errors) {
  const valid = SHA256.test(value.content_hash);
  if (!valid) error(errors, "$.content_hash", "INVALID_CONTENT_HASH");
  return valid;
}

function verifyContentHash(value, verifyHash, errors) {
  if (!verifyHash) return;
  try {
    if (computeContentHash(value) !== value.content_hash) error(errors, "$.content_hash", "CONTENT_HASH_MISMATCH");
  } catch {
    error(errors, "$", "NON_CANONICAL_VALUE");
  }
}

function validateEnvelope(value, options = {}) {
  const errors = [];
  try {
    preflightCanonicalValue(value);
  } catch {
    return { ok: false, errors: [{ path: "$", code: "NON_CANONICAL_VALUE" }] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: [{ path: "$", code: "INVALID_ENVELOPE" }] };
  }
  for (const field of ENVELOPE_FIELDS) {
    if (!Object.hasOwn(value, field)) error(errors, `$.${field}`, "MISSING_REQUIRED");
  }
  if (errors.length > 0) return { ok: false, errors };
  if (!Object.hasOwn(CONTRACTS, value.schema_id)) error(errors, "$.schema_id", "UNSUPPORTED_SCHEMA");
  if (value.schema_version !== 1) error(errors, "$.schema_version", "UNSUPPORTED_VERSION");
  if (typeof value.schema_id !== "string" || value.schema_id.length === 0) error(errors, "$.schema_id", "INVALID_TYPE");
  if (!UUID.test(value.object_id)) error(errors, "$.object_id", "INVALID_UUID");
  if (typeof value.created_at !== "string" || !RFC3339_UTC.test(value.created_at) || Number.isNaN(Date.parse(value.created_at))) error(errors, "$.created_at", "INVALID_TIMESTAMP");
  validateStringFields(value.producer, "$.producer", ["product_id", "product_version", "instance_id"], errors);
  validateCapabilitiesUsed(value.capabilities_used, errors);
  validateStringFields(value.provenance, "$.provenance", ["source_kind", "actor_class", "actor_id"], errors);
  const validContentHash = validateContentHashFormat(value, errors);
  if (!value.payload || typeof value.payload !== "object" || Array.isArray(value.payload)) error(errors, "$.payload", "INVALID_TYPE");
  if (!value.extensions || typeof value.extensions !== "object" || Array.isArray(value.extensions)) error(errors, "$.extensions", "INVALID_TYPE");
  verifyContentHash(value, options.verifyHash !== false && validContentHash, errors);
  return { ok: errors.length === 0, errors };
}

function validateExtensions(extensions, errors) {
  if (!extensions || typeof extensions !== "object" || Array.isArray(extensions)) return;
  for (const [extensionId, extension] of Object.entries(extensions)) {
    const path = `$.extensions[${JSON.stringify(extensionId)}]`;
    if (extensionId.length > EXTENSION_ID_MAX_LENGTH || !EXTENSION_ID.test(extensionId)) error(errors, path, "INVALID_EXTENSION_ID");
    if (!extension || typeof extension !== "object" || Array.isArray(extension)) {
      error(errors, path, "INVALID_EXTENSION");
      continue;
    }
    if (extension.impact === "consequential") error(errors, path, "UNKNOWN_CONSEQUENTIAL_EXTENSION");
    const allowed = new Set(["impact", "schema_version", "value"]);
    const hasExtra = Object.keys(extension).some((field) => !allowed.has(field));
    if (extension.impact !== "advisory" || !Number.isInteger(extension.schema_version) || extension.schema_version < 1 || !Object.hasOwn(extension, "value") || hasExtra) error(errors, path, "INVALID_EXTENSION");
  }
}

function compare(errors, actual, expected, path, code) {
  if (expected !== undefined && actual !== expected) error(errors, path, code);
}

function isType(value, type) {
  if (type === "integer") return Number.isInteger(value);
  if (type === "array") return Array.isArray(value);
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  return typeof value === type;
}

function validateShapeConstraints(value, shape, path, errors) {
  if (shape.enum && !shape.enum.includes(value)) error(errors, path, "INVALID_ENUM");
  if (shape.minLength !== undefined && value.length < shape.minLength) error(errors, path, "INVALID_LENGTH");
  if (shape.maxLength !== undefined && value.length > shape.maxLength) error(errors, path, "BOUNDED_VALUE_TOO_LARGE");
  if (shape.minimum !== undefined && value < shape.minimum) error(errors, path, "OUT_OF_RANGE");
  if (shape.pattern && !new RegExp(shape.pattern).test(value)) error(errors, path, "INVALID_FORMAT");
  if (shape.not?.pattern && new RegExp(shape.not.pattern, "i").test(value)) error(errors, path, "PRIVACY_PATTERN_REJECTED");
  if (shape.format === "date-time" && (!RFC3339_UTC.test(value) || Number.isNaN(Date.parse(value)))) error(errors, path, "INVALID_TIMESTAMP");
}

function validateArrayShape(value, shape, path, errors) {
  if (shape.maxItems !== undefined && value.length > shape.maxItems) error(errors, path, "BOUNDED_VALUE_TOO_MANY_ITEMS");
  if (shape.items) value.forEach((item, index) => validateShape(item, shape.items, `${path}[${index}]`, errors));
}

function validateObjectShape(value, shape, path, errors) {
  if (shape.maxProperties !== undefined && Object.keys(value).length > shape.maxProperties) error(errors, path, "BOUNDED_VALUE_TOO_MANY_PROPERTIES");
  for (const field of shape.required ?? []) {
    if (!Object.hasOwn(value, field)) error(errors, `${path}.${field}`, "MISSING_REQUIRED");
  }
  for (const [field, fieldShape] of Object.entries(shape.properties ?? {})) {
    if (Object.hasOwn(value, field)) validateShape(value[field], fieldShape, `${path}.${field}`, errors);
  }
  if (shape.additionalProperties === false) {
    const allowed = new Set(Object.keys(shape.properties ?? {}));
    for (const field of Object.keys(value)) if (!allowed.has(field)) error(errors, `${path}.${field}`, "UNKNOWN_FIELD");
  }
}

function validateShape(value, shape, path, errors) {
  if (!isType(value, shape.type)) {
    error(errors, path, "INVALID_TYPE");
    return;
  }
  validateShapeConstraints(value, shape, path, errors);
  if (shape.type === "array") validateArrayShape(value, shape, path, errors);
  if (shape.type === "object") validateObjectShape(value, shape, path, errors);
}

function inspectPrivacyString(value, path, errors) {
  if (SECRET_PATTERN.test(value)) error(errors, path, "PRIVACY_SECRET_PATTERN");
  if (ABSOLUTE_USER_PATH.test(value)) error(errors, path, "PRIVACY_ABSOLUTE_PATH");
}

function inspectBoundedValue(value, path, errors, depth = 0) {
  if (depth > BOUNDED_LIMITS.maxDepth) {
    error(errors, path, "BOUNDED_VALUE_TOO_DEEP");
    return;
  }
  if (typeof value === "string") {
    inspectPrivacyString(value, path, errors);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > BOUNDED_LIMITS.maxItems) error(errors, path, "BOUNDED_VALUE_TOO_MANY_ITEMS");
    value.forEach((item, index) => inspectBoundedValue(item, `${path}[${index}]`, errors, depth + 1));
    return;
  }
  if (!value || typeof value !== "object") return;
  const entries = Object.entries(value);
  if (entries.length > BOUNDED_LIMITS.maxProperties) error(errors, path, "BOUNDED_VALUE_TOO_MANY_PROPERTIES");
  entries.forEach(([field, item]) => inspectBoundedValue(item, `${path}.${field}`, errors, depth + 1));
}

function boundedPrivacyTargets(value) {
  const payload = value?.payload;
  switch (value?.schema_id) {
    case "forge.memory.feedback-report.v1":
      return [
        [payload?.redacted_reproduction_steps, "$.payload.redacted_reproduction_steps"],
        [payload?.proposed_fix, "$.payload.proposed_fix"],
        [payload?.return_channel, "$.payload.return_channel"],
      ];
    case "forge.memory.context-packet.v1":
      return [[payload?.references, "$.payload.references"], [payload?.summaries, "$.payload.summaries"]];
    case "forge.memory.monitor-event.v1":
      return [[payload?.bounded_payload, "$.payload.bounded_payload"]];
    case "forge.memory.monitor-receipt.v1":
      return [[payload?.process_cleanup, "$.payload.process_cleanup"], [payload?.lease_cleanup, "$.payload.lease_cleanup"]];
    case "forge.memory.structured-error.v1":
      return [[payload?.safe_details, "$.payload.safe_details"]];
    case "forge.memory.run-receipt.v1":
      return [
        [payload?.validation, "$.payload.validation"],
        [payload?.cleanup, "$.payload.cleanup"],
        [payload?.structured_error, "$.payload.structured_error"],
      ];
    default:
      return [];
  }
}

function validateBoundedPrivacy(value, errors) {
  for (const [target, path] of boundedPrivacyTargets(value)) {
    if (target === undefined) continue;
    inspectBoundedValue(target, path, errors);
    try {
      canonicalize(target, { maxDepth: 64, maxNodes: 100_000, maxBytes: BOUNDED_LIMITS.maxBytes });
    } catch (error) {
      if (error.code === "CANONICAL_BYTE_LIMIT") errors.push({ path, code: "BOUNDED_VALUE_TOO_LARGE" });
    }
  }
}

function isStale(expiresAt, observedAt) {
  const expires = Date.parse(expiresAt);
  const observed = Date.parse(observedAt);
  return Number.isNaN(expires) || Number.isNaN(observed) || expires <= observed;
}

function validateConsequentialEvidence(value, expected, errors) {
  if (!value?.payload) return;
  if (value.schema_id === "forge.memory.run-receipt.v1" && value.payload.status === "NOT_EXECUTED") {
    error(errors, "$.payload.status", "NOT_EXECUTED_NO_TRANSITION");
  }
  const requiredEvidence = LIVE_EVIDENCE_FIELDS[value.schema_id] ?? [];
  for (const field of requiredEvidence) {
    if (!expected || !Object.hasOwn(expected, field)) error(errors, `$.live_expected.${field}`, "MISSING_LIVE_EVIDENCE");
  }
  if (!expected) return;
  const payload = value.payload;
  for (const [payloadField, expectedField, code] of LIVE_EVIDENCE_COMPARISONS[value.schema_id] ?? []) {
    compare(errors, payload[payloadField], expected[expectedField], `$.payload.${payloadField}`, code);
  }
  const staleCode = STALE_EXPIRY_CODES[value.schema_id];
  if (staleCode && isStale(payload.expires_at, expected.observedAt)) error(errors, "$.payload.expires_at", staleCode);
  if (value.schema_id === "forge.memory.context-packet.v1" && expected.allowedDisclosureClasses && !expected.allowedDisclosureClasses.includes(payload.disclosure_class)) {
    error(errors, "$.payload.disclosure_class", "DISCLOSURE_NOT_ALLOWED");
  }
}

function validatePayloadShape(value, errors) {
  const definition = Object.hasOwn(CONTRACTS, value?.schema_id) ? CONTRACTS[value.schema_id] : undefined;
  if (!definition || !value?.payload || typeof value.payload !== "object" || Array.isArray(value.payload)) return;
  for (const field of definition.required) {
    if (!Object.hasOwn(value.payload, field)) error(errors, `$.payload.${field}`, "MISSING_REQUIRED");
  }
  const allowed = new Set([...definition.required, ...definition.optional]);
  for (const field of Object.keys(value.payload)) {
    if (!allowed.has(field)) error(errors, `$.payload.${field}`, "UNKNOWN_PAYLOAD_FIELD");
    else validateShape(value.payload[field], PAYLOAD_FIELDS[value.schema_id][field], `$.payload.${field}`, errors);
  }
}

function validateContractStructure(value, options = {}) {
  const envelope = validateEnvelope(value, options);
  if (envelope.errors.some((item) => item.code === "NON_CANONICAL_VALUE")) return envelope;
  const errors = [...envelope.errors];
  validatePayloadShape(value, errors);
  validateExtensions(value?.extensions, errors);
  if (!errors.some((item) => item.code === "NON_CANONICAL_VALUE")) validateBoundedPrivacy(value, errors);
  return { ok: errors.length === 0, errors };
}

function validateContract(value, options = {}) {
  const structural = validateContractStructure(value, options);
  if (structural.errors.some((item) => item.code === "NON_CANONICAL_VALUE")) return structural;
  const errors = [...structural.errors];
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

module.exports = { ContractValidationError, ENVELOPE_FIELDS, parseContract, validateContract, validateContractStructure, validateEnvelope };
