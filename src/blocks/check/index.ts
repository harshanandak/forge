import { randomUUID } from "node:crypto";
import { ForgeFailure } from "../../contract/failure.ts";
import { commandArguments, invalid } from "./command.ts";
import { hash, verifyReceipt } from "./receipt.ts";
import type {
  CheckConfig,
  CheckReceipt,
  CheckRun,
  CheckServices,
  CheckStatus,
  CheckInvocationScope,
  RunInput,
} from "./types.ts";
import type { SpawnOptions } from "../../ports/process.ts";
export type * from "./types.ts";
export { verifyReceipt } from "./receipt.ts";

function blank(
  name: string,
  argv: readonly string[],
  reason: string,
  status: CheckStatus = "NOT_EXECUTED",
): CheckRun {
  return {
    name,
    argv,
    executable: null,
    status,
    testCount: null,
    exitCode: null,
    signal: null,
    timedOut: false,
    truncated: false,
    stdout: "",
    stderr: "",
    durationMs: 0,
    reason,
  };
}
function aggregate(runs: readonly CheckRun[]): CheckStatus {
  if (runs.some((run) => run.status === "FAIL")) return "FAIL";
  if (runs.some((run) => run.status === "INCOMPLETE")) return "INCOMPLETE";
  if (runs.length === 0 || runs.some((run) => run.status === "NOT_EXECUTED"))
    return "NOT_EXECUTED";
  return "PASS";
}
export interface CheckBlock {
  list(config: CheckConfig): string[];
  show(id: string): CheckReceipt | undefined;
  run(
    input: RunInput,
    config: CheckConfig,
    scope?: CheckInvocationScope,
  ): Promise<CheckReceipt>;
}
export function createCheck(services: CheckServices): CheckBlock {
  function show(id: string): CheckReceipt | undefined {
    const record = services.state.get(`runs/${id}`);
    if (!record) return undefined;
    const value = record.value;
    const expected =
      typeof value === "object" && value !== null && "inputsDigest" in value
        ? value.inputsDigest
        : undefined;
    if (typeof expected !== "string" || !verifyReceipt(value, expected))
      throw new ForgeFailure({
        code: "INPUT_CONFLICT",
        message: "Check receipt integrity failed",
        retry: "never",
      });
    return value;
  }
  return {
    list(config: CheckConfig) {
      return Object.keys(config.commands);
    },
    show,
    async run(
      input: RunInput,
      config: CheckConfig,
      scope?: CheckInvocationScope,
    ): Promise<CheckReceipt> {
      function active(): void {
        if (scope?.signal.aborted)
          throw new ForgeFailure({
            code: "INVOCATION_CANCELLED",
            message: "Check invocation was cancelled",
            retry: "reconcile_first",
          });
        if (scope && services.clock.now() >= scope.deadline)
          throw new ForgeFailure({
            code: "INVOCATION_TIMEOUT",
            message: "Check invocation deadline exceeded",
            retry: "reconcile_first",
          });
      }
      if (scope && !Number.isSafeInteger(scope.deadline))
        invalid("Invocation deadline must be an integer timestamp");
      active();
      if (
        !Number.isSafeInteger(config.timeoutMs) ||
        config.timeoutMs < 1 ||
        config.timeoutMs > 2_147_483_647
      )
        invalid("timeoutMs must be a positive timer budget");
      if (
        !Number.isSafeInteger(config.maxOutputBytes) ||
        config.maxOutputBytes < 1 ||
        config.maxOutputBytes > 262_144
      )
        invalid("maxOutputBytes must be between 1 and 262144");
      const frozenConfig = structuredClone(config);
      const frozenInput = structuredClone(input);
      const env = Object.freeze({ ...services.environment });
      const before = structuredClone(await services.snapshot());
      active();
      const names = [
        ...new Set(frozenInput.checks ?? Object.keys(frozenConfig.commands)),
      ];
      if (
        names.length > 256 ||
        names.some((name) => !name || name.length > 200)
      )
        invalid("Select at most 256 named checks");
      const declarations = names.map((name) => {
        const command = Object.hasOwn(frozenConfig.commands, name)
          ? frozenConfig.commands[name]
          : undefined;
        const argv =
          typeof command === "string"
            ? commandArguments(command)
            : [...(command?.argv ?? [])];
        if (
          command !== undefined &&
          (!argv[0] ||
            argv.some((arg) => typeof arg !== "string" || arg.includes("\0")))
        )
          invalid(
            "Declared argument arrays need an executable and contain no NUL bytes",
          );
        const executable = argv[0]
          ? services.process.resolve(argv[0], env)
          : undefined;
        return {
          name,
          argv,
          executable,
          report:
            typeof command === "object"
              ? (command.report ?? "auto")
              : ("auto" as const),
        };
      });
      const inputsDigest = hash({
        snapshot: before,
        root: services.root,
        environmentDigest: hash(env),
        config: frozenConfig,
        trigger: frozenInput.trigger ?? null,
        invocationDeadline: scope?.deadline ?? null,
        declarations: declarations.map(
          ({ name, argv, executable, report }) => ({
            name,
            argv,
            executable:
              executable?.kind === "resolved" ? executable.path : null,
            report,
          }),
        ),
      });
      const runs: CheckRun[] = [];
      for (const declaration of declarations) {
        active();
        const { name, argv, executable, report } = declaration;
        if (runs.some((run) => run.status !== "PASS")) {
          runs.push(blank(name, argv, "An earlier check did not pass"));
          continue;
        }
        if (!executable) {
          runs.push(blank(name, argv, "No command declared"));
          continue;
        }
        if (executable.kind === "unavailable") {
          runs.push(
            blank(
              name,
              argv,
              `${executable.reason}. ${executable.remedy}`,
              "INCOMPLETE",
            ),
          );
          continue;
        }
        try {
          // The signal is supplied by the approved async ABI; the process port
          // gains this option in its owning change, without a second controller.
          const options: SpawnOptions & { readonly signal?: AbortSignal } = {
            cwd: services.root,
            env: { ...env },
            timeoutMs: scope
              ? Math.min(
                  frozenConfig.timeoutMs,
                  scope.deadline - services.clock.now(),
                )
              : frozenConfig.timeoutMs,
            maxOutputBytes: frozenConfig.maxOutputBytes,
            ...(scope ? { signal: scope.signal } : {}),
          };
          const result = await services.process.run(
            executable,
            argv.slice(1),
            options,
          );
          active();
          const parsed = services.output.parse(
            result.stdout,
            result.stderr,
            report,
          );
          const status: CheckStatus =
            result.timedOut ||
            result.truncated ||
            result.signal !== null ||
            result.exitCode === null ||
            parsed.kind === "malformed"
              ? "INCOMPLETE"
              : parsed.testCount === 0 ||
                  (parsed.failed ?? 0) > 0 ||
                  result.exitCode !== 0
                ? "FAIL"
                : "PASS";
          runs.push({
            name,
            argv,
            executable: executable.path,
            ...result,
            status,
            testCount: parsed.testCount,
            reason: result.timedOut
              ? "Command exceeded its time budget; retained output follows"
              : result.truncated
                ? "Output exceeded its byte budget"
                : parsed.detail,
          });
        } catch {
          active();
          runs.push({
            ...blank(
              name,
              argv,
              "Command could not be completed; inspect the executable and project configuration",
              "INCOMPLETE",
            ),
            executable: executable.path,
          });
        }
      }
      active();
      const after = await services.snapshot();
      active();
      const changed = hash(before) !== hash(after);
      const status = changed ? "INCOMPLETE" : aggregate(runs);
      const body = {
        version: 1 as const,
        id: randomUUID(),
        status,
        subject: before.head,
        checkedAt: new Date(services.clock.now()).toISOString(),
        checked: runs.map(({ name, status }) => ({ name, status })),
        reason: changed
          ? "Project inputs changed while checks ran"
          : runs.length
            ? "Results of declared commands"
            : "No commands declared",
        inputsDigest,
        runs,
      };
      const receipt: CheckReceipt = { ...body, digest: hash(body) };
      services.state.put(`runs/${receipt.id}`, receipt, { expectRevision: 0 });
      const stored = show(receipt.id);
      if (!stored || stored.digest !== receipt.digest)
        throw new Error("Check receipt readback failed");
      return stored;
    },
  };
}
