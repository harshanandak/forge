import type { OperationDeclaration } from "../../generated/types.ts";

/** Area-owned operation declarations; assembled output is generated, never committed. */
export const operations: Record<string, OperationDeclaration> = {
  "catalog.describe": {
    args: ["op"],
    output: "catalog/describe.output.schema.json",
    context: "stateless",
    idempotent: true,
    stability: "stable",
    effects: [],
    input: "catalog/describe.input.schema.json",
    callers: ["human", "agent"],
  },
  "block.add": {
    output: "catalog/capture.output.schema.json",
    context: "stateless",
    idempotent: true,
    stability: "stable",
    effects: [],
    input: "catalog/path.input.schema.json",
    callers: ["human", "agent"],
  },
  "catalog.list": {
    output: "catalog/list.output.schema.json",
    context: "stateless",
    idempotent: true,
    stability: "stable",
    effects: [],
    input: "catalog/list.input.schema.json",
    callers: ["human", "agent"],
  },
  "block.check": {
    output: "catalog/capture.output.schema.json",
    context: "stateless",
    idempotent: true,
    stability: "stable",
    effects: [],
    input: "catalog/path.input.schema.json",
    callers: ["human", "agent"],
  },
  "catalog.call": {
    output: "catalog/call.output.schema.json",
    context: "stateless",
    idempotent: false,
    stability: "stable",
    // Discovery describes the worst case; runtime grants belong to the target.
    effects: ["external:write"],
    destructive: true,
    input: "catalog/call.input.schema.json",
    callers: ["human", "agent"],
  },
};
