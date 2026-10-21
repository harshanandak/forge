import type { ForgeError, OperationDocs } from "../generated/types.ts";
import type { SchemaObject, SchemaProblem } from "./schema.ts";
import { renderExample } from "./example.ts";

/** One renderer for transport input and document diagnostics. */
export function formatProblem(
  problem: SchemaProblem,
  value?: unknown,
  prefix?: string,
  file = ".forge/config.yaml",
  source?: string,
): string {
  if (source === undefined && arguments.length > 1) {
    const segments = problem.pointer
      .split("/")
      .slice(1)
      .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
    let received = value;
    for (const segment of segments)
      received =
        typeof received === "object" && received !== null
          ? (received as Readonly<Record<string, unknown>>)[segment]
          : undefined;
    const path = [prefix, ...segments].filter(Boolean).join(".") || "/";
    const actual = JSON.stringify(received) ?? "missing";
    const message =
      problem.keyword === "type"
        ? problem.message.replace(/, got .*/, () => `, got ${actual}`)
        : `${problem.message}; got ${actual}`;
    const expectation = problem.message
      .replace(/, got .*/, "")
      .replace(/^expected /, "");
    const fix =
      problem.suggestion !== undefined
        ? problem.keyword === "additionalProperties"
          ? `did you mean ${problem.suggestion}? Rename ${segments.at(-1)} to ${problem.suggestion}`
          : `use ${JSON.stringify(problem.suggestion)}`
        : problem.keyword === "additionalProperties"
          ? `remove ${path}`
          : problem.keyword === "required"
            ? `add ${path}`
            : problem.keyword === "oneOf" || problem.keyword === "anyOf"
              ? `use one of the allowed shapes at ${path}`
              : `set ${path} to ${problem.keyword === "type" ? `a valid ${expectation}` : problem.keyword === "enum" || problem.keyword === "const" ? expectation : `a value that ${expectation}`}`;
    return `${file}: ${path}: ${message}. Fix: ${fix}.`;
  }
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
    message: `Invalid input for ${op}:\n${problems.map((problem) => (source === undefined ? formatProblem(problem) : `${source}: ${formatProblem(problem, undefined, undefined, undefined, source)}`)).join("\n")}${call === undefined ? "" : `\nExample: ${call}`}`,
    retry: "never",
    observed: {
      problems: fields,
      ...(call === undefined ? {} : { example: call }),
    },
  };
}
