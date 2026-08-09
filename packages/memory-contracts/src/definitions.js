"use strict";

const CONTRACTS = Object.freeze({
  "forge.memory.work-packet.v1": {
    name: "WorkPacket",
    identity: ["issue_id", "expected_issue_revision", "packet_id", "packet_revision", "repository_id", "target_head"],
    required: ["issue_id", "expected_issue_revision", "packet_id", "packet_revision", "repository_id", "target_head", "objective", "authority", "allowed_mutations", "workflow_config_revision", "capability_manifest_digest"],
    optional: ["acceptance_criteria", "prohibited_actions", "dependencies", "constraints", "risk", "platform", "context_references", "expected_outputs", "target", "receipt_requirements", "idempotency_key", "token_budget", "budget_metric", "risk_manifest_digest"],
  },
  "forge.memory.context-packet.v1": {
    name: "ContextPacket",
    identity: ["work_packet_hash", "context_selection_revision", "privacy_scope_hash"],
    required: ["work_packet_hash", "context_selection_revision", "privacy_scope_hash", "retention_class", "disclosure_class"],
    optional: ["references", "summaries", "redaction_policy_revision"],
  },
  "forge.memory.claim-request.v1": {
    name: "ClaimRequest",
    identity: ["issue_id", "expected_issue_revision", "actor_id", "request_id"],
    required: ["issue_id", "expected_issue_revision", "actor_id", "request_id", "requested_scope", "idempotency_key"],
    optional: [],
  },
  "forge.memory.lease-receipt.v1": {
    name: "LeaseReceipt",
    identity: ["claim_request_id", "lease_id", "lease_epoch"],
    required: ["claim_request_id", "lease_id", "lease_epoch", "issue_revision", "actor_id", "scope", "expires_at", "durable", "authority_signature"],
    optional: [],
  },
  "forge.memory.capability-manifest.v1": {
    name: "CapabilityManifest",
    identity: ["provider_id", "manifest_revision", "config_revision"],
    required: ["provider_id", "manifest_revision", "config_revision", "executable_identity", "provider_version", "probe_revision", "result_hash", "capabilities", "evaluator_status", "probed_at", "expires_at"],
    optional: [],
  },
  "forge.memory.run-receipt.v1": {
    name: "RunReceipt",
    identity: ["packet_hash", "run_id", "attempt_id", "exact_head"],
    required: ["packet_hash", "run_id", "attempt_id", "exact_head", "packet_revision", "manifest_digest", "workflow_config_revision", "status", "executor", "started_at", "ended_at", "evidence_refs", "validation", "cleanup"],
    optional: ["lease_epoch", "tokens", "retries", "corrections", "mutations_attempted", "mutations_authorized", "structured_error", "active_time_ms", "passive_time_ms"],
  },
  "forge.memory.feedback-report.v1": {
    name: "FeedbackReport",
    identity: ["report_id", "product_version", "content_fingerprint"],
    required: ["report_id", "product_version", "contract_version", "stable_error_code", "affected_capability", "redacted_reproduction_steps", "expected_classification", "actual_classification", "occurrence_count", "content_fingerprint", "consent_event_id", "redaction_policy_revision"],
    optional: ["proposed_fix", "return_channel"],
  },
  "forge.memory.structured-error.v1": {
    name: "StructuredError",
    identity: ["parent_object_hash", "error_occurrence_id"],
    required: ["parent_object_hash", "error_occurrence_id", "code", "terminal_classification", "safe_details"],
    optional: ["retryable", "evidence_refs"],
  },
  "forge.memory.monitor-event.v1": {
    name: "MonitorEvent",
    identity: ["monitor_id", "event_id", "sequence"],
    required: ["monitor_id", "event_id", "sequence", "subject_revision", "type", "actionability", "observed_at"],
    optional: ["bounded_payload", "artifact_digest"],
  },
  "forge.memory.delivery-receipt.v1": {
    name: "DeliveryReceipt",
    identity: ["event_id", "target", "attempt"],
    required: ["event_id", "target", "transport_tier", "attempt", "delivered_at", "acknowledged", "outcome"],
    optional: [],
  },
  "forge.memory.monitor-receipt.v1": {
    name: "MonitorReceipt",
    identity: ["monitor_id", "owner_run_id", "last_sequence"],
    required: ["monitor_id", "owner_run_id", "terminal_state", "terminal_reason", "last_sequence", "evidence_digest", "cancellation_acknowledged", "process_cleanup", "lease_cleanup"],
    optional: ["undelivered_cursor"],
  },
});

const STRING = Object.freeze({ type: "string", minLength: 1 });
const INTEGER = Object.freeze({ type: "integer", minimum: 0 });
const POSITIVE_INTEGER = Object.freeze({ type: "integer", minimum: 1 });
const BOOLEAN = Object.freeze({ type: "boolean" });
const OBJECT = Object.freeze({ type: "object" });
const STRING_ARRAY = Object.freeze({ type: "array", items: { type: "string" } });
const OBJECT_ARRAY = Object.freeze({ type: "array", items: { type: "object" } });
const HASH = Object.freeze({ type: "string", pattern: "^[0-9a-f]{64}$" });
const HEAD = Object.freeze({ type: "string", pattern: "^[0-9a-f]{40}(?:[0-9a-f]{24})?$" });
const TIMESTAMP = Object.freeze({ type: "string", format: "date-time" });

