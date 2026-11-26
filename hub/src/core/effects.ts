import type { ReportOutput } from "../contract/mcp.ts";
import type { CoreContext } from "./core.ts";

export interface EffectWorker {
  drain(): Promise<void>;
  waitForSummary(
    projectId: string,
    revision: number,
  ): Promise<ReportOutput["summary"]>;
}

export function createEffectWorker(_ctx: CoreContext): EffectWorker {
  const notBuilt = (): never => {
    throw new Error("not_built");
  };
  return { drain: notBuilt, waitForSummary: notBuilt };
}
