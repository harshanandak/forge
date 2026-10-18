import type { OperationDeclaration } from "../../generated/types.ts";

/** Area-owned operation declarations; assembled output is generated, never committed. */
export const operations: Record<string, OperationDeclaration> = {
  "block.admit": {
    args: ["digest"],
    output: "trust/admit.output.schema.json",
    context: "device",
    idempotent: true,
    stability: "stable",
    effects: ["block:write"],
    input: "trust/admit.input.schema.json",
    callers: ["human"],
  },
};
