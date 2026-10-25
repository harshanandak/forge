import type { Catalog } from "../core/catalog/index.ts";
import type { ResultEnvelope } from "../generated/types.ts";
import type { CheckReceipt, GateResult } from "../blocks/check/types.ts";

/** Runtime has validated the receipt; every surface consumes this same outcome. */
export function checkResult(
  catalog: Catalog,
  op: string,
  envelope: ResultEnvelope,
): ResultEnvelope {
  const { block, operation } = catalog.resolve(op);
  if (
    block.manifest.id === "forge/check" &&
    operation.declaredOp === "check.gate" &&
    envelope.ok
  ) {
    const gate = envelope.result as GateResult;
    if (gate.verdict === "PASS") return envelope;
    return {
      ...envelope,
      ok: false,
      status: "FAIL",
      error: {
        code: "CHECK_GATE_REFUSED",
        message:
          "Merge gate refused; inspect result.reasons and repair the evidence before merging.",
        retry: "reconcile_first",
      },
    };
  }
  if (
    block.manifest.id !== "forge/check" ||
    operation.declaredOp !== "check.run"
  )
    return envelope;
  if (!envelope.ok) return envelope;
  const receipt = envelope.result as CheckReceipt;
  if (receipt.status === "PASS") return envelope;
  const remedy =
    receipt.status === "NOT_EXECUTED"
      ? `Declare commands in blocks.${operation.instance}.config.commands in .forge/config.yaml and select a declared check.`
      : receipt.status === "FAIL"
        ? "Fix the failing command and rerun the checks."
        : "Inspect result.runs for the reason; repair the executable/environment or increase the declared timeout, then rerun.";
  return {
    ...envelope,
    ok: false,
    status: receipt.status === "FAIL" ? "FAIL" : "INCOMPLETE",
    error: {
      code: `CHECK_${receipt.status}`,
      message: `Checks ${receipt.status}. ${remedy}`,
      retry: "reconcile_first",
    },
  };
}
