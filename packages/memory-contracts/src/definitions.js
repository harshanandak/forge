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

module.exports = { CONTRACTS };
