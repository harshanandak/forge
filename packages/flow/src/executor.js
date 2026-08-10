"use strict";

const {
  computeContentHash,
  semanticIdentity,
  validateContract,
  validateContractStructure,
} = require("@forge/memory-contracts");

const TERMINAL_STATUSES = new Set(["PASS", "FAIL", "INCOMPLETE"]);

class FlowExecutionError extends Error {
  constructor(code, message, details = []) {
    super(message);
    this.name = "FlowExecutionError";
    this.code = code;
    this.details = details;
  }
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new FlowExecutionError("INVALID_EXECUTION_CONTEXT", `${name} must be a non-empty string`);
  }
  return value;
}

function assertPacket(workPacket, expected) {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    throw new FlowExecutionError("INPUT_INVALID", "WorkPacket validation failed", [
      { path: "$.live_expected", code: "MISSING_LIVE_EVIDENCE" },
    ]);
  }
  const validation = validateContract(workPacket, { expected });
  if (workPacket?.schema_id !== "forge.memory.work-packet.v1" || !validation.ok) {
    throw new FlowExecutionError("INPUT_INVALID", "WorkPacket validation failed", validation.errors);
  }
}

function normalizeProviderResult(result, failure) {
  if (failure) {
    return {
      status: "INCOMPLETE",
      executor: { product_id: "forge-flow", mode: "injected-provider" },
      evidenceRefs: [],
      validation: { status: "INCOMPLETE", code: "PROVIDER_FAILURE" },
      cleanup: { status: "UNKNOWN" },
      mutationsAttempted: [],
      mutationsAuthorized: [],
    };
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return {
      status: "INCOMPLETE",
      executor: { product_id: "forge-flow", mode: "injected-provider" },
      evidenceRefs: [],
      validation: { status: "INCOMPLETE", code: "INVALID_PROVIDER_RESULT" },
      cleanup: { status: "UNKNOWN" },
      mutationsAttempted: [],
      mutationsAuthorized: [],
    };
  }
  return {
    status: TERMINAL_STATUSES.has(result.status) ? result.status : "INCOMPLETE",
    executor: result.executor && typeof result.executor === "object" && !Array.isArray(result.executor)
      ? structuredClone(result.executor)
      : { product_id: "forge-flow", mode: "injected-provider" },
    evidenceRefs: Array.isArray(result.evidenceRefs) ? structuredClone(result.evidenceRefs) : [],
    validation: result.validation && typeof result.validation === "object" && !Array.isArray(result.validation)
      ? structuredClone(result.validation)
      : { status: "INCOMPLETE", code: "MISSING_VALIDATION" },
    cleanup: result.cleanup && typeof result.cleanup === "object" && !Array.isArray(result.cleanup)
      ? structuredClone(result.cleanup)
      : { status: "UNKNOWN" },
    mutationsAttempted: Array.isArray(result.mutationsAttempted) ? [...result.mutationsAttempted] : [],
    mutationsAuthorized: Array.isArray(result.mutationsAuthorized) ? [...result.mutationsAuthorized] : [],
    tokens: result.tokens,
    retries: result.retries,
    corrections: result.corrections,
    activeTimeMs: result.activeTimeMs,
    passiveTimeMs: result.passiveTimeMs,
  };
}

function authorizeAndClassify(result, allowedMutations) {
  const allowed = new Set(allowedMutations);
  const unauthorized = result.mutationsAttempted.filter((mutation) => !allowed.has(mutation));
  if (unauthorized.length > 0) {
    result.status = "FAIL";
    result.validation = {
      status: "REJECTED",
      code: "UNAUTHORIZED_MUTATION",
      unauthorized_count: unauthorized.length,
    };
    result.mutationsAuthorized = result.mutationsAuthorized.filter((mutation) => allowed.has(mutation));
    return;
  }
  if (result.status === "PASS" && (result.evidenceRefs.length === 0 || result.validation.status !== "PASS")) {
    result.status = "INCOMPLETE";
    result.validation = { status: "INCOMPLETE", code: "INCOMPLETE_EVIDENCE" };
  }
}

function optionalInteger(target, field, value, minimum = 0) {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < minimum) {
    throw new FlowExecutionError("OUTPUT_INVALID", `Provider result ${field} is invalid`);
  }
  target[field] = value;
}

