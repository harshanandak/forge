import type { HandlerCall } from "../../contract/author.ts";
import { ForgeFailure } from "../../contract/failure.ts";
import { validateWithSchema } from "../../contract/schema.ts";
import { createCheck } from "./index.ts";
import type {
  CheckConfig,
  CheckInvocationScope,
  CheckReceipt,
  CheckServices,
  RunInput,
  GateInput,
  GateResult,
} from "./types.ts";
import configSchema from "./schemas/config.json" with { type: "json" };

/** The owner-approved v2 call shape; L1 supplies these fields after its merge. */
export type CheckHandlerCall<Input> = HandlerCall<Input> & CheckInvocationScope;
export interface CheckOperations {
  readonly "check.gate": (
    args: CheckHandlerCall<GateInput>,
  ) => Promise<GateResult>;
  readonly "check.run": (
    args: CheckHandlerCall<RunInput>,
  ) => Promise<CheckReceipt>;
  readonly "check.list": (
    args: CheckHandlerCall<Readonly<Record<string, never>>>,
  ) => {
    readonly commands: readonly string[];
    readonly receiptChecks: readonly string[];
  };
  readonly "check.show": (
    args: CheckHandlerCall<{ readonly id: string }>,
  ) => CheckReceipt | null;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function services(value: unknown): CheckServices {
  if (
    !record(value) ||
    typeof value.root !== "string" ||
    !record(value.environment) ||
    !Object.values(value.environment).every(
      (entry) => typeof entry === "string",
    ) ||
    typeof value.snapshot !== "function" ||
    !record(value.clock) ||
    typeof value.clock.now !== "function" ||
    !record(value.process) ||
    typeof value.process.resolve !== "function" ||
    typeof value.process.run !== "function" ||
    !record(value.output) ||
    typeof value.output.parse !== "function" ||
    !record(value.state) ||
    !["get", "put", "list", "events"].every(
      (method) =>
        typeof (value.state as Record<string, unknown>)[method] === "function",
    )
  )
    throw new ForgeFailure({
      code: "SERVICE_MISSING",
      message:
        "Check operations require invocation-scoped process, output, snapshot, environment, clock and state services",
      retry: "never",
    });
  return value as unknown as CheckServices;
}
function config(value: unknown): CheckConfig {
  if (validateWithSchema(configSchema, value).length > 0)
    throw new ForgeFailure({
      code: "INPUT_INVALID",
      message:
        "Check configuration must declare commands and explicit execution budgets",
      retry: "never",
    });
  return value as CheckConfig;
}
export const operations: CheckOperations = {
  async "check.gate"(args) {
    return await createCheck(services(args.services)).gate(
      args.input,
      config(args.config),
      {
        signal: args.signal,
        deadline: args.deadline,
      },
    );
  },
  async "check.run"(args) {
    return await createCheck(services(args.services)).run(
      args.input,
      config(args.config),
      { signal: args.signal, deadline: args.deadline },
    );
  },
  "check.list"(args) {
    return {
      commands: createCheck(services(args.services)).list(config(args.config)),
      receiptChecks: config(args.config).gate?.receiptChecks ?? [],
    };
  },
  "check.show"(args) {
    return createCheck(services(args.services)).show(args.input.id) ?? null;
  },
};
