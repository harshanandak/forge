import { randomUUID } from "node:crypto";
import { isAgentCallable } from "../contract/mcp.ts";
import type {
  AmbientContext,
  Caller,
  ResultEnvelope,
} from "../generated/types.ts";
import type { SurfaceCatalog } from "./catalog.ts";
import { failure } from "./result.ts";
import { discoveryOperations } from "./discovery.ts";

export interface CallOptions {
  readonly caller: Caller;
  readonly context?: AmbientContext;
  readonly requestId?: string;
  readonly dryRun?: boolean;
}

export function success(op: string, result: unknown): ResultEnvelope {
  return { ok: true, op, status: "OK", result, warnings: [] };
}

export function visible(
  catalog: SurfaceCatalog,
  caller: Caller,
): ReturnType<SurfaceCatalog["list"]> {
  return [...discoveryOperations, ...catalog.list()].filter(
    (c) => c.admitted && (caller !== "agent" || isAgentCallable(c.declaration)),
  );
}

export function suggestions(
  name: string,
  catalog: SurfaceCatalog,
  caller: Caller,
): string[] {
  const distance = (a: string, b: string): number => {
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 0; i < a.length; i++) {
      const next = [i + 1];
      for (let j = 0; j < b.length; j++)
        next.push(
          Math.min(
            (next[j] ?? 0) + 1,
            (row[j + 1] ?? 0) + 1,
            (row[j] ?? 0) + (a[i] === b[j] ? 0 : 1),
          ),
        );
      row = next;
    }
    return row[b.length] ?? a.length;
  };
  return visible(catalog, caller)
    .map((c) => ({ op: c.op, score: distance(name, c.op) }))
    .filter((c) => c.score <= Math.max(2, Math.floor(name.length / 3)))
    .sort((a, b) => a.score - b.score || a.op.localeCompare(b.op))
    .slice(0, 8)
    .map((c) => c.op);
}

/** All execution, including overflow tools and hooks, joins the injected runtime here. */
export async function dispatch(
  catalog: SurfaceCatalog,
  op: string,
  input: unknown,
  options: CallOptions,
): Promise<ResultEnvelope> {
  const entries = visible(catalog, options.caller);
  if (op === "catalog.list") return success(op, entries);
  if (op === "catalog.describe") {
    const name = record(input)?.op;
    const entry = entries.find((c) => c.op === name);
    return entry === undefined
      ? failure("UNKNOWN_COMMAND", `Unknown operation: ${String(name)}`)
      : success(op, entry);
  }
  if (op === "catalog.call") {
    const args = record(input);
    if (typeof args?.op !== "string" || args.op.startsWith("catalog."))
      return failure(
        "INPUT_INVALID",
        "Expected a catalog operation and input.",
      );
    return dispatch(catalog, args.op, args.input ?? {}, options);
  }
  if (
    ![...discoveryOperations, ...catalog.list()].some(
      (c) =>
        c.op === op &&
        (options.caller !== "agent" || isAgentCallable(c.declaration)),
    )
  )
    return failure(
      "UNKNOWN_COMMAND",
      `Unknown operation: ${op}`,
      suggestions(op, catalog, options.caller),
    );
  try {
    return await catalog.invoke({
      schemaVersion: "forge.invocation/1",
      requestId: options.requestId ?? randomUUID(),
      op,
      input,
      caller: options.caller,
      context: options.context ?? {},
      ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    });
  } catch {
    return failure("INTERNAL", "The runtime did not return a result envelope.");
  }
}

export function record(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
