import { randomUUID } from "node:crypto";
import type { Ajv } from "@modelcontextprotocol/server/validators/ajv";
import type { HubResult } from "../contract/core.ts";
import {
  HTTP_STATUS,
  type HubErrorCode,
  type HubOp,
} from "../contract/errors.ts";
import type { HubWarning, ToolEnvelope } from "../contract/mcp.ts";
import type { HubLog } from "../contract/runtime.ts";

export const problem = (code: HubErrorCode, pointer?: string) =>
  ({
    ok: false,
    error: {
      code,
      message: code,
      retry: "never",
      ...(pointer === undefined ? {} : { pointer }),
    },
  }) as const;

export function envelope<T>(
  op: HubOp,
  result: HubResult<T>,
  warnings: readonly HubWarning[] = [],
): ToolEnvelope<T> {
  return result.ok
    ? { op, ok: true, status: "OK", result: result.value, warnings }
    : { op, ok: false, status: "FAIL", error: result.error, warnings: [] };
}

export function hookResponse(body: ToolEnvelope<unknown>) {
  const status = body.ok ? 200 : HTTP_STATUS[body.error.code];
  return Response.json(body, { status });
}

export function refusal(
  status: number,
  code: HubErrorCode = "INPUT_INVALID",
  op?: HubOp,
) {
  const result = problem(code);
  const body = op ? envelope(op, result) : { ...result, status: "FAIL" };
  const headers = status === 401 ? { "WWW-Authenticate": "Bearer" } : {};
  return Response.json(body, { status, headers });
}

type Errors = ReturnType<InstanceType<typeof Ajv>["compile"]>["errors"];
type Validator<I> = ((value: unknown) => value is I) & { errors?: Errors };
export type Call<C, I, O> = (
  caller: C,
  value: I,
  signal: AbortSignal,
) => HubResult<O> | Promise<HubResult<O>>;

function pointer(errors: Errors) {
  const direct = errors?.find((e) => !e.schemaPath.startsWith("#/oneOf"));
  const issue = direct ?? errors?.at(-1);
  if (!issue) return "";
  const params: Record<string, unknown> = issue.params;
  const field = params.missingProperty ?? params.additionalProperty;
  if (typeof field !== "string") return issue.instancePath;
  const escaped = field.replaceAll("~", "~0").replaceAll("/", "~1");
  return issue.instancePath + "/" + escaped;
}

const internal = {
  code: "INTERNAL",
  message: "The hub could not complete the request.",
  retry: "reconcile_first",
} as const;

export function operation<C, I, O>(
  log: HubLog,
  op: HubOp,
  validate: Validator<I>,
  run: Call<C, I, O>,
  warn?: (value: O, input: I) => HubWarning[] | undefined,
) {
  return async (caller: C, value: unknown, signal: AbortSignal) => {
    if (!validate(value))
      return envelope(op, problem("INPUT_INVALID", pointer(validate.errors)));
    try {
      const result = await run(caller, value, signal);
      const warnings = result.ok ? warn?.(result.value, value) : undefined;
      return envelope(op, result, warnings);
    } catch {
      log.error("hub.remote", { errorId: randomUUID(), code: "INTERNAL" });
      return envelope(op, { ok: false, error: internal });
    }
  };
}