function buildReceipt(workPacket, executionContext, result) {
  const startedAt = requiredString(executionContext.startedAt, "startedAt");
  const endedAt = requiredString(executionContext.endedAt, "endedAt");
  if (Date.parse(endedAt) < Date.parse(startedAt)) {
    throw new FlowExecutionError("INVALID_EXECUTION_CONTEXT", "endedAt must not precede startedAt");
  }
  const producerInstanceId = requiredString(executionContext.producerInstanceId, "producerInstanceId");
  const payload = {
    packet_hash: workPacket.content_hash,
    run_id: requiredString(executionContext.runId, "runId"),
    attempt_id: requiredString(executionContext.attemptId, "attemptId"),
    exact_head: workPacket.payload.target_head,
    packet_revision: workPacket.payload.packet_revision,
    manifest_digest: workPacket.payload.capability_manifest_digest,
    workflow_config_revision: workPacket.payload.workflow_config_revision,
    status: result.status,
    executor: result.executor,
    started_at: startedAt,
    ended_at: endedAt,
    evidence_refs: result.evidenceRefs,
    validation: result.validation,
    cleanup: result.cleanup,
    mutations_attempted: result.mutationsAttempted,
    mutations_authorized: result.mutationsAuthorized,
  };
  optionalInteger(payload, "lease_epoch", executionContext.expected.leaseEpoch, 1);
  optionalInteger(payload, "retries", result.retries);
  optionalInteger(payload, "corrections", result.corrections);
  optionalInteger(payload, "active_time_ms", result.activeTimeMs);
  optionalInteger(payload, "passive_time_ms", result.passiveTimeMs);
  if (result.tokens !== undefined) payload.tokens = structuredClone(result.tokens);

  const receipt = {
    schema_id: "forge.memory.run-receipt.v1",
    schema_version: 1,
    object_id: requiredString(executionContext.objectId, "objectId"),
    created_at: endedAt,
    producer: { product_id: "forge-flow", product_version: "0.1.0-beta.6", instance_id: producerInstanceId },
    capabilities_used: [],
    provenance: { source_kind: "execution", actor_class: "system", actor_id: producerInstanceId },
    payload,
    extensions: {},
  };
  receipt.content_hash = computeContentHash(receipt);

  const structural = validateContractStructure(receipt);
  const consequential = validateContract(receipt, {
    expected: {
      packetHash: workPacket.content_hash,
      workflowConfigRevision: workPacket.payload.workflow_config_revision,
      capabilityManifestDigest: workPacket.payload.capability_manifest_digest,
      exactHead: workPacket.payload.target_head,
      ...(executionContext.expected.leaseEpoch === undefined ? {} : { leaseEpoch: executionContext.expected.leaseEpoch }),
    },
  });
  if (!structural.ok || !consequential.ok) {
    throw new FlowExecutionError("OUTPUT_INVALID", "RunReceipt validation failed", consequential.errors);
  }
  return receipt;
}

function createWorkPacketExecutor({ run, onReceipt = () => {} } = {}) {
  if (typeof run !== "function") throw new TypeError("run must be a function");
  if (typeof onReceipt !== "function") throw new TypeError("onReceipt must be a function");
  const acceptedPackets = new Map();

  return Object.freeze({
    execute(workPacket, executionContext = {}) {
      assertPacket(workPacket, executionContext.expected);
      const identity = semanticIdentity(workPacket);
      const accepted = acceptedPackets.get(identity);
      if (accepted) {
        if (accepted.packetHash !== workPacket.content_hash) {
          throw new FlowExecutionError("IDENTITY_CONFLICT", "WorkPacket identity conflict");
        }
        return structuredClone(accepted.receipt);
      }

      let providerResult;
      let providerFailure;
      try {
        providerResult = run(structuredClone(workPacket));
        if (providerResult && typeof providerResult.then === "function") {
          throw new TypeError("run must be synchronous");
        }
      } catch (error) {
        providerFailure = error;
      }
      const result = normalizeProviderResult(providerResult, providerFailure);
      authorizeAndClassify(result, workPacket.payload.allowed_mutations);
      const receipt = buildReceipt(workPacket, executionContext, result);
      acceptedPackets.set(identity, { packetHash: workPacket.content_hash, receipt: structuredClone(receipt) });
      onReceipt(structuredClone(receipt));
      return receipt;
    },
  });
}

module.exports = { FlowExecutionError, createWorkPacketExecutor };
