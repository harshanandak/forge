"use strict";

const { describe, expect, mock, test } = require("bun:test");
const contracts = require("../memory-contracts");
mock.module("@forge/memory-contracts", () => contracts);
const { computeContentHash, validateContract } = contracts;
const { createRunReceiptSkeleton } = require(".");

function makeWorkPacket() {
  const packet = {
    schema_id: "forge.memory.work-packet.v1",
    schema_version: 1,
    object_id: "7b7a39c5-acde-41f2-90b7-f5edb653ff51",
    created_at: "2026-08-09T12:00:00.000Z",
    producer: {
      product_id: "forge-memory",
      product_version: "0.1.0-beta.6",
      instance_id: "memory-1",
    },
    capabilities_used: [],
    provenance: {
      source_kind: "kernel",
      actor_class: "agent",
      actor_id: "agent-1",
    },
    payload: {
      issue_id: "5037a7da-d49b-4015-a3fa-aac34425078e",
      expected_issue_revision: 1,
      packet_id: "packet-1",
      packet_revision: 1,
      repository_id: "github.com/harshanandak/forge",
      target_head: "a".repeat(40),
      objective: "prove the package boundary",
      authority: { kind: "kernel", issue_revision: 1 },
      allowed_mutations: [],
      workflow_config_revision: "config-1",
      capability_manifest_digest: "b".repeat(64),
    },
    extensions: {},
  };
  packet.content_hash = computeContentHash(packet);
  return packet;
}

describe("Flow contract boundary", () => {
  test("turns a valid WorkPacket into a contract-valid non-execution RunReceipt", () => {
    const packet = makeWorkPacket();
    const receipt = createRunReceiptSkeleton(packet, {
      objectId: "bb7cf5c2-8410-43d2-a309-c8b97e58d61d",
      runId: "run-1",
      attemptId: "attempt-1",
      createdAt: "2026-08-09T12:01:00.000Z",
      producerInstanceId: "flow-1",
    });

    expect(validateContract(receipt).ok).toBe(true);
    expect(receipt.payload).toMatchObject({
      packet_hash: packet.content_hash,
      exact_head: packet.payload.target_head,
      packet_revision: packet.payload.packet_revision,
      manifest_digest: packet.payload.capability_manifest_digest,
      workflow_config_revision: packet.payload.workflow_config_revision,
      status: "NOT_EXECUTED",
      evidence_refs: [],
    });
    expect(receipt.content_hash).toBe(computeContentHash(receipt));
  });

  test("fails closed for an invalid WorkPacket", () => {
    const packet = makeWorkPacket();
    packet.payload.target_head = "stale";

    expect(() => createRunReceiptSkeleton(packet, {
      objectId: "bb7cf5c2-8410-43d2-a309-c8b97e58d61d",
      runId: "run-1",
      attemptId: "attempt-1",
      createdAt: "2026-08-09T12:01:00.000Z",
      producerInstanceId: "flow-1",
    })).toThrow("WorkPacket is invalid");
  });
});
