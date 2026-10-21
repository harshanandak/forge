import type { ForgeError, OperationDocs } from "../generated/types.ts";
import type { SchemaObject, SchemaProblem } from "./schema.ts";
import { renderExample } from "./example.ts";

function sentence(problem: SchemaProblem, source?: string): string {
  const field =
    problem.pointer
      .split("/")
      .slice(1)
      .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
      .reduce(
        (name, part) =>
          /^\d+$/.test(part)
            ? `${name}[${part}]`
            : source !== undefined && !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(part)
              ? `${name}[${JSON.stringify(part)}]`
              : `${name}${name ? "." : ""}${part}`,
        "",
      ) || "input";
  if (problem.keyword === "required") return `${field} is required`;
  if (problem.keyword === "type")
    return `${field} must be ${problem.expected === "string" ? "text" : (problem.expected ?? "a valid value")}; received ${problem.received ?? "missing"}`;
  if (problem.keyword === "additionalProperties")
    return `Unknown field ${JSON.stringify(field)}${problem.suggestion === undefined ? "" : `; did you mean ${JSON.stringify(problem.suggestion)}?`}`;
  if (problem.message.startsWith("Unexpected argument "))
    return problem.message;
  return `${field} ${problem.message}`;
}

/** The validator owns the facts; every transport renders the same diagnostics and docs example. */
export function inputError(
  op: string,
  problems: readonly SchemaProblem[],
  docs?: OperationDocs,
  schema: SchemaObject = {},
  positions: readonly string[] = [],
  source?: string,
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
  const call =
    docs?.examples?.[0] === undefined
      ? undefined
      : renderExample(op, docs, schema, positions);
  return {
    code: "INPUT_INVALID",
    message: `Invalid input for ${op}:\n${problems.map((problem) => `${source === undefined ? "" : `${source}: `}${sentence(problem, source)}`).join("\n")}${call === undefined ? "" : `\nExample: ${call}`}`,
    retry: "never",
    observed: {
      problems: fields,
      ...(call === undefined ? {} : { example: call }),
    },
  };
}
