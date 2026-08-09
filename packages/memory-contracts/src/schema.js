"use strict";

const { CONTRACTS } = require("./definitions.js");

function generateJsonSchema(schemaId) {
  const definition = CONTRACTS[schemaId];
  if (!definition) throw new TypeError(`Unsupported schema_id: ${schemaId}`);
  const payloadProperties = {};
  for (const field of [...definition.required, ...definition.optional]) payloadProperties[field] = {};
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: schemaId,
    title: definition.name,
    type: "object",
    required: ["schema_id", "schema_version", "object_id", "created_at", "producer", "capabilities_used", "provenance", "content_hash", "payload", "extensions"],
    properties: {
      schema_id: { const: schemaId },
      schema_version: { const: 1 },
      object_id: { type: "string", format: "uuid" },
      created_at: { type: "string", format: "date-time" },
      producer: { type: "object" },
      capabilities_used: { type: "array" },
      provenance: { type: "object" },
      content_hash: { type: "string", pattern: "^[0-9a-f]{64}$" },
      payload: { type: "object", required: definition.required, properties: payloadProperties, additionalProperties: false },
      extensions: { type: "object" },
    },
    additionalProperties: false,
  };
}

function supportedSchemaVersions(schemaId) {
  return CONTRACTS[schemaId] ? [1] : [];
}

module.exports = { generateJsonSchema, supportedSchemaVersions };
