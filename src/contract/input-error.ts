import type { ForgeError, OperationDocs } from "../generated/types.ts";
import type { SchemaProblem } from "./schema.ts";

/** The validator owns the facts; every transport renders the same diagnostics and docs example. */
export function inputError(
  op: string,
  problems: readonly SchemaProblem[],
  docs?: OperationDocs,
): ForgeError {
  const fields = problems.map((problem) => ({
    pointer: problem.pointer,
    keyword: problem.keyword,
    message: problem.message,
    problem:
      problem.keyword === "required"
        ? "missing required"
        : problem.keyword === "type"
          ? "wrong type"
          : problem.keyword === "additionalProperties"
            ? "unknown property"
            : "not allowed",
    expected: problem.expected ?? problem.message,
    received: problem.received ?? "missing",
    ...(problem.suggestion === undefined
      ? {}
      : { suggestion: problem.suggestion }),
  }));
  const example = docs?.examples?.[0];
  const call =
    example === undefined
      ? undefined
      : `forge ${op.replace(".", " ")} --input '${JSON.stringify(example.input).replaceAll("'", "'\\''")}'`;
  return {
    code: "INPUT_INVALID",
    message: `Invalid input for ${op}:\n${fields.map((field) => `${field.pointer || "/"}: ${field.problem}; expected ${field.expected}; received ${field.received}${field.suggestion === undefined ? "" : `; closest valid name: ${JSON.stringify(field.suggestion)}`}`).join("\n")}${call === undefined ? "" : `\nExample: ${call}`}`,
    retry: "never",
    observed: {
      problems: fields,
      ...(call === undefined ? {} : { example: call }),
    },
  };
}
