"use strict";

const { canonicalize, computeContentHash } = require("./canonical.js");
const { CONTRACTS } = require("./definitions.js");

function semanticIdentity(value) {
  const definition = CONTRACTS[value?.schema_id];
  if (!definition) throw new TypeError(`Unsupported schema_id: ${value?.schema_id}`);
  const identity = {};
  for (const field of definition.identity) {
    if (!Object.hasOwn(value.payload ?? {}, field)) {
      throw new TypeError(`Semantic identity requires payload.${field}`);
    }
    identity[field] = value.payload[field];
  }
  return `${value.schema_id}:${canonicalize(identity)}`;
}

function classifySemanticAttempt(accepted, candidate) {
  const acceptedIdentity = semanticIdentity(accepted);
  const candidateIdentity = semanticIdentity(candidate);
  if (acceptedIdentity !== candidateIdentity) {
    return { status: "new-identity", identity: candidateIdentity };
  }
  const acceptedHash = computeContentHash(accepted);
  const candidateHash = computeContentHash(candidate);
  if (acceptedHash === candidateHash) {
    return {
      status: "retry-identical",
      identity: candidateIdentity,
      content_hash: candidateHash,
    };
  }
  return {
    status: "identity-conflict",
    identity: candidateIdentity,
    accepted_hash: acceptedHash,
    candidate_hash: candidateHash,
  };
}

module.exports = { classifySemanticAttempt, semanticIdentity };