const PAYLOAD_FIELDS = Object.freeze({
  "forge.memory.work-packet.v1": {
    issue_id: STRING, expected_issue_revision: INTEGER, packet_id: STRING, packet_revision: POSITIVE_INTEGER,
    repository_id: STRING, target_head: HEAD, objective: STRING,
    authority: { type: "object", required: ["kind", "issue_revision"], properties: { kind: STRING, issue_revision: INTEGER } },
    allowed_mutations: STRING_ARRAY, workflow_config_revision: STRING, capability_manifest_digest: HASH,
    acceptance_criteria: STRING_ARRAY, prohibited_actions: STRING_ARRAY, dependencies: STRING_ARRAY,
    constraints: OBJECT, risk: OBJECT, platform: OBJECT, context_references: OBJECT_ARRAY,
    expected_outputs: STRING_ARRAY, target: OBJECT, receipt_requirements: OBJECT, idempotency_key: STRING,
    token_budget: POSITIVE_INTEGER, budget_metric: { type: "string", enum: ["provider_reported_total_tokens"] }, risk_manifest_digest: HASH,
  },
  "forge.memory.context-packet.v1": {
    work_packet_hash: HASH, context_selection_revision: POSITIVE_INTEGER, privacy_scope_hash: HASH,
    retention_class: { type: "string", enum: ["public_metadata", "local_sensitive", "remote_redacted", "restricted"] },
    disclosure_class: { type: "string", enum: ["public_metadata", "local_sensitive", "remote_redacted", "restricted"] },
    references: OBJECT_ARRAY, summaries: OBJECT_ARRAY, redaction_policy_revision: STRING,
  },
  "forge.memory.claim-request.v1": {
    issue_id: STRING, expected_issue_revision: INTEGER, actor_id: STRING, request_id: STRING,
    requested_scope: OBJECT, idempotency_key: STRING,
  },
  "forge.memory.lease-receipt.v1": {
    claim_request_id: STRING, lease_id: STRING, lease_epoch: POSITIVE_INTEGER, issue_revision: INTEGER,
    actor_id: STRING, scope: OBJECT, expires_at: TIMESTAMP, durable: BOOLEAN, authority_signature: STRING,
  },
  "forge.memory.capability-manifest.v1": {
    provider_id: STRING, manifest_revision: POSITIVE_INTEGER, config_revision: STRING,
    executable_identity: OBJECT, provider_version: STRING, probe_revision: STRING, result_hash: HASH,
    capabilities: { type: "array", items: { type: "object", required: ["capability_id", "available"], properties: { capability_id: STRING, available: BOOLEAN } } },
    evaluator_status: { type: "string", enum: ["approved", "unavailable", "quarantined"] }, probed_at: TIMESTAMP, expires_at: TIMESTAMP,
  },
  "forge.memory.run-receipt.v1": {
    packet_hash: HASH, run_id: STRING, attempt_id: STRING, exact_head: HEAD, packet_revision: POSITIVE_INTEGER,
    manifest_digest: HASH, workflow_config_revision: STRING, status: { type: "string", enum: ["PASS", "FAIL", "INCOMPLETE"] },
    executor: OBJECT, started_at: TIMESTAMP, ended_at: TIMESTAMP, evidence_refs: OBJECT_ARRAY, validation: OBJECT, cleanup: OBJECT,
    lease_epoch: POSITIVE_INTEGER, tokens: OBJECT, retries: INTEGER, corrections: INTEGER,
    mutations_attempted: STRING_ARRAY, mutations_authorized: STRING_ARRAY, structured_error: OBJECT,
    active_time_ms: INTEGER, passive_time_ms: INTEGER,
  },
  "forge.memory.feedback-report.v1": {
    report_id: STRING, product_version: STRING, contract_version: POSITIVE_INTEGER, stable_error_code: STRING,
    affected_capability: STRING, redacted_reproduction_steps: STRING_ARRAY, expected_classification: STRING,
    actual_classification: STRING, occurrence_count: POSITIVE_INTEGER, content_fingerprint: HASH,
    consent_event_id: STRING, redaction_policy_revision: STRING, proposed_fix: STRING, return_channel: OBJECT,
  },
  "forge.memory.structured-error.v1": {
    parent_object_hash: HASH, error_occurrence_id: STRING, code: STRING,
    terminal_classification: { type: "string", enum: ["FAIL", "INCOMPLETE"] }, safe_details: OBJECT,
    retryable: BOOLEAN, evidence_refs: OBJECT_ARRAY,
  },
  "forge.memory.monitor-event.v1": {
    monitor_id: STRING, event_id: STRING, sequence: INTEGER, subject_revision: STRING, type: STRING,
    actionability: { type: "string", enum: ["advisory", "action_required", "terminal"] }, observed_at: TIMESTAMP,
    bounded_payload: OBJECT, artifact_digest: HASH,
  },
  "forge.memory.delivery-receipt.v1": {
    event_id: STRING, target: STRING, transport_tier: { type: "string", enum: ["T0", "T1", "T2", "T3", "T4"] },
    attempt: POSITIVE_INTEGER, delivered_at: TIMESTAMP, acknowledged: BOOLEAN,
    outcome: { type: "string", enum: ["delivered", "pending", "failed", "acknowledged"] },
  },
  "forge.memory.monitor-receipt.v1": {
    monitor_id: STRING, owner_run_id: STRING,
    terminal_state: { type: "string", enum: ["PASS", "FAIL", "INCOMPLETE", "CANCELLED"] }, terminal_reason: STRING,
    last_sequence: INTEGER, evidence_digest: HASH, cancellation_acknowledged: BOOLEAN,
    process_cleanup: OBJECT, lease_cleanup: OBJECT, undelivered_cursor: INTEGER,
  },
});

module.exports = { CONTRACTS, PAYLOAD_FIELDS };
