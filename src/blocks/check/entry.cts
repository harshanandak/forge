import type { CryptoService, CatalogServices } from "./services.ts";
declare const fail: (code: string, message: string) => never;
function failure(code: string, message: string): never {
  if (typeof fail === "function") return fail(code, message);
  throw Object.assign(new Error(`${code}: ${message}`), { code });
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

const HASH_LIMIT = 1_048_576;
// The longest supported HEAD is 64 hex bytes followed by up to two newline bytes.
const SNAPSHOT_HEAD_OUTPUT_BYTES = 66;
function utf8Bytes(text: string): number {
  let size = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    size += code <= 127 ? 1 : code <= 2047 ? 2 : code <= 65535 ? 3 : 4;
  }
  return size;
}
function digest(value: unknown, crypto: CryptoService): string {
  const text = canonical(value),
    bytes = utf8Bytes(text);
  if (bytes <= HASH_LIMIT) return `sha256:${crypto.sha256(text)}`;
  // Ordered, domain-separated chunk commitments. Never split a surrogate pair.
  const domain = "forge/check/chunked-sha256/v1";
  let chain = crypto.sha256(domain),
    index = 0;
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + Math.floor(HASH_LIMIT / 3));
    if (
      end < text.length &&
      /[\uD800-\uDBFF]/.test(text[end - 1]!) &&
      /[\uDC00-\uDFFF]/.test(text[end]!)
    )
      end--;
    chain = crypto.sha256(
      `${chain}:${index++}:${crypto.sha256(text.slice(start, end))}`,
    );
    start = end;
  }
  return `sha256:${crypto.sha256(`${domain}:${text.length}:${bytes}:${index}:${chain}`)}`;
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
        "name,argv,executable,status,testCount,exitCode,signal,timedOut,truncated,stdout,stderr,stdoutEvidence,stderrEvidence,durationMs,reason",
      ) ||
      typeof run.name !== "string" ||
      !run.name ||
      !status(run.status) ||
      !Array.isArray(run.argv) ||
      !run.argv.every((v) => typeof v === "string")
    )
      return false;
    for (const stream of [run.stdoutEvidence, run.stderrEvidence]) {
      if (stream === null) continue;
      if (
        !isRecord(stream) ||
        !keys(stream, "head,tail,encoding,totalBytes,digest,complete") ||
        stream.encoding !== "base64" ||
        typeof stream.head !== "string" ||
        typeof stream.tail !== "string" ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          stream.head,
        ) ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          stream.tail,
        ) ||
        !integer(stream.totalBytes) ||
        stream.totalBytes < 0 ||
        typeof stream.complete !== "boolean" ||
        typeof stream.digest !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(stream.digest)
      )
        return false;
    }
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
        run.stdoutEvidence === null ||
        run.stderrEvidence === null ||
        !(run.stdoutEvidence as { complete: boolean }).complete ||
        !(run.stderrEvidence as { complete: boolean }).complete ||
        run.timedOut ||
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
    stdoutEvidence: null,
    stderrEvidence: null,
    durationMs: 0,
    reason,
  };
}

const INCOMPLETE_REASON =
  "Command could not be completed; inspect the executable and project configuration";
