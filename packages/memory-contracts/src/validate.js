"use strict";

const { canonicalize, computeContentHash, preflightCanonicalValue } = require("./canonical.js");
const { CONTRACTS, PAYLOAD_FIELDS } = require("./definitions.js");

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
const EXTENSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:[./][A-Za-z0-9][A-Za-z0-9_.-]*)+$/;
const SECRET_PATTERN = /(?:gh[pousr]_[A-Za-z0-9]{20,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S{8,})/;
const ABSOLUTE_USER_PATH = /(?:[A-Za-z]:\\Users\\[^\\\s]+|\/(?:Users|home)\/[^/\s]+\/)/;
const BOUNDED_LIMITS = Object.freeze({ maxDepth: 8, maxItems: 128, maxProperties: 64, maxBytes: 16_384 });

function error(errors, path, code) {
  errors.push({ path, code });
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
    if (value.capabilities_used.some((item) => !item || typeof item !== "object" || Array.isArray(item) || typeof item.capability_id !== "string" || item.capability_id.length === 0 || !SHA256.test(item.manifest_digest))) {
      error(errors, "$.capabilities_used", "INVALID_CAPABILITY_BINDING");
    }
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
    if (!EXTENSION_ID.test(extensionId)) error(errors, path, "INVALID_EXTENSION_ID");
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

function validateShape(value, shape, path, errors) {
  if (!isType(value, shape.type)) {
    error(errors, path, "INVALID_TYPE");
    return;
  }
  if (shape.enum && !shape.enum.includes(value)) error(errors, path, "INVALID_ENUM");
  if (shape.minLength !== undefined && value.length < shape.minLength) error(errors, path, "INVALID_LENGTH");
  if (shape.maxLength !== undefined && value.length > shape.maxLength) error(errors, path, "BOUNDED_VALUE_TOO_LARGE");
  if (shape.minimum !== undefined && value < shape.minimum) error(errors, path, "OUT_OF_RANGE");
  if (shape.pattern && !new RegExp(shape.pattern).test(value)) error(errors, path, "INVALID_FORMAT");
  if (shape.not?.pattern && new RegExp(shape.not.pattern).test(value)) error(errors, path, "PRIVACY_PATTERN_REJECTED");
  if (shape.format === "date-time" && (!RFC3339_UTC.test(value) || Number.isNaN(Date.parse(value)))) error(errors, path, "INVALID_TIMESTAMP");
  if (shape.type === "array" && shape.maxItems !== undefined && value.length > shape.maxItems) error(errors, path, "BOUNDED_VALUE_TOO_MANY_ITEMS");
  if (shape.type === "array" && shape.items) value.forEach((item, index) => validateShape(item, shape.items, `${path}[${index}]`, errors));
  if (shape.type === "object") {
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

function validateBoundedPrivacy(value, errors) {
  const targets = [];
  if (value?.schema_id === "forge.memory.feedback-report.v1") {
    targets.push([value.payload?.redacted_reproduction_steps, "$.payload.redacted_reproduction_steps"]);
    if (value.payload?.proposed_fix !== undefined) targets.push([value.payload.proposed_fix, "$.payload.proposed_fix"]);
  } else if (value?.schema_id === "forge.memory.monitor-event.v1" && value.payload?.bounded_payload !== undefined) {
    targets.push([value.payload.bounded_payload, "$.payload.bounded_payload"]);
  } else if (value?.schema_id === "forge.memory.monitor-receipt.v1") {
    targets.push([value.payload?.process_cleanup, "$.payload.process_cleanup"], [value.payload?.lease_cleanup, "$.payload.lease_cleanup"]);
  } else if (value?.schema_id === "forge.memory.structured-error.v1") {
    targets.push([value.payload?.safe_details, "$.payload.safe_details"]);
  } else if (value?.schema_id === "forge.memory.run-receipt.v1") {
    targets.push(
      [value.payload?.validation, "$.payload.validation"],
      [value.payload?.cleanup, "$.payload.cleanup"],
    );
    if (value.payload?.structured_error !== undefined) targets.push([value.payload.structured_error, "$.payload.structured_error"]);
  }
  for (const [target, path] of targets) {
    if (target === undefined) continue;
    inspectBoundedValue(target, path, errors);
    try {
      canonicalize(target, { maxDepth: 64, maxNodes: 100_000, maxBytes: BOUNDED_LIMITS.maxBytes });
    } catch (failure) {
      if (failure.code === "CANONICAL_BYTE_LIMIT") error(errors, path, "BOUNDED_VALUE_TOO_LARGE");
    }
  }
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
  } else if (value.schema_id === "forge.memory.claim-request.v1") {
    compare(errors, payload.expected_issue_revision, expected.issueRevision, "$.payload.expected_issue_revision", "STALE_ISSUE_REVISION");
    compare(errors, payload.actor_id, expected.actorId, "$.payload.actor_id", "STALE_ACTOR");
  } else if (value.schema_id === "forge.memory.lease-receipt.v1") {
    compare(errors, payload.issue_revision, expected.issueRevision, "$.payload.issue_revision", "STALE_ISSUE_REVISION");
    compare(errors, payload.actor_id, expected.actorId, "$.payload.actor_id", "STALE_ACTOR");
    compare(errors, payload.lease_epoch, expected.leaseEpoch, "$.payload.lease_epoch", "STALE_LEASE_EPOCH");
    if (Date.parse(payload.expires_at) <= Date.parse(expected.observedAt)) error(errors, "$.payload.expires_at", "STALE_LEASE");
  } else if (value.schema_id === "forge.memory.capability-manifest.v1") {
    compare(errors, payload.provider_id, expected.providerId, "$.payload.provider_id", "STALE_PROVIDER");
    compare(errors, payload.config_revision, expected.configRevision, "$.payload.config_revision", "STALE_CAPABILITY_CONFIG");
    if (Date.parse(payload.expires_at) <= Date.parse(expected.observedAt)) error(errors, "$.payload.expires_at", "STALE_CAPABILITY_MANIFEST");
  } else if (value.schema_id === "forge.memory.feedback-report.v1") {
    compare(errors, payload.consent_event_id, expected.consentEventId, "$.payload.consent_event_id", "STALE_CONSENT");
    compare(errors, payload.redaction_policy_revision, expected.redactionPolicyRevision, "$.payload.redaction_policy_revision", "STALE_REDACTION_POLICY");
  } else if (value.schema_id === "forge.memory.structured-error.v1") {
    compare(errors, payload.parent_object_hash, expected.parentObjectHash, "$.payload.parent_object_hash", "STALE_PARENT_OBJECT");
  } else if (value.schema_id === "forge.memory.monitor-event.v1") {
    compare(errors, payload.monitor_id, expected.monitorId, "$.payload.monitor_id", "STALE_MONITOR");
    compare(errors, payload.subject_revision, expected.subjectRevision, "$.payload.subject_revision", "STALE_SUBJECT");
  } else if (value.schema_id === "forge.memory.delivery-receipt.v1") {
    compare(errors, payload.event_id, expected.eventId, "$.payload.event_id", "STALE_EVENT");
    compare(errors, payload.target, expected.target, "$.payload.target", "STALE_DELIVERY_TARGET");
  } else if (value.schema_id === "forge.memory.monitor-receipt.v1") {
    compare(errors, payload.monitor_id, expected.monitorId, "$.payload.monitor_id", "STALE_MONITOR");
    compare(errors, payload.owner_run_id, expected.ownerRunId, "$.payload.owner_run_id", "STALE_OWNER_RUN");
  }
}

function validateContractStructure(value, options = {}) {
  const envelope = validateEnvelope(value, options);
  if (envelope.errors.some((item) => item.code === "NON_CANONICAL_VALUE")) return envelope;
  const errors = [...envelope.errors];
  const definition = CONTRACTS[value?.schema_id];
  if (definition && value?.payload && typeof value.payload === "object" && !Array.isArray(value.payload)) {
    for (const field of definition.required) {
      if (!Object.hasOwn(value.payload, field)) error(errors, `$.payload.${field}`, "MISSING_REQUIRED");
    }
    const allowed = new Set([...definition.required, ...definition.optional]);
    for (const field of Object.keys(value.payload)) {
      if (!allowed.has(field)) error(errors, `$.payload.${field}`, "UNKNOWN_PAYLOAD_FIELD");
      else validateShape(value.payload[field], PAYLOAD_FIELDS[value.schema_id][field], `$.payload.${field}`, errors);
    }
  }
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
