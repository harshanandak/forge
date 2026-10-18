import type { McpCandidate } from "../../../src/contract/mcp.ts";
import type {
  InvocationRequest,
  ResultEnvelope,
} from "../../../src/generated/types.ts";
import type { SurfaceCatalog } from "../../../src/surface/catalog.ts";

export function candidate(
  op = "sample.echo",
  change: Partial<McpCandidate["declaration"]> = {},
): McpCandidate {
  return {
    op,
    admitted: true,
    declaration: {
      input: "input.json",
      output: "output.json",
      context: "stateless",
      effects: [],
      idempotent: true,
      callers: ["human", "agent"],
      stability: "stable",
      ...change,
    },
    docs: { title: op, summary: `Run ${op}` },
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "string" },
        count: { type: "integer" },
        preRelease: { type: "boolean" },
      },
      required: ["value"],
      additionalProperties: false,
    },
  };
}

export function fakeCatalog(
  entries: readonly McpCandidate[] = [candidate()],
  answer?: ResultEnvelope,
): SurfaceCatalog & { readonly calls: InvocationRequest[] } {
  const calls: InvocationRequest[] = [];
  return {
    calls,
    list: () => entries,
    invoke: (request) => {
      calls.push(request);
      return Promise.resolve(
        answer ?? {
          ok: true,
          op: request.op,
          status: "OK",
          result: request.input,
          warnings: [],
        },
      );
    },
  };
}