function declarationsFor(config: CheckConfig) {
  return Object.entries(config.commands).map(([name, command]) => ({
    name,
    argv:
      typeof command === "string"
        ? commandArguments(command)
        : [...command.argv],
  }));
}
function metadataSize(
  config: CheckConfig,
  subject = "",
  paths?: ReadonlyMap<string, string>,
): number {
  const stream = {
    head: "",
    tail: "",
    encoding: "base64",
    totalBytes: Number.MAX_SAFE_INTEGER,
    digest: "sha256:" + "a".repeat(64),
    complete: false,
  };
  const runs = declarationsFor(config).map(({ name, argv }) => ({
    ...blank(name, argv, INCOMPLETE_REASON, "NOT_EXECUTED"),
    executable: paths?.get(name) ?? argv[0] ?? null,
    testCount: Number.MAX_SAFE_INTEGER,
    exitCode: -Number.MAX_SAFE_INTEGER,
    signal: "\0".repeat(64),
    durationMs: Number.MAX_VALUE,
    stdoutEvidence: stream,
    stderrEvidence: stream,
  }));
  return utf8Bytes(
    canonical({
      version: 1,
      id: "a".repeat(36),
      subject,
      status: "NOT_EXECUTED",
      checkedAt: "0".repeat(24),
      checked: runs.map(({ name, status }) => ({ name, status })),
      reason: "Project inputs changed while checks ran",
      inputsDigest: "sha256:" + "a".repeat(64),
      digest: "sha256:" + "a".repeat(64),
      runs,
    }),
  );
}
/** Pure preflight: no clock, snapshot, environment selection or process calls. */
function validateBudgets(config: CheckConfig): {
  totalBytes: number;
  declarationBytes: number;
} {
  const invalid = (message: string): never => failure("INPUT_INVALID", message);
  for (const [name, value, maximum] of [
    ["maxOutputBytes", config.maxOutputBytes, 262144],
    ["outputHeadBytes", config.outputHeadBytes, 262144],
    ["outputTailBytes", config.outputTailBytes, 262144],
    ["maxMetadataBytes", config.maxMetadataBytes, HASH_LIMIT],
    ["maxReceiptBytes", config.maxReceiptBytes, HASH_LIMIT],
  ] as const) {
    const minimum =
      name === "outputHeadBytes" || name === "outputTailBytes" ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
      invalid(
        `${name} must be an integer in ${minimum}..${maximum}; maximum ${maximum}`,
      );
  }
  const retained = config.outputHeadBytes + config.outputTailBytes;
  if (retained > config.maxOutputBytes)
    invalid(
      `outputHeadBytes + outputTailBytes (${retained}) conflicts with maxOutputBytes (${config.maxOutputBytes}); maximum retained bytes per stream is ${config.maxOutputBytes}`,
    );
  const count = Object.keys(config.commands).length;
  if (count > 256) invalid("commands exceeds its maximum of 256");
  const declarationBytes = utf8Bytes(canonical(config.commands));
  const metadata = metadataSize(config);
  const maximumMetadata = Math.max(
    0,
    config.maxReceiptBytes - count * 2 * retained * 10,
  );
  if (metadata > config.maxMetadataBytes)
    invalid(
      `maxMetadataBytes (${config.maxMetadataBytes}) cannot fit declarations (${declarationBytes} bytes) and receipt metadata; needs at least ${metadata}; maximum metadata reservation that fits maxReceiptBytes is ${maximumMetadata}`,
    );
  // JSON text needs at most six bytes per retained raw byte; base64 at most four.
  const totalBytes = config.maxMetadataBytes + count * 2 * retained * 10;
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes > config.maxReceiptBytes
  ) {
    const maximum = count
      ? Math.max(
          0,
          Math.floor(
            (config.maxReceiptBytes - config.maxMetadataBytes) /
              (count * 2 * 10),
          ),
        )
      : 0;
    invalid(
      `commands (${count}) × two streams × outputHeadBytes + outputTailBytes (${retained}), plus maxMetadataBytes (${config.maxMetadataBytes}), conflicts with maxReceiptBytes (${config.maxReceiptBytes}); maximum retained bytes per stream is ${maximum}; crypto ceiling is ${HASH_LIMIT}`,
    );
  }
  return { totalBytes, declarationBytes };
}
/** The config as one run sees it: only the selected checks count toward its budgets. */
function selectedConfig(
  config: CheckConfig,
  checks: readonly string[] | undefined,
): { names: string[]; config: CheckConfig } {
  const names = [...new Set(checks ?? Object.keys(config.commands))];
  if (names.length > 256 || names.some((name) => !name || name.length > 200))
    failure("INPUT_INVALID", "Select at most 256 named checks");
  return {
    names,
    config: {
      ...config,
      commands: Object.fromEntries(
        names.map((name) => [
          name,
          Object.hasOwn(config.commands, name)
            ? config.commands[name]!
            : { argv: [] },
        ]),
      ),
    },
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
      const frozenConfig = structuredClone(config);
      const frozenInput = structuredClone(input);
      const env = Object.freeze({ ...services.environment });
      const { names, config: budgetConfig } = selectedConfig(
        frozenConfig,
        frozenInput.checks,
      );
      validateBudgets(budgetConfig);
      const before = structuredClone(await services.snapshot());
      active();
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
      const paths = new Map(
        declarations
          .filter((d) => d.executable?.kind === "resolved")
          .map((d) => [
            d.name,
            d.executable!.kind === "resolved" ? d.executable!.path : "",
          ]),
      );
      const requiredMetadata = metadataSize(budgetConfig, before.head, paths);
      if (requiredMetadata > frozenConfig.maxMetadataBytes)
        invalid(
          `maxMetadataBytes (${frozenConfig.maxMetadataBytes}) cannot fit resolved declaration metadata; needs at least ${requiredMetadata}; maximum metadata reservation that fits maxReceiptBytes is ${Math.max(0, frozenConfig.maxReceiptBytes - names.length * 2 * (frozenConfig.outputHeadBytes + frozenConfig.outputTailBytes) * 10)}`,
        );
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
              "Executable is unavailable; inspect the declared command and environment",
              "INCOMPLETE",
            ),
          );
          continue;
        }
        try {
          // The verdict comes from every output byte; retained head and tail are display only.
          const recognizer = services.output.recognize(report);
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
            capture: {
              headBytes: frozenConfig.outputHeadBytes,
              tailBytes: frozenConfig.outputTailBytes,
            },
            observer: recognizer,
            ...(scope ? { signal: scope.signal } : {}),
          };
          const result = await services.process.run(
            executable,
            argv.slice(1),
            options,
          );
          active();
          if (!result.outputEvidence)
            throw new Error(
              "Process service did not supply streaming evidence",
            );
          const seen = recognizer.observed();
          const incompleteOutput =
            !result.outputEvidence.stdout.complete ||
            !result.outputEvidence.stderr.complete ||
            seen.stdout !== result.outputEvidence.stdout.totalBytes ||
            seen.stderr !== result.outputEvidence.stderr.totalBytes;
          const parsed = incompleteOutput
            ? { kind: "unknown" as const, testCount: null, failed: null }
            : recognizer.report();
          const status: CheckStatus =
            result.timedOut ||
            incompleteOutput ||
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
            stdoutEvidence: result.outputEvidence.stdout,
            stderrEvidence: result.outputEvidence.stderr,
            timedOut: result.timedOut,
            truncated: result.truncated,
            durationMs: result.durationMs,
            status,
            testCount: parsed.testCount,
            reason: result.timedOut
              ? "Command exceeded its time budget; retained output follows"
              : incompleteOutput
                ? "Output was not observed in full"
                : `Output report: ${parsed.kind}${result.truncated ? "; retained output is truncated for display" : ""}`,
          });
        } catch {
          active();
          runs.push({
            ...blank(name, argv, INCOMPLETE_REASON, "INCOMPLETE"),
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
      if (utf8Bytes(canonical(receipt)) > frozenConfig.maxReceiptBytes)
        failure(
          "LIMIT_EXCEEDED",
          "Process evidence exceeded its validated receipt budget",
        );
      services.state.put(`runs/${receipt.id}`, receipt, { expectRevision: 0 });
      const stored = show(receipt.id);
      if (!stored || stored.digest !== receipt.digest)
        throw new Error("Check receipt readback failed");
      return stored;
    },
  };
}

/** Split a declared executable invocation, never evaluate shell syntax. */
function commandArguments(text: string): string[] {
  const invalid = (message: string): never => failure("INPUT_INVALID", message);
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
    validateBudgets(selectedConfig(args.config, args.input.checks).config);
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
          maxOutputBytes: SNAPSHOT_HEAD_OUTPUT_BYTES,
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
  validateBudgets,
};
