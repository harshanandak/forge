"use strict";

const {
  computeContentHash,
  semanticIdentity,
  validateContract,
  validateContractStructure,
} = require("@forge/memory-contracts");

const TERMINAL_STATUSES = new Set(["PASS", "FAIL", "INCOMPLETE"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

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

function validateExecutionContext(executionContext) {
  try {
    for (const field of ["objectId", "runId", "attemptId", "startedAt", "endedAt", "producerInstanceId"]) {
      requiredString(executionContext[field], field);
    }
    if (!UUID.test(executionContext.objectId)) throw new TypeError("objectId is invalid");
    for (const field of ["startedAt", "endedAt"]) {
      const value = executionContext[field];
      if (!RFC3339_UTC.test(value) || Number.isNaN(Date.parse(value))) throw new TypeError(`${field} is invalid`);
    }
    if (Date.parse(executionContext.endedAt) < Date.parse(executionContext.startedAt)) {
      throw new TypeError("endedAt precedes startedAt");
    }
    const leaseEpoch = executionContext.expected?.leaseEpoch;
    if (leaseEpoch !== undefined && (!Number.isInteger(leaseEpoch) || leaseEpoch < 1)) {
      throw new TypeError("leaseEpoch is invalid");
    }
  } catch (error) {
    throw new FlowExecutionError("INVALID_EXECUTION_CONTEXT", `Invalid execution context: ${error.message}`);
  }
}

function incompleteProviderResult(code) {
  return {
    status: "INCOMPLETE",
    executor: { product_id: "forge-flow", mode: "injected-provider" },
    evidenceRefs: [],
    validation: { status: "INCOMPLETE", code },
    cleanup: { status: "UNKNOWN" },
    mutationsAttempted: [],
    mutationsAuthorized: [],
  };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isOptionalNonNegativeInteger(value) {
  return value === undefined || (Number.isInteger(value) && value >= 0);
}

function normalizeProviderResult(result, failure) {
  if (failure) return incompleteProviderResult("PROVIDER_FAILURE");
  try {
    const cloned = structuredClone(result);
    const valid = isRecord(cloned)
      && TERMINAL_STATUSES.has(cloned.status)
      && isRecord(cloned.executor)
      && Array.isArray(cloned.evidenceRefs)
      && cloned.evidenceRefs.every(isRecord)
      && isRecord(cloned.validation)
      && isRecord(cloned.cleanup)
      && isStringArray(cloned.mutationsAttempted)
      && isStringArray(cloned.mutationsAuthorized)
      && (cloned.tokens === undefined || isRecord(cloned.tokens))
      && isOptionalNonNegativeInteger(cloned.retries)
      && isOptionalNonNegativeInteger(cloned.corrections)
      && isOptionalNonNegativeInteger(cloned.activeTimeMs)
      && isOptionalNonNegativeInteger(cloned.passiveTimeMs);
    if (!valid) return incompleteProviderResult("INVALID_PROVIDER_RESULT");
    return cloned;
  } catch {
    return incompleteProviderResult("INVALID_PROVIDER_RESULT");
  }
}

function authorizeAndClassify(result, allowedMutations) {
  const allowed = new Set(allowedMutations);
  const attempted = new Set(result.mutationsAttempted);
  const authorized = new Set(result.mutationsAuthorized);
  const unauthorized = [...attempted, ...authorized].filter((mutation) => !allowed.has(mutation));
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
  const inconsistent = [...attempted].some((mutation) => !authorized.has(mutation))
    || [...authorized].some((mutation) => !attempted.has(mutation));
  if (inconsistent) {
    result.status = "FAIL";
    result.validation = { status: "REJECTED", code: "INCONSISTENT_AUTHORIZATION" };
    return;
  }
  const incompletePass = result.status === "PASS"
    && (result.evidenceRefs.length === 0 || result.validation.status !== "PASS");
  const incompleteFail = result.status === "FAIL"
    && (result.evidenceRefs.length === 0 || result.validation.status !== "FAIL");
  if (incompletePass || incompleteFail) {
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
      validateExecutionContext(executionContext);
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
      let result = normalizeProviderResult(providerResult, providerFailure);
      authorizeAndClassify(result, workPacket.payload.allowed_mutations);
      let receipt;
      try {
        receipt = buildReceipt(workPacket, executionContext, result);
      } catch (error) {
        if (!(error instanceof FlowExecutionError) || error.code !== "OUTPUT_INVALID") throw error;
        result = incompleteProviderResult("INVALID_PROVIDER_RESULT");
        receipt = buildReceipt(workPacket, executionContext, result);
      }
      acceptedPackets.set(identity, { packetHash: workPacket.content_hash, receipt: structuredClone(receipt) });
      try {
        onReceipt(structuredClone(receipt));
      } catch {
        // Receipt observation is secondary and cannot change the accepted execution result.
      }
      return receipt;
    },
  });
}

module.exports = { FlowExecutionError, createWorkPacketExecutor };
