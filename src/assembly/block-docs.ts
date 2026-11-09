import { ForgeFailure } from "../contract/failure.ts";
import { inputError } from "../contract/input-error.ts";
import { validateWithSchema } from "../contract/schema.ts";
import { registry, validateDocsRecords } from "../generated/validators.ts";
import type { DocsRecords } from "../generated/types.ts";

/**
 * Parse and check a block's docs file against the docs schema and its declared operations.
 * Assembly runs this when it loads a block and the gen step runs it on every first-party block,
 * so both refuse the same docs with the same message.
 */
export function checkBlockDocs(
  text: string,
  operations: readonly string[],
  source: string,
): DocsRecords {
  const value: unknown = JSON.parse(text);
  const docs = validateDocsRecords(value);
  const problems = docs.ok
    ? validateWithSchema(
        { type: "object", required: [...operations] },
        docs.value.operations,
      ).map((problem) => ({
        ...problem,
        pointer: `/operations${problem.pointer}`,
      }))
    : registry.validate("docs.json", value, true);
  if (!docs.ok || problems.length > 0)
    throw new ForgeFailure(
      inputError(`block docs ${source}`, problems, undefined, {}, [], source),
    );
  return docs.value;
}
