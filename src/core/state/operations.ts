import type { OperationDeclaration } from "../../generated/types.ts";

export const operations: Record<string, OperationDeclaration> = {
  "store.reinit": {
    input: "state/reinit.input.schema.json",
    output: "state/reinit.output.schema.json",
    context: "project",
    effects: ["store:write"],
    idempotent: false,
    stability: "stable",
    callers: ["human"],
  },
};
