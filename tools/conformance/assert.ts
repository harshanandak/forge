import { posix } from "node:path";
import type { CapturedBlock } from "../../src/core/catalog/index.ts";
import { isSchemaObject } from "../../src/contract/schema.ts";
import { validateResultEnvelope } from "../../src/generated/validators.ts";
import type { Observation } from "./record.ts";

/** Refusal alternatives are schema files named by the output's x-conformance-refusals annotation. */
export function assertConformance(
  blocks: readonly CapturedBlock[],
  observations: readonly Observation[],
): void {
  const contracts = new Map<
    string,
    { block: CapturedBlock; input: string; output: string; refusals: string[] }
  >();
  for (const block of blocks) {
    for (const [operation, declaration] of Object.entries(
      block.manifest.operations,
    )) {
      if (contracts.has(operation))
        throw new Error(`${operation}: duplicate declaration`);
      const schema = block.schema(declaration.output);
      const refs: unknown = isSchemaObject(schema)
        ? schema["x-conformance-refusals"]
        : undefined;
      if (
        refs !== undefined &&
        (!Array.isArray(refs) ||
          !refs.every((ref: unknown) => typeof ref === "string"))
      )
        throw new Error(`${operation}: malformed refusal declaration`);
      const refusals = refs ?? [];
      const branches =
        isSchemaObject(schema) && Array.isArray(schema.oneOf)
          ? schema.oneOf
          : [];
      for (const ref of refusals) {
        if (
          !branches.some(
            (branch: unknown) => isSchemaObject(branch) && branch.$ref === ref,
          )
        )
          throw new Error(
            `${operation}: refusal must be an output alternative`,
          );
      }
      contracts.set(operation, { block, ...declaration, refusals });
    }
  }
  const seen = new Map<string, Set<string>>();
  for (const { operation, input, outcome: raw } of observations) {
    const contract = contracts.get(operation);
    if (!contract) throw new Error(`${operation}: undeclared operation`);
    const fail = (part: string): never => {
      throw new Error(`${operation}: invalid ${part}`);
    };
    if (!contract.block.validate(contract.input, input)) fail("input");
    const parsed = validateResultEnvelope(raw);
    if (!parsed.ok) throw new Error(`${operation}: invalid envelope or error`);
    const outcome = parsed.value;
    if (outcome.op !== operation) fail("operation identity");
    const refused = seen.get(operation) ?? new Set<string>();
    seen.set(operation, refused);
    if (!outcome.ok) {
      if (outcome.error.code === "OUTPUT_INVALID")
        fail("output (OUTPUT_INVALID)");
    } else {
      if (!contract.block.validate(contract.output, outcome.result))
        fail("output");
      for (const ref of contract.refusals)
        if (
          contract.block.validate(
            posix.join(posix.dirname(contract.output), ref),
            outcome.result,
          )
        )
          refused.add(ref);
    }
  }
  for (const [operation, contract] of contracts) {
    if (!seen.has(operation))
      throw new Error(`${operation}: unobserved operation`);
    for (const ref of contract.refusals)
      if (!seen.get(operation)?.has(ref))
        throw new Error(`${operation}: unobserved refusal ${ref}`);
  }
}
