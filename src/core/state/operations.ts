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
  "project.init": {
    input: "state/project-init.input.schema.json",
    output: "state/project-init.output.schema.json",
    context: "project",
    effects: ["project:write"],
    idempotent: false,
    stability: "stable",
    callers: ["human"],
  },
};
