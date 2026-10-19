import type { CryptoService, CatalogServices } from "./services.ts";
declare const fail: (code: string, message: string) => never;
function failure(code: string, message: string): never {
  if (typeof fail === "function") return fail(code, message);
  throw new Error(`${code}: ${message}`);
}
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
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

/** Sorted records make bindings independent of object insertion order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Receipt input must be JSON");
  return encoded;
}

function digest(value: unknown, crypto: CryptoService): string {
  return `sha256:${crypto.sha256(canonical(value))}`;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string): boolean {
  return (
    Object.keys(value).sort().join(",") === expected.split(",").sort().join(",")
  );
}
function status(value: unknown): value is CheckStatus {
  return (
    typeof value === "string" &&
    ["PASS", "FAIL", "INCOMPLETE", "NOT_EXECUTED"].includes(value)
  );
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
function verify(
  value: unknown,
  expected: string,
  crypto: CryptoService,
): value is CheckReceipt {
  if (
    !isRecord(value) ||
    !keys(
      value,
      "version,id,status,subject,checkedAt,checked,reason,inputsDigest,digest,runs",
    ) ||
    value.version !== 1 ||
    typeof value.id !== "string" ||
    !/^[a-f0-9-]{36}$/.test(value.id) ||
    !status(value.status)
  )
    return false;
  if (
    ![value.subject, value.checkedAt, value.reason].every(
      (v) => typeof v === "string" && v.length > 0,
    ) ||
    ![value.inputsDigest, value.digest].every(
      (v) => typeof v === "string" && /^sha256:[a-f0-9]{64}$/.test(v),
    )
  )
    return false;
  if (
    !Array.isArray(value.checked) ||
    !Array.isArray(value.runs) ||
    value.runs.length > 256 ||
    value.checked.length !== value.runs.length
  )
    return false;
  for (const [index, run] of value.runs.entries()) {
    if (
      !isRecord(run) ||
      !keys(
        run,
        "name,argv,executable,status,testCount,exitCode,signal,timedOut,truncated,stdout,stderr,durationMs,reason",
      ) ||
      typeof run.name !== "string" ||
      !run.name ||
      !status(run.status) ||
      !Array.isArray(run.argv) ||
      !run.argv.every((v) => typeof v === "string")
    )
      return false;
    if (
      ![run.executable, run.signal].every(
        (v) => v === null || typeof v === "string",
      ) ||
      !(
        run.testCount === null ||
        (integer(run.testCount) && run.testCount >= 0)
      ) ||
      !(run.exitCode === null || integer(run.exitCode)) ||
      typeof run.timedOut !== "boolean" ||
      typeof run.truncated !== "boolean" ||
      ![run.stdout, run.stderr, run.reason].every(
        (v) => typeof v === "string",
      ) ||
      typeof run.durationMs !== "number" ||
      !Number.isFinite(run.durationMs) ||
      run.durationMs < 0
    )
      return false;
    const checked: unknown = value.checked[index];
    if (
      !isRecord(checked) ||
      !keys(checked, "name,status") ||
      checked.name !== run.name ||
      checked.status !== run.status
    )
      return false;
    if (
      run.status === "PASS" &&
      (run.exitCode !== 0 ||
        run.timedOut ||
        run.truncated ||
        run.signal !== null ||
        run.testCount === 0)
    )
      return false;
  }
  const receipt = value as unknown as CheckReceipt;
  if (
    receipt.status === "PASS" &&
    (receipt.runs.length === 0 ||
      receipt.runs.some((run) => run.status !== "PASS"))
  )
    return false;
  const { digest: stored, ...body } = value;
  return value.inputsDigest === expected && stored === digest(body, crypto);
}

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
interface CheckBlock {
  list(config: CheckConfig): string[];
  show(id: string): CheckReceipt | undefined;
  run(
    input: RunInput,
    config: CheckConfig,
    scope?: CheckInvocationScope,
  ): Promise<CheckReceipt>;
}
function createCheck(
  services: CheckServices & { readonly crypto: CryptoService },
): CheckBlock {
  const hash = (value: unknown) => digest(value, services.crypto);
  const verifyReceipt = (
    value: unknown,
    expected: string,
  ): value is CheckReceipt => verify(value, expected, services.crypto);
  const randomUUID = () => services.crypto.randomUUID();
  const structuredClone = copy;
  const invalid = (message: string): never => failure("INPUT_INVALID", message);
  function show(id: string): CheckReceipt | undefined {
    const record = services.state.get(`runs/${id}`);
    if (!record) return undefined;
    const value = record.value;
    const expected =
      typeof value === "object" && value !== null && "inputsDigest" in value
        ? value.inputsDigest
        : undefined;
    if (typeof expected !== "string" || !verifyReceipt(value, expected))
      failure("INPUT_CONFLICT", "Check receipt integrity failed");
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
          failure("INVOCATION_CANCELLED", "Check invocation was cancelled");
        if (scope && services.clock.now() >= scope.deadline)
          failure("INVOCATION_TIMEOUT", "Check invocation deadline exceeded");
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
            ? commandArguments(command, invalid)
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
              ? (command.report ?? frozenConfig.report)
              : frozenConfig.report,
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
        if (
          frozenConfig.stopOnFailure &&
          runs.some((run) => run.status !== "PASS")
        ) {
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
          const options: SpawnOptions = {
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
            exitCode: result.exitCode,
            signal: result.signal,
            stdout: result.stdout,
            stderr: result.stderr,
            timedOut: result.timedOut,
            truncated: result.truncated,
            durationMs: result.durationMs,
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

/** Split a declared executable invocation, never evaluate shell syntax. */
function commandArguments(
  text: string,
  invalid: (message: string) => never = (message) => {
    throw new Error(message);
  },
): string[] {
  const args: string[] = [];
  let value = "",
    quote = "",
    started = false;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = "";
      else value += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        args.push(value);
        value = "";
        started = false;
      }
    } else {
      if (/[|&;<>`$\r\n]/.test(char))
        invalid(
          "Shell syntax needs a project-owned script; declare an argument array instead.",
        );
      value += char;
      started = true;
    }
  }
  if (quote) invalid("Declared command contains an unclosed quote.");
  if (started) args.push(value);
  if (!args[0]) invalid("Declared command has no executable.");
  return args;
}

type Call<T> = import("../../contract/author.ts").HandlerCall<T> & {
  readonly config: CheckConfig;
  readonly services: CatalogServices;
};
const operations = {
  async "check.run"(args: Call<RunInput>) {
    const services = args.services;
    const config = args.config;
    const engine = createCheck({
      process: services.process,
      state: services.state,
      output: services.output,
      crypto: services.crypto,
      root: services.files.root,
      environment: services.environment.select(config.environment),
      clock: { now: () => Date.now() },
      snapshot: () =>
        services.files.snapshot({
          paths: config.inputs,
          maxBytes: config.maxInputBytes,
          timeoutMs: config.timeoutMs,
          maxOutputBytes: config.maxOutputBytes,
        }),
    });
    return await engine.run(args.input, config, {
      signal: args.signal,
      deadline: args.deadline,
    });
  },
  "check.list"(args: Call<Readonly<Record<string, never>>>) {
    return { commands: Object.keys(args.config.commands) };
  },
  "check.show"(args: Call<{ readonly id: string }>) {
    const record = args.services.state.get(`runs/${args.input.id}`);
    if (!record) return null;
    const value = record.value;
    if (
      !isRecord(value) ||
      typeof value.inputsDigest !== "string" ||
      !verify(value, value.inputsDigest, args.services.crypto)
    )
      failure("INPUT_CONFLICT", "Check receipt integrity failed");
    return value;
  },
};
module.exports = {
  ...operations,
  createCheck,
  commandArguments,
  canonical,
  digest,
  verify,
};
