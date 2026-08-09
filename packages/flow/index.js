"use strict";

const { computeContentHash, validateContract } = require("@forge/memory-contracts");

function requiredString(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function createRunReceiptSkeleton(workPacket, options = {}) {
  const packetValidation = validateContract(workPacket);
  if (!packetValidation.ok || workPacket.schema_id !== "forge.memory.work-packet.v1") {
    throw new TypeError("WorkPacket is invalid");
  }

  const objectId = requiredString(options, "objectId");
  const runId = requiredString(options, "runId");
  const attemptId = requiredString(options, "attemptId");
  const createdAt = requiredString(options, "createdAt");
  const producerInstanceId = requiredString(options, "producerInstanceId");
  const payload = workPacket.payload;
  const receipt = {
    schema_id: "forge.memory.run-receipt.v1",
    schema_version: 1,
    object_id: objectId,
    created_at: createdAt,
    producer: {
      product_id: "forge-flow",
      product_version: "0.1.0-beta.6",
      instance_id: producerInstanceId,
    },
    capabilities_used: [],
    provenance: {
      source_kind: "flow-boundary",
      actor_class: "system",
      actor_id: producerInstanceId,
    },
    payload: {
      packet_hash: workPacket.content_hash,
      run_id: runId,
      attempt_id: attemptId,
      exact_head: payload.target_head,
      packet_revision: payload.packet_revision,
      manifest_digest: payload.capability_manifest_digest,
      workflow_config_revision: payload.workflow_config_revision,
      status: "NOT_EXECUTED",
      executor: { product_id: "forge-flow", mode: "contract-boundary" },
      started_at: createdAt,
      ended_at: createdAt,
      evidence_refs: [],
      validation: { status: "NOT_RUN" },
      cleanup: { status: "NOT_REQUIRED" },
    },
    extensions: {},
  };
  receipt.content_hash = computeContentHash(receipt);
  return receipt;
}

module.exports = { createRunReceiptSkeleton };
