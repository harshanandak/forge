import type { McpCandidate } from "../contract/mcp.ts";
import type { InvocationRequest, ResultEnvelope } from "../generated/types.ts";

/** Metadata only: discovery must never load an operation's executable code. */
export interface SurfaceCatalog {
  list(): readonly McpCandidate[];
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
