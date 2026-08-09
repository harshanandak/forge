"use strict";

const { canonicalize, computeContentHash } = require("./src/canonical.js");
const { verifyContractBaseline } = require("./src/baseline.js");
const { CONTRACTS } = require("./src/definitions.js");
const { classifySemanticAttempt, semanticIdentity } = require("./src/identity.js");
const { generateJsonSchema, supportedSchemaVersions } = require("./src/schema.js");
const {
  ContractValidationError,
  ENVELOPE_FIELDS,
  parseContract,
  validateContract,
  validateContractStructure,
  validateEnvelope,
} = require("./src/validate.js");

module.exports = {
  ENVELOPE_FIELDS,
  CONTRACTS,
  ContractValidationError,
  canonicalize,
  classifySemanticAttempt,
  computeContentHash,
  generateJsonSchema,
  parseContract,
  semanticIdentity,
  supportedSchemaVersions,
  validateContract,
  validateContractStructure,
  validateEnvelope,
  verifyContractBaseline,
};
