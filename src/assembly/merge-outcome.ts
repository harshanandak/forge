import type { Catalog } from "../core/catalog/index.ts";
import { DEFAULT_RUNTIME_LIMITS } from "../core/runtime/index.ts";
import { parseUntrustedJson } from "../contract/untrusted.ts";
import type { MergeResult } from "../blocks/check/types.ts";
import type { CatalogServices } from "../blocks/check/services.ts";
import type { ProcessPort } from "../ports/process.ts";
import entry from "../blocks/check/entry.cts";

type Readback = NonNullable<MergeResult["readbackProcess"]>;
const { readbackRecord } = entry as unknown as {
  readbackRecord: (read: Readback) => Readback;
};

/** Keep evidence outside the evaluator, whose cancellation discards pending output. */
export function createMergeOutcome(
  catalog: Catalog,
  op: string,
  input: unknown,
  cleanupBudgetMs: number,
) {
  const { block, operation } = catalog.resolve(op);
  const enabled =
    block.manifest.id === "forge/check" && operation.declaredOp === "pr.merge";
  let retained: MergeResult | undefined;
  let attempted = false;
  function retainMergeOutcome(value: MergeResult) {
    const parsed = parseUntrustedJson(JSON.stringify(value), {
      ...DEFAULT_RUNTIME_LIMITS.parse,
      maxBytes: DEFAULT_RUNTIME_LIMITS.maxOutputBytes,
    });
    if (
      !parsed.ok ||
      !block.validate(operation.declaration.output, parsed.value)
    )
      return;
    const candidate = parsed.value as MergeResult;
    if (
      typeof input !== "object" ||
      input === null ||
      !("pr" in input) ||
      candidate.pr !== input.pr ||
      candidate.outcome !== "MERGE_UNVERIFIED" ||
      candidate.gate.verdict !== "PASS" ||
      candidate.gate.head !== candidate.head ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(candidate.head) ||
      !candidate.receipt ||
      candidate.receipt !== candidate.gate.receipt ||
      (attempted &&
        (candidate.head !== retained?.head ||
          candidate.receipt !== retained?.receipt))
    )
      return;
    retained =
      attempted && retained?.readbackProcess
        ? { ...candidate, readbackProcess: retained.readbackProcess }
        : candidate;
  }
  return {
    process(port: ProcessPort): CatalogServices["process"] {
      if (!enabled) return port;
      return {
        ...port,
        cleanupBudgetMs,
        retainMergeOutcome,
        run(executable, argv, options) {
          if (
            retained &&
            argv.length === 6 &&
            argv[0] === "pr" &&
            argv[1] === "merge" &&
            argv[2] === String(retained.pr) &&
            argv[3] === "--squash" &&
            argv[4] === "--match-head-commit" &&
            argv[5] === retained.head
          )
            attempted = true;
          return port.run(executable, argv, options).then((read) => {
            if (
              attempted &&
              retained &&
              argv.length === 5 &&
              argv[0] === "pr" &&
              argv[1] === "view" &&
              argv[2] === String(retained.pr) &&
              argv[3] === "--json" &&
              argv[4] === "state,headRefOid,mergeCommit"
            )
              retainMergeOutcome({
                ...retained,
                readbackProcess: readbackRecord(read),
              });
            return read;
          });
        },
      };
    },
    result(): MergeResult | undefined {
      return attempted ? retained : undefined;
    },
  };
}
