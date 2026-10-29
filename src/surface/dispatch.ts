import { randomUUID } from "node:crypto";
import { ForgeFailure } from "../contract/failure.ts";
import { isAgentCallable, type McpCandidate } from "../contract/mcp.ts";
import { closestNames } from "../contract/schema.ts";
import type {
  AmbientContext,
  Caller,
  ResultEnvelope,
  OperationDeclaration,
} from "../generated/types.ts";
import type { SurfaceCatalog } from "./catalog.ts";
import { failure } from "./result.ts";
import { discoveryOperations } from "./discovery.ts";
import { validateInvocationRequest } from "../generated/validators.ts";

export interface CallOptions {
  readonly caller: Caller;
  /** Host-owned interactive fallback when an operation requires conversation approval. */
  readonly confirmHuman?: (op: string, input: unknown) => Promise<boolean>;
  readonly readOnly?: boolean;
  readonly context?: AmbientContext;
  readonly requestId?: string;
  readonly dryRun?: boolean;
  readonly explicitContext?: boolean;
  /** The embedding resolves local identity only when the declared context needs it. */
  readonly resolveContext?: (
    declaration: OperationDeclaration,
    context: AmbientContext,
    explicitContext: boolean,
  ) => AmbientContext;
}

export function requiresOwnerConfirmation(
  candidate: McpCandidate | undefined,
): boolean {
  return (
    candidate?.blockId === "forge/memory" &&
    ["memory.forget", "memory.restore", "decision.adopt"].includes(
      candidate.declaredOp ?? "",
    )
  );
}

export function success(op: string, result: unknown): ResultEnvelope {
  return { ok: true, op, status: "OK", result, warnings: [] };
}

export function visible(
  catalog: SurfaceCatalog,
  caller: Caller,
  readOnly = false,
): ReturnType<SurfaceCatalog["list"]> {
  return [...discoveryOperations, ...catalog.list()].filter(
    (c) =>
      c.admitted &&
      (caller !== "agent" || isAgentCallable(c.declaration)) &&
      (!readOnly || c.declaration.effects.length === 0),
  );
}

export function suggestions(
  name: string,
  catalog: SurfaceCatalog,
  caller: Caller,
): string[] {
  return closestNames(
    name,
    visible(catalog, caller).map((entry) => entry.op),
  );
}

/** All execution, including overflow tools and hooks, joins the injected runtime here. */
export async function dispatch(
  catalog: SurfaceCatalog,
  op: string,
  input: unknown,
  options: CallOptions,
): Promise<ResultEnvelope> {
  const entries = visible(catalog, options.caller, options.readOnly);
  if (
    options.readOnly &&
    discoveryOperations.some(
      (entry) => entry.op === op && entry.declaration.effects.length > 0,
    )
  )
    return failure("UNKNOWN_COMMAND", `Unknown operation: ${op}`);
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
    const checked = validateInvocationRequest({
      ...args,
      schemaVersion: args.schemaVersion ?? "forge.invocation/1",
      requestId: args.requestId ?? options.requestId ?? randomUUID(),
      input: args.input === undefined ? {} : args.input,
      context: args.context ?? options.context ?? {},
      caller: options.caller,
    });
    if (!checked.ok)
      return failure("INPUT_INVALID", "Invalid catalog invocation request.");
    const request = checked.value;
    return dispatch(catalog, request.op, request.input, {
      caller: options.caller,
      ...(options.confirmHuman === undefined
        ? {}
        : { confirmHuman: options.confirmHuman }),
      ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
      context: request.context,
      explicitContext:
        options.explicitContext === true || args.context !== undefined,
      ...(options.resolveContext === undefined
        ? {}
        : { resolveContext: options.resolveContext }),
      requestId: request.requestId,
      ...(options.dryRun === undefined && request.dryRun === undefined
        ? {}
        : { dryRun: options.dryRun === true || request.dryRun === true }),
    });
  }
  const entry = [...discoveryOperations, ...catalog.list()].find(
    (entry) => entry.op === op,
  );
  const declaration = entry?.declaration;
  if (options.readOnly && declaration && declaration.effects.length > 0)
    return failure("UNKNOWN_COMMAND", `Unknown operation: ${op}`);
  if (
    ![...discoveryOperations, ...catalog.list()].some(
      (c) =>
        c.op === op &&
        (options.caller !== "agent" || isAgentCallable(c.declaration)) &&
        (!options.readOnly || c.declaration.effects.length === 0),
    )
  ) {
    const error = catalog.diagnose?.(op);
    if (error) return { ok: false, op, status: "FAIL", error, warnings: [] };
    return failure(
      "UNKNOWN_COMMAND",
      `Unknown operation: ${op}`,
      suggestions(op, catalog, options.caller),
    );
  }
  try {
    const context =
      declaration === undefined || options.resolveContext === undefined
        ? (options.context ?? {})
        : options.resolveContext(
            declaration,
            options.context ?? {},
            options.explicitContext === true,
          );
    const request = {
      schemaVersion: "forge.invocation/1",
      requestId: options.requestId ?? randomUUID(),
      op,
      input,
      caller: options.caller,
      context: await heldContext(catalog, op, input, { ...options, context }),
      ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    } as const;
    let result = await catalog.invoke(request);
    if (
      !result.ok &&
      result.error.code === "HUMAN_REQUIRED" &&
      entry?.blockId === "forge/memory"
    ) {
      if (
        requiresOwnerConfirmation(entry) &&
        record(input)?.approval === undefined &&
        options.caller === "human"
      ) {
        const confirmed = await Promise.resolve()
          .then(() => options.confirmHuman?.(op, input))
          .catch(() => false);
        if (confirmed)
          result = await catalog.invoke({
            ...request,
            input: {
              ...record(input),
              approval: { by: "owner", quote: "confirmed in terminal" },
            },
          });
      }
      if (!result.ok && result.error.code === "HUMAN_REQUIRED")
        return {
          ...result,
          error: {
            ...result.error,
            message: `${op}: ${result.error.message}`,
            repair:
              "Ask the owner in the conversation, then retry with approval by owner and their words.",
          },
        };
    }
    return result;
  } catch (error) {
    if (error instanceof ForgeFailure)
      return {
        ok: false,
        op,
        status: "FAIL",
        error: error.error,
        warnings: [],
      };
    return failure("INTERNAL", "The runtime did not return a result envelope.");
  }
}

/**
 * A held operation on an item that names no lease generation takes the generation of the item's
 * current lease, read through the noun's `show`. Only the number is filled in: the state owner still
 * fences the write to the lease's actor and session, so another session is refused as before.
 */
async function heldContext(
  catalog: SurfaceCatalog,
  op: string,
  input: unknown,
  options: CallOptions,
): Promise<AmbientContext> {
  const context = options.context ?? {};
  const declaration = catalog.list().find((c) => c.op === op)?.declaration;
  const id = record(input)?.id;
  const show = `${op.split(".")[0] ?? ""}.show`;
  if (
    declaration?.context !== "leased" ||
    declaration.leaseMode === "acquire" ||
    context.session === undefined ||
    context.leaseGeneration !== undefined ||
    typeof id !== "string" ||
    !catalog.list().some((c) => c.op === show)
  )
    return context;
  const shown = await catalog.invoke({
    schemaVersion: "forge.invocation/1",
    requestId: randomUUID(),
    op: show,
    input: { id },
    caller: options.caller,
    context,
  });
  const generation = shown.ok
    ? record(record(shown.result)?.lease)?.generation
    : undefined;
  return typeof generation === "number"
    ? { ...context, leaseGeneration: generation }
    : context;
}

export function record(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
