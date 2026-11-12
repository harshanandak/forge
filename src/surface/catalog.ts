import type { McpCandidate } from "../contract/mcp.ts";
import type {
  ForgeError,
  InvocationRequest,
  ResultEnvelope,
  UpgradeHint,
  Caller,
  TemplateHint,
} from "../generated/types.ts";

/** Metadata only: discovery must never load an operation's executable code. */
export interface SurfaceCatalog {
  list(): readonly McpCandidate[];
  diagnose?(op: string): ForgeError | undefined;
  /** Throws the refusal for an operation, a dry run of it, or an input this project's authority will not serve, before any lookup for it. */
  admit?(
    blockId: string,
    declaredOp: string,
    dryRun?: boolean,
    input?: unknown,
  ): void;
  upgradeHint?(op: string): UpgradeHint | undefined;
  templateHint?(
    op: string,
    caller: Caller,
    readOnly?: boolean,
  ): TemplateHint | undefined;
  invoke(request: InvocationRequest): Promise<ResultEnvelope>;
}

export const emptyCatalog: SurfaceCatalog = {
  list: () => [],
  invoke: () =>
    Promise.resolve({
      ok: false,
      status: "FAIL",
      error: {
        code: "UNKNOWN_COMMAND",
        message: "No operation is registered.",
        retry: "never",
      },
      warnings: [],
    }),
};
