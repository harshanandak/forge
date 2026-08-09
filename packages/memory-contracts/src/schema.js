"use strict";

const { CONTRACTS, PAYLOAD_FIELDS } = require("./definitions.js");

function generateJsonSchema(schemaId) {
  const definition = CONTRACTS[schemaId];
  if (!definition) throw new TypeError(`Unsupported schema_id: ${schemaId}`);
  const payloadProperties = {};
  for (const field of [...definition.required, ...definition.optional]) payloadProperties[field] = PAYLOAD_FIELDS[schemaId][field];
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
      producer: {
        type: "object",
        required: ["product_id", "product_version", "instance_id"],
        properties: { product_id: { type: "string", minLength: 1 }, product_version: { type: "string", minLength: 1 }, instance_id: { type: "string", minLength: 1 } },
      },
      capabilities_used: {
        type: "array",
        items: {
          type: "object",
          required: ["capability_id", "manifest_digest"],
          properties: { capability_id: { type: "string", minLength: 1 }, manifest_digest: { type: "string", pattern: "^[0-9a-f]{64}$" } },
          additionalProperties: false,
        },
      },
      provenance: {
        type: "object",
        required: ["source_kind", "actor_class", "actor_id"],
        properties: { source_kind: { type: "string", minLength: 1 }, actor_class: { type: "string", minLength: 1 }, actor_id: { type: "string", minLength: 1 } },
      },
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
