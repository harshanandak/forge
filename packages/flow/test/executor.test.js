"use strict";

const { beforeAll, describe, expect, mock, test } = require("bun:test");
const contracts = require("../../memory-contracts");

mock.module("@forge/memory-contracts", () => contracts);

const { computeContentHash, validateContractStructure } = contracts;
let FlowExecutionError;
let createWorkPacketExecutor;

beforeAll(() => {
  ({ FlowExecutionError, createWorkPacketExecutor } = require("../src/executor.js"));
});

function packet() {
  const value = {
    schema_id: "forge.memory.work-packet.v1",
    schema_version: 1,
    object_id: "00000000-0000-4000-8000-000000000001",
    created_at: "2026-08-09T12:00:00.000Z",
    producer: { product_id: "forge-memory", product_version: "0.1.0-beta.6", instance_id: "memory-1" },
    capabilities_used: [],
    provenance: { source_kind: "kernel", actor_class: "system", actor_id: "memory-1" },
    payload: {
      issue_id: "issue-1",
      expected_issue_revision: 3,
      packet_id: "packet-1",
      packet_revision: 1,
      repository_id: "github.com/example/forge",
      target_head: "a".repeat(40),
      objective: "execute the bounded task",
      authority: { kind: "kernel", issue_revision: 3 },
      allowed_mutations: ["packages/flow"],
      workflow_config_revision: "config-1",
      capability_manifest_digest: "c".repeat(64),
    },
    extensions: {},
  };
  value.content_hash = computeContentHash(value);
  return value;
}

function context(overrides = {}) {
  return {
    expected: {
      issueRevision: 3,
      workflowConfigRevision: "config-1",
      capabilityManifestDigest: "c".repeat(64),
      exactHead: "a".repeat(40),
    },
    objectId: "00000000-0000-4000-8000-000000000006",
    runId: "run-1",
    attemptId: "attempt-1",
    startedAt: "2026-08-09T12:01:00.000Z",
    endedAt: "2026-08-09T12:02:00.000Z",
    producerInstanceId: "flow-1",
    ...overrides,
  };
}

function successfulResult(overrides = {}) {
  return {
    status: "PASS",
    executor: { product_id: "forge-flow", mode: "in-memory" },
    evidenceRefs: [{ artifact_digest: "d".repeat(64) }],
    validation: { status: "PASS" },
    cleanup: { status: "PASS" },
    mutationsAttempted: ["packages/flow"],
    mutationsAuthorized: ["packages/flow"],
    ...overrides,
  };
}

describe("WorkPacket executor", () => {
  test("validates input and emits exactly one contract-valid terminal receipt", () => {
    const emitted = [];
    const executor = createWorkPacketExecutor({
      run: () => successfulResult(),
      onReceipt: (receipt) => emitted.push(receipt),
    });

    const receipt = executor.execute(packet(), context());

    expect(receipt.payload).toMatchObject({
      status: "PASS",
      packet_hash: packet().content_hash,
      exact_head: "a".repeat(40),
      manifest_digest: "c".repeat(64),
    });
    expect(validateContractStructure(receipt)).toEqual({ ok: true, errors: [] });
    expect(receipt.content_hash).toBe(computeContentHash(receipt));
    expect(emitted).toEqual([receipt]);
  });

  test("deduplicates an identical semantic packet without rerunning or re-emitting", () => {
    let runs = 0;
    let emissions = 0;
    const executor = createWorkPacketExecutor({
      run: () => {
        runs += 1;
        return successfulResult();
      },
      onReceipt: () => { emissions += 1; },
    });
    const workPacket = packet();

    const first = executor.execute(workPacket, context());
    const retry = executor.execute(structuredClone(workPacket), context());

    expect(retry).toEqual(first);
    expect(runs).toBe(1);
    expect(emissions).toBe(1);
  });

  test("fails closed when the same packet identity carries different content", () => {
    let runs = 0;
    const executor = createWorkPacketExecutor({ run: () => { runs += 1; return successfulResult(); } });
    executor.execute(packet(), context());
    const conflicting = packet();
    conflicting.payload.objective = "different objective";
    conflicting.content_hash = computeContentHash(conflicting);

    expect(() => executor.execute(conflicting, context())).toThrow(FlowExecutionError);
    try {
      executor.execute(conflicting, context());
    } catch (error) {
      expect(error.code).toBe("IDENTITY_CONFLICT");
    }
    expect(runs).toBe(1);
  });

  test("rejects stale or incomplete live authority before execution", () => {
    let runs = 0;
    const executor = createWorkPacketExecutor({ run: () => { runs += 1; return successfulResult(); } });

    expect(() => executor.execute(packet(), context({
      expected: { issueRevision: 4 },
    }))).toThrow("WorkPacket validation failed");
    expect(runs).toBe(0);
  });

  test("fails closed in a validated receipt when a provider attempts an unauthorized mutation", () => {
    const executor = createWorkPacketExecutor({
      run: () => successfulResult({ mutationsAttempted: ["git.push"] }),
    });

    const receipt = executor.execute(packet(), context());

    expect(receipt.payload.status).toBe("FAIL");
    expect(receipt.payload.validation).toMatchObject({ code: "UNAUTHORIZED_MUTATION" });
    expect(validateContractStructure(receipt).ok).toBe(true);
  });

  test("downgrades PASS with incomplete evidence to INCOMPLETE", () => {
    const executor = createWorkPacketExecutor({
      run: () => successfulResult({ evidenceRefs: [], validation: { status: "NOT_RUN" } }),
    });

    const receipt = executor.execute(packet(), context());

    expect(receipt.payload.status).toBe("INCOMPLETE");
    expect(receipt.payload.validation).toMatchObject({ code: "INCOMPLETE_EVIDENCE" });
    expect(validateContractStructure(receipt).ok).toBe(true);
  });
});
