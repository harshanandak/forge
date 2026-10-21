import { Catalog, type CapturedBlock } from "../core/catalog/index.ts";
import type { InvocationRequest } from "../generated/types.ts";
import { runTimeoutMs } from "../blocks/check/budget.ts";
import type { CheckConfig, RunInput } from "../blocks/check/types.ts";
import { ASSEMBLY_PROVIDES } from "./providers.ts";
import { version } from "../version.ts";
import { refuse } from "../core/trust/index.ts";

export function withCheckRunBudget(
  catalog: Catalog,
  blocks: ReadonlyMap<string, CapturedBlock>,
  request: InvocationRequest,
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
  );
  const configured = instance.operationTimeouts?.[operation.declaredOp];
  for (const ceiling of [configured, catalog.config.runtime?.timeoutMs]) {
    if (ceiling !== undefined && ceiling < timeoutMs)
      refuse(
        "INPUT_INVALID",
        `Selected run needs at least ${timeoutMs} ms; configured operation or host deadline is ${ceiling} ms`,
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
