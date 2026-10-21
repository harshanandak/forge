import { Catalog, type CapturedBlock } from "../core/catalog/index.ts";
import type { InvocationRequest } from "../generated/types.ts";
import { runTimeoutMs } from "../blocks/check/budget.ts";
import type { CheckConfig, RunInput } from "../blocks/check/types.ts";
import {
  ASSEMBLY_PROVIDES,
  processCleanupBudgetMs,
  SNAPSHOT_TIMEOUT_MS,
  type ProviderOptions,
} from "./providers.ts";
import { version } from "../version.ts";
import { refuse } from "../core/trust/index.ts";
import { formatConfigProblem } from "../contract/input-error.ts";

export function withCheckRunBudget(
  catalog: Catalog,
  blocks: ReadonlyMap<string, CapturedBlock>,
  request: InvocationRequest,
  providers?: ProviderOptions,
): Catalog {
  const { block, operation } = catalog.resolve(request.op);
  const instance = catalog.config.blocks[operation.instance]!;
  if (
    !block.shipped ||
    block.manifest.id !== "forge/check" ||
    operation.declaredOp !== "check.run" ||
    !block.validate(operation.declaration.input, request.input) ||
    !block.validate(block.manifest.configSchema!, instance.config ?? {})
  )
    return catalog;
  const timeoutMs = runTimeoutMs(
    instance.config as unknown as CheckConfig,
    request.input as RunInput,
    {
      cleanupMs: processCleanupBudgetMs(providers?.supervision),
      snapshotMs: SNAPSHOT_TIMEOUT_MS,
    },
    `blocks.${operation.instance}.config`,
  );
  const configured = instance.operationTimeouts?.[operation.declaredOp];
  for (const [key, ceiling] of [
    [
      `blocks.${operation.instance}.operationTimeouts["${operation.declaredOp}"]`,
      configured,
    ],
    ["runtime.timeoutMs", catalog.config.runtime?.timeoutMs],
  ] as const) {
    if (ceiling !== undefined && ceiling < timeoutMs)
      refuse(
        "INPUT_INVALID",
        formatConfigProblem(
          key,
          `Selected run needs at least ${timeoutMs / 1000} s; ${key} (${ceiling / 1000} s) is too short`,
          `raise it to at least ${timeoutMs / 1000} s, lower blocks.${operation.instance}.config.timeoutMs, or select fewer checks with --input '{"checks":["name"]}'`,
        ),
      );
  }
  if (configured !== undefined) return catalog;
  return new Catalog(
    {
      ...catalog.config,
      blocks: {
        ...catalog.config.blocks,
        [operation.instance]: {
          ...instance,
          operationTimeouts: {
            ...instance.operationTimeouts,
            [operation.declaredOp]: timeoutMs,
          },
        },
      },
    },
    blocks,
    version,
    ASSEMBLY_PROVIDES,
  );
}
